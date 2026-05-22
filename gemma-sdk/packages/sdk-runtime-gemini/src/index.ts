import type {
  AdapterStreamEvent,
  CapabilityRecord,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelRecord,
  ModelToolCall,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeInspectionResult,
  SessionMessage,
  TokenUsage,
  ToolDefinition,
} from "@gemma-sdk/core";
import {
  contentPartsToText,
  makeId,
  parseSse,
  parseToolCallInput,
  resolveBinaryAssetForRequest,
  resolveImageAssetForRequest,
} from "@gemma-sdk/core";

export interface GeminiApiAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type GeminiRole = "user" | "model";

interface GeminiModelListResponse {
  models?: GeminiModelResponse[];
  nextPageToken?: string;
}

interface GeminiModelResponse {
  name?: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
}

interface GeminiContent {
  role?: GeminiRole;
  parts?: GeminiPart[];
}

type GeminiPartBase =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name?: string; args?: unknown } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiPart = GeminiPartBase & {
  thought?: boolean;
  thoughtSignature?: string;
};

const DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_RUNTIME_ID = "gemini-api";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function modelNameForUrl(modelId: string): string {
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
}

function displayModelId(modelName: string): string {
  return modelName.replace(/^models\//, "");
}

function withApiKey(url: string, apiKey: string | undefined, params: Record<string, string> = {}): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  if (apiKey?.trim()) {
    parsed.searchParams.set("key", apiKey.trim());
  }
  return parsed.toString();
}

function createIdentity(baseUrl: string): RuntimeIdentity {
  return {
    id: GEMINI_RUNTIME_ID,
    family: "gemini",
    kind: "hosted",
    displayName: "Gemini API",
    endpoint: normalizeBaseUrl(baseUrl),
  };
}

function createRuntimeCapabilities(apiKey: string | undefined): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: apiKey ? "supported" : "conditional", source: "runtime-docs" },
    { id: "inference.streaming", scope: "request", status: apiKey ? "supported" : "conditional", source: "runtime-docs" },
    { id: "runtime.list-available-models", scope: "runtime", status: apiKey ? "supported" : "conditional", source: "runtime-docs" },
    { id: "runtime.list-loaded-models", scope: "runtime", status: "unsupported", source: "runtime-docs", notes: ["Hosted Gemini models do not expose local residency."] },
    { id: "request.tool-calling", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.reasoning-control", scope: "request", status: "conditional", source: "runtime-docs" },
  ];
}

function createModelCapabilities(model: GeminiModelResponse): CapabilityRecord[] {
  const methods = new Set((model.supportedGenerationMethods ?? []).map((method) => method.toLowerCase()));
  const capabilities: CapabilityRecord[] = [];
  const modelName = model.name ?? "";
  if (methods.has("generatecontent")) {
    capabilities.push(
      { id: "inference.chat", scope: "model", status: "supported", source: "runtime-probe" },
      { id: "inference.streaming", scope: "model", status: "supported", source: "runtime-probe" },
      { id: "request.tool-calling", scope: "model", status: "supported", source: "runtime-docs" },
    );
  }
  if (methods.has("embedcontent")) {
    capabilities.push({ id: "model.embedding", scope: "model", status: "supported", source: "runtime-probe" });
  }
  if (model.thinking === true || /(?:thinking|pro|3\.5|3\.1)/i.test(modelName)) {
    capabilities.push({ id: "request.reasoning-control", scope: "model", status: "conditional", source: "runtime-probe" });
  }
  if (methods.has("generatecontent") && /(?:^|\/)gemini-/i.test(modelName)) {
    capabilities.push(
      { id: "model.vision", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.input.image", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.audio", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.input.audio", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.input.video", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.input.pdf", scope: "model", status: "supported", source: "runtime-docs" },
      { id: "model.multimodal", scope: "model", status: "supported", source: "runtime-docs" },
    );
  }
  return capabilities;
}

function modelKind(model: GeminiModelResponse): ModelRecord["kind"] {
  const methods = new Set((model.supportedGenerationMethods ?? []).map((method) => method.toLowerCase()));
  if (methods.has("embedcontent") && !methods.has("generatecontent")) {
    return "embedding";
  }
  return methods.has("generatecontent") ? "llm" : "unknown";
}

function normalizeModel(model: GeminiModelResponse): ModelRecord | undefined {
  if (!model.name) {
    return undefined;
  }
  return {
    id: displayModelId(model.name),
    runtimeId: GEMINI_RUNTIME_ID,
    kind: modelKind(model),
    availability: "visible",
    metadata: {
      provider: "gemini",
      baseModelId: model.baseModelId,
      version: model.version,
      displayName: model.displayName,
      name: model.displayName,
      description: model.description,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
      maxContextLength: model.inputTokenLimit,
      maxTokens: model.outputTokenLimit,
      supportedGenerationMethods: model.supportedGenerationMethods,
      thinking: model.thinking,
    },
    capabilities: createModelCapabilities(model),
    raw: model,
  };
}

async function listGeminiModels(input: {
  baseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ModelRecord[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const models: ModelRecord[] = [];
  let pageToken: string | undefined;
  do {
    const url = withApiKey(`${normalizeBaseUrl(input.baseUrl)}/models`, input.apiKey, pageToken ? { pageToken } : {});
    const response = await requestJson<GeminiModelListResponse>(fetchImpl, url, { signal: input.signal }, "Gemini model list");
    models.push(
      ...(response.models ?? [])
        .map(normalizeModel)
        .filter((model): model is ModelRecord => Boolean(model)),
    );
    pageToken = response.nextPageToken;
  } while (pageToken);
  return models;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

function generationConfig(request: ChatRequest): Record<string, unknown> | undefined {
  const settings = request.settings ?? {};
  const config: Record<string, unknown> = {};
  if (typeof settings.temperature === "number") config.temperature = settings.temperature;
  if (typeof settings.topP === "number") config.topP = settings.topP;
  if (typeof settings.topK === "number") config.topK = settings.topK;
  if (typeof settings.maxTokens === "number") config.maxOutputTokens = settings.maxTokens;
  if (request.responseFormat) {
    config.responseMimeType = "application/json";
    config.responseSchema = toGeminiSchema(request.responseFormat.schema);
  }
  const geminiOptions = settings.geminiOptions;
  if (geminiOptions && typeof geminiOptions === "object" && !Array.isArray(geminiOptions)) {
    Object.assign(config, geminiOptions);
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function toGeminiSchema(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeGeminiSchema(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { type: "object" };
}

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sanitizeGeminiSchema)
      .filter((entry) => entry !== undefined);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (
      key === "additionalProperties"
      || key === "$schema"
      || key === "$id"
      || key === "$defs"
      || key === "definitions"
      || key === "patternProperties"
      || key === "unevaluatedProperties"
      || key === "dependentRequired"
      || key === "dependentSchemas"
    ) {
      continue;
    }

    if (entry !== undefined) {
      target[key] = sanitizeGeminiSchema(entry);
    }
  }
  return target;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cloneGeminiHistoryPart(part: GeminiPart): GeminiPart | undefined {
  const thoughtSignature = typeof part.thoughtSignature === "string"
    ? part.thoughtSignature
    : undefined;
  const thought = typeof part.thought === "boolean" ? part.thought : undefined;
  const extras = {
    ...(thoughtSignature ? { thoughtSignature } : {}),
    ...(typeof thought === "boolean" ? { thought } : {}),
  };

  if ("text" in part && typeof part.text === "string") {
    return { text: part.text, ...extras };
  }

  if ("functionCall" in part) {
    return {
      functionCall: {
        name: part.functionCall.name,
        args: part.functionCall.args,
      },
      ...extras,
    };
  }

  return undefined;
}

function coerceGeminiHistoryPart(value: unknown): GeminiPart | undefined {
  const record = objectRecord(value);
  if (!record) {
    return undefined;
  }

  const thoughtSignature = typeof record.thoughtSignature === "string"
    ? record.thoughtSignature
    : undefined;
  const thought = typeof record.thought === "boolean" ? record.thought : undefined;
  const extras = {
    ...(thoughtSignature ? { thoughtSignature } : {}),
    ...(typeof thought === "boolean" ? { thought } : {}),
  };

  if (typeof record.text === "string") {
    return { text: record.text, ...extras };
  }

  const functionCall = objectRecord(record.functionCall);
  if (functionCall) {
    const name = typeof functionCall.name === "string"
      ? functionCall.name
      : undefined;
    return {
      functionCall: {
        name,
        args: functionCall.args,
      },
      ...extras,
    };
  }

  return undefined;
}

function geminiHistoryPartsFromMetadata(metadata: Record<string, unknown> | undefined): GeminiPart[] | undefined {
  const geminiApi = objectRecord(metadata?.geminiApi);
  const rawParts = geminiApi?.historyParts;
  if (!Array.isArray(rawParts)) {
    return undefined;
  }

  const parts = rawParts
    .map(coerceGeminiHistoryPart)
    .filter((part): part is GeminiPart => Boolean(part));
  return parts.length > 0 ? parts : undefined;
}

function firstSystemInstruction(messages: SessionMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; rest: SessionMessage[] } {
  const systemParts: string[] = [];
  const rest: SessionMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = contentPartsToText(message.content).trim();
      if (text) systemParts.push(text);
    } else {
      rest.push(message);
    }
  }
  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts.map((text) => ({ text })) } : undefined,
    rest,
  };
}

async function contentPartToGeminiPart(part: ContentPart): Promise<GeminiPart> {
  if (part.type === "text") {
    return { text: part.text };
  }
  const resolved = part.type === "image_url"
    ? await resolveImageAssetForRequest(part.url)
    : await resolveBinaryAssetForRequest(part.url);
  if (resolved) {
    return {
      inlineData: {
        mimeType: part.mediaType ?? resolved.mimeType,
        data: resolved.base64Data,
      },
    };
  }
  return { text: `[${part.type}:${part.url}]` };
}

async function messageToGeminiContent(message: SessionMessage): Promise<GeminiContent> {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: message.name ?? "tool",
          response: {
            content: contentPartsToText(message.content),
            toolCallId: message.toolCallId,
          },
        },
      }],
    };
  }
  if (message.role === "assistant") {
    const historyParts = geminiHistoryPartsFromMetadata(message.metadata);
    if (historyParts) {
      return {
        role: "model",
        parts: historyParts,
      };
    }
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "model",
      parts: message.toolCalls.map((toolCall) => ({
        functionCall: {
          name: toolCall.name,
          args: toolCall.input,
        },
      })),
    };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: await Promise.all(message.content.map(contentPartToGeminiPart)),
  };
}

function toolsToGeminiTools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.inputSchema),
    })),
  }];
}

async function buildGenerateBody(request: ChatRequest): Promise<Record<string, unknown>> {
  const { systemInstruction, rest } = firstSystemInstruction(request.messages);
  const tools = toolsToGeminiTools(request.tools);
  const config = generationConfig(request);
  return {
    contents: await Promise.all(rest.map(messageToGeminiContent)),
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    ...(config ? { generationConfig: config } : {}),
  };
}

function parseUsage(raw: GeminiGenerateResponse["usageMetadata"]): TokenUsage | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    inputTokens: raw.promptTokenCount,
    outputTokens: raw.candidatesTokenCount,
    totalTokens: raw.totalTokenCount,
    reasoningTokens: raw.thoughtsTokenCount,
    cacheReadTokens: raw.cachedContentTokenCount,
    raw,
  };
}

function parseResponse(response: GeminiGenerateResponse): ChatResponse {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const historyParts = parts
    .map(cloneGeminiHistoryPart)
    .filter((part): part is GeminiPart => Boolean(part));
  const textParts: Array<Extract<ContentPart, { type: "text" }>> = [];
  const reasoningParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const part of parts) {
    if ("text" in part && typeof part.text === "string") {
      if (part.thought === true) {
        reasoningParts.push(part.text);
      } else {
        textParts.push({ type: "text", text: part.text });
      }
    }
    if ("functionCall" in part) {
      toolCalls.push({
        id: makeId("gemini_tool_call"),
        name: part.functionCall.name ?? "unknown_tool",
        input: typeof part.functionCall.args === "string"
          ? parseToolCallInput(part.functionCall.args)
          : part.functionCall.args ?? {},
      });
    }
  }
  const text = textParts.map((part) => part.text).join("");
  const reasoning = reasoningParts.join("");
  return {
    text,
    content: textParts,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: parseUsage(response.usageMetadata),
    finishReason: candidate?.finishReason,
    raw: response,
    metadata: {
      modelVersion: response.modelVersion,
      geminiApi: historyParts.length > 0
        ? { historyParts }
        : undefined,
    },
  };
}

function decorateGeminiError(error: unknown): Error {
  if (error instanceof Error) {
    if (/401|403/.test(error.message)) {
      return new Error(`Gemini API request failed. Check the configured API key and model. ${error.message}`);
    }
    if (/400/.test(error.message)) {
      const requestHint = /thought_?signature|thoughtSignature/i.test(error.message)
        ? "Gemini API rejected the tool-call history because a thought signature was missing."
        : /additionalProperties/i.test(error.message)
          ? "Gemini API rejected the tool schema payload."
          : "Gemini API rejected the request payload.";
      return new Error(`${requestHint} ${error.message}`);
    }
    return error;
  }
  return new Error(String(error));
}

export function createGeminiApiAdapter(options: GeminiApiAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GEMINI_API_BASE_URL);
  const apiKey = options.apiKey?.trim();
  const identity = createIdentity(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function inspect(): Promise<RuntimeInspectionResult> {
    if (!apiKey) {
      return {
        runtime: identity,
        installed: true,
        reachable: false,
        healthy: false,
        capabilities: createRuntimeCapabilities(apiKey),
        models: [],
        loadedInstances: [],
        warnings: ["No Gemini API key is configured."],
        diagnosis: ["Open Settings > Integrations and paste a Gemini API key from Google AI Studio."],
      };
    }
    try {
      const models = await listGeminiModels({ baseUrl, apiKey, fetchImpl });
      return {
        runtime: identity,
        installed: true,
        reachable: true,
        healthy: true,
        capabilities: createRuntimeCapabilities(apiKey),
        models,
        loadedInstances: [],
        warnings: [],
        diagnosis: [],
      };
    } catch (error) {
      return {
        runtime: identity,
        installed: true,
        reachable: false,
        healthy: false,
        capabilities: createRuntimeCapabilities(apiKey),
        models: [],
        loadedInstances: [],
        warnings: [decorateGeminiError(error).message],
        diagnosis: ["Gemini API model discovery failed. Verify the API key and network access to generativelanguage.googleapis.com."],
        raw: error,
      };
    }
  }

  async function generate(request: ChatRequest): Promise<ChatResponse> {
    if (!apiKey) {
      throw new Error("No Gemini API key is configured.");
    }
    const body = await buildGenerateBody(request);
    request.debug?.({
      stage: "request",
      transport: "gemini-api",
      method: "POST",
      url: `${baseUrl}/${modelNameForUrl(request.model)}:generateContent`,
      payload: body,
    });
    try {
      const response = await requestJson<GeminiGenerateResponse>(
        fetchImpl,
        withApiKey(`${baseUrl}/${modelNameForUrl(request.model)}:generateContent`, apiKey),
        {
          method: "POST",
          signal: request.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        "Gemini API request",
      );
      request.debug?.({
        stage: "response",
        transport: "gemini-api",
        method: "POST",
        url: `${baseUrl}/${modelNameForUrl(request.model)}:generateContent`,
        body: response,
      });
      return parseResponse(response);
    } catch (error) {
      throw decorateGeminiError(error);
    }
  }

  async function* stream(request: ChatRequest): AsyncIterable<AdapterStreamEvent> {
    if (!apiKey) {
      throw new Error("No Gemini API key is configured.");
    }
    const body = await buildGenerateBody(request);
    const url = withApiKey(`${baseUrl}/${modelNameForUrl(request.model)}:streamGenerateContent`, apiKey, { alt: "sse" });
    const debugUrl = `${baseUrl}/${modelNameForUrl(request.model)}:streamGenerateContent?alt=sse`;
    request.debug?.({
      stage: "request",
      transport: "gemini-api",
      method: "POST",
      url: debugUrl,
      payload: body,
    });
    const response = await fetchImpl(url, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => "");
      throw decorateGeminiError(new Error(`Gemini API stream failed with ${response.status}: ${errorBody}`));
    }
    let fullText = "";
    let fullReasoning = "";
    let finalResponse: GeminiGenerateResponse | undefined;
    for await (const message of parseSse(response.body, request.signal)) {
      const parsed = JSON.parse(message.data) as GeminiGenerateResponse;
      finalResponse = parsed;
      const chunk = parseResponse(parsed);
      if (chunk.reasoning) {
        fullReasoning += chunk.reasoning;
        yield { type: "reasoning.delta", delta: chunk.reasoning };
      }
      if (chunk.text) {
        fullText += chunk.text;
        yield { type: "text.delta", delta: chunk.text };
      }
      if (chunk.toolCalls.length > 0) {
        yield {
          type: "response.complete",
          response: {
            ...chunk,
            text: fullText,
            content: fullText ? [{ type: "text", text: fullText }] : [],
            reasoning: fullReasoning || chunk.reasoning,
          },
        };
        return;
      }
    }
    yield {
      type: "response.complete",
      response: {
        ...(finalResponse ? parseResponse(finalResponse) : {
          text: "",
          content: [],
          toolCalls: [],
        }),
        text: fullText,
        content: fullText ? [{ type: "text", text: fullText }] : [],
        reasoning: fullReasoning || (finalResponse ? parseResponse(finalResponse).reasoning : undefined),
      },
    };
  }

  return {
    identity,
    inspect,
    generate,
    stream,
  };
}

export function createGeminiApiModelDiscoveryProvider(options: GeminiApiAdapterOptions = {}) {
  return createGeminiApiAdapter(options);
}
