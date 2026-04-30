import type {
  CapabilityRecord,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResult,
  ModelRecord,
  LoadedModelInstance,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeInspectionResult,
  TokenUsage,
  SessionMessage} from "@gemma-desktop/sdk-core";
import {
  contentPartsToText,
  detectCommandVersion,
  isGemma4ModelId,
  parseToolCallInput,
  resolveImageAssetForRequest,
  withInferredModelFamilyCapabilities,
} from "@gemma-desktop/sdk-core";
import {
  fetchJson,
  generateOpenAICompatibleResponse,
  parseSse,
  postJson,
  streamOpenAICompatibleResponse,
} from "@gemma-desktop/sdk-core";

export interface LmStudioAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
}

const LMSTUDIO_TRANSPORT_CHANNEL_PAIR_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>\s*(?:thought|assistant|analysis|commentary|final)?\s*<channel\|[^>\r\n]*>/gi;
const LMSTUDIO_TRANSPORT_CHANNEL_MARKER_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>|<channel\|[^>\r\n]*>/gi;
const LMSTUDIO_TRANSPORT_THOUGHT_BLOCK_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>\s*(?:thought|analysis)\b[\s\S]*?<channel\|[^>\r\n]*>/gi;
const LMSTUDIO_TRANSPORT_INCOMPLETE_THOUGHT_BLOCK_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>\s*(?:thought|analysis)\b[\s\S]*$/i;
const LMSTUDIO_TRANSPORT_TOOL_CALL_BLOCK_PATTERN =
  /<\|tool_call(?:\|[^>\r\n]*)?>[\s\S]*?<tool_call\|[^>\r\n]*>/gi;
const LMSTUDIO_TRANSPORT_INCOMPLETE_TOOL_CALL_BLOCK_PATTERN =
  /<\|tool_call(?:\|[^>\r\n]*)?>[\s\S]*$/i;
const LMSTUDIO_TRANSPORT_TOOL_CALL_MARKER_PATTERN =
  /<\|tool_call(?:\|[^>\r\n]*)?>|<tool_call\|[^>\r\n]*>/gi;
const LMSTUDIO_XML_THOUGHT_COMPLETE_BLOCK_PATTERN =
  /(^|\r?\n)[ \t]*<thought\b[\s\S]*?<\/thought\s*>(?:[ \t]*\r?\n)?/gi;
const LMSTUDIO_XML_THOUGHT_INCOMPLETE_BLOCK_PATTERN =
  /(^|\r?\n)[ \t]*<thought\b[\s\S]*$/gi;
const LMSTUDIO_XML_THOUGHT_CLOSE_PATTERN =
  /(^|\r?\n)[ \t]*<\/thought\s*>[ \t]*/gi;
const LMSTUDIO_CHANNEL_LABEL_ONLY_PATTERN =
  /^\s*(?:thought|assistant|analysis|commentary|final)\s*$/i;
const LMSTUDIO_LEADING_CHANNEL_LABEL_PATTERN =
  /^\s*(?:thought|assistant|analysis|commentary|final)\s*(?:\r?\n)+/i;

function headersToObject(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

function sanitizeDebugPayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      const mimeBoundary = value.indexOf(";");
      const mimeType = mimeBoundary > 5 ? value.slice(5, mimeBoundary) : "image";
      return `[${mimeType} data url omitted]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDebugPayload(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeDebugPayload(entry),
      ]),
    );
  }

  return value;
}

function createNativeCapabilities(): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "runtime.list-available-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.list-loaded-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.load", scope: "runtime", status: "supported", source: "runtime-docs" },
    { id: "runtime.unload", scope: "runtime", status: "supported", source: "runtime-docs" },
    { id: "runtime.download", scope: "runtime", status: "supported", source: "runtime-docs" },
    { id: "request.context-length", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "request.reasoning-control", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "server-session.stateful-chat", scope: "server-session", status: "supported", source: "runtime-docs" },
    {
      id: "request.tool-calling",
      scope: "request",
      status: "conditional",
      source: "runtime-docs",
      notes: ["Native LM Studio chat exposes its own integration and tool path rather than the SDK's portable tool surface."],
    },
  ];
}

const LMSTUDIO_NATIVE_REQUEST_OPTION_KEYS = new Set([
  "context_length",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repeat_penalty",
  "max_output_tokens",
]);

const LMSTUDIO_OPENAI_OPTION_KEY_MAP: Record<string, string> = {
  temperature: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  repeat_penalty: "repeat_penalty",
  max_output_tokens: "max_tokens",
};

function normalizeFiniteNumberRecord(
  value: unknown,
  allowedKeys?: Set<string>,
): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([key, entry]) =>
    (allowedKeys ? allowedKeys.has(key) : true) && typeof entry === "number" && Number.isFinite(entry)
  );

  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

function nativeModelIdentifiers(raw: Record<string, unknown>): string[] {
  const identifiers = new Set<string>();
  const addIdentifier = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      identifiers.add(value.trim());
    }
  };

  addIdentifier(raw.key);
  addIdentifier(raw.id);
  addIdentifier(raw.selected_variant);

  if (Array.isArray(raw.variants)) {
    for (const variant of raw.variants) {
      addIdentifier(variant);
    }
  }

  if (Array.isArray(raw.loaded_instances)) {
    for (const instance of raw.loaded_instances as Array<Record<string, unknown>>) {
      addIdentifier(instance.id);
    }
  }

  return [...identifiers];
}

function nativeModelMatches(raw: Record<string, unknown>, modelId: string): boolean {
  return nativeModelIdentifiers(raw).includes(modelId);
}

function nativeModelExposesReasoningControl(raw: Record<string, unknown>): boolean {
  const capabilities =
    raw.capabilities && typeof raw.capabilities === "object" && !Array.isArray(raw.capabilities)
      ? raw.capabilities as Record<string, unknown>
      : {};
  const reasoning = capabilities.reasoning;

  if (typeof reasoning === "boolean") {
    return reasoning;
  }

  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return false;
  }

  const reasoningRecord = reasoning as Record<string, unknown>;
  const allowedOptions = Array.isArray(reasoningRecord.allowed_options)
    ? reasoningRecord.allowed_options
    : [];
  return allowedOptions.some((option) => option === "on")
    || reasoningRecord.default === "on";
}

async function modelSupportsLmStudioNativeReasoningControl(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const modelList = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/v1/models`, {
    signal,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  }).catch(() => undefined);
  const models = Array.isArray(modelList?.models) ? (modelList.models as Array<Record<string, unknown>>) : [];
  const matchedModel = models.find((model) => nativeModelMatches(model, modelId));
  return matchedModel ? nativeModelExposesReasoningControl(matchedModel) : false;
}

async function resolveLmStudioReasoningControlValue(
  modelId: string,
  settings: ChatRequest["settings"],
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<"on" | undefined> {
  const wantsReasoning = isGemma4ModelId(modelId) || settings?.reasoningMode === "on";
  if (!wantsReasoning) {
    return undefined;
  }

  return await modelSupportsLmStudioNativeReasoningControl(baseUrl, apiKey, modelId, signal)
    ? "on"
    : undefined;
}

async function resolveLmStudioNativeRequestOptions(
  modelId: string,
  settings: ChatRequest["settings"],
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | undefined> {
  const options = normalizeFiniteNumberRecord(settings?.lmstudioOptions, LMSTUDIO_NATIVE_REQUEST_OPTION_KEYS);
  const reasoning = await resolveLmStudioReasoningControlValue(modelId, settings, baseUrl, apiKey, signal);
  if (!options && !reasoning) {
    return undefined;
  }

  return {
    ...(options ?? {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function resolveLmStudioOpenAICompatibleOptions(
  settings: ChatRequest["settings"],
): Record<string, number> | undefined {
  const source = normalizeFiniteNumberRecord(settings?.lmstudioOptions);
  if (!source) {
    return undefined;
  }

  const entries = Object.entries(source).flatMap(([key, value]) => {
    const mappedKey = LMSTUDIO_OPENAI_OPTION_KEY_MAP[key];
    return mappedKey ? [[mappedKey, value] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

function withLmStudioOpenAICompatibleSettings(request: ChatRequest): ChatRequest {
  const lmstudioOptions = resolveLmStudioOpenAICompatibleOptions(request.settings);
  if (!lmstudioOptions) {
    return request;
  }

  const currentOpenAIOptions =
    request.settings?.openAICompatibleOptions
    && typeof request.settings.openAICompatibleOptions === "object"
    && !Array.isArray(request.settings.openAICompatibleOptions)
      ? request.settings.openAICompatibleOptions as Record<string, unknown>
      : {};

  return {
    ...request,
    settings: {
      ...(request.settings ?? {}),
      openAICompatibleOptions: {
        ...currentOpenAIOptions,
        ...lmstudioOptions,
      },
    },
  };
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function serializeNativeMessage(message: SessionMessage): string {
  const text = contentPartsToText(message.content).trim();
  const role =
    message.role === "tool"
      ? message.name
        ? `tool (${message.name})`
        : "tool"
      : message.role;

  const parts: string[] = [];
  if (text.length > 0) {
    parts.push(`${role}: ${text}`);
  }

  if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    parts.push(
      `assistant_tool_calls: ${message.toolCalls
        .map((toolCall) => `${toolCall.name}(${JSON.stringify(toolCall.input)})`)
        .join(", ")}`,
    );
  }

  return parts.join("\n");
}

type NativeInputItem =
  | { type: "message"; content: string }
  | { type: "image"; data_url: string };

function nativeRoleLabel(message: SessionMessage): string {
  return message.role === "tool"
    ? message.name
      ? `tool (${message.name})`
      : "tool"
    : message.role;
}

async function buildNativeInput(messages: SessionMessage[]): Promise<string | NativeInputItem[]> {
  const includesImages = messages.some((message) => message.content.some((part) => part.type === "image_url"));
  if (!includesImages) {
    return messages
      .map((message) => serializeNativeMessage(message))
      .filter((value) => value.length > 0)
      .join("\n\n");
  }

  const input: NativeInputItem[] = [];

  for (const message of messages) {
    const role = nativeRoleLabel(message);
    let bufferedText = "";

    for (const part of message.content) {
      if (part.type === "text") {
        bufferedText = bufferedText.length > 0
          ? `${bufferedText}\n${part.text}`
          : part.text;
        continue;
      }

      if (bufferedText.trim().length > 0) {
        input.push({
          type: "message",
          content: `${role}: ${bufferedText.trim()}`,
        });
        bufferedText = "";
      }

      if (part.type !== "image_url") {
        input.push({
          type: "message",
          content: `[${part.type}:${part.url}]`,
        });
        continue;
      }

      const resolved = await resolveImageAssetForRequest(part.url);
      if (resolved) {
        input.push({
          type: "image",
          data_url: resolved.dataUrl,
        });
        continue;
      }

      input.push({
        type: "message",
        content: `[image:${part.url}]`,
      });
    }

    if (bufferedText.trim().length > 0) {
      input.push({
        type: "message",
        content: `${role}: ${bufferedText.trim()}`,
      });
    }

    if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      input.push({
        type: "message",
        content: `assistant_tool_calls: ${message.toolCalls
          .map((toolCall) => `${toolCall.name}(${JSON.stringify(toolCall.input)})`)
          .join(", ")}`,
      });
    }
  }

  return input;
}

function parseNativeUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) {
    return undefined;
  }

  const inputTokens = pickNumber(raw.input_tokens);
  const outputTokens = pickNumber(raw.total_output_tokens);
  const reasoningTokens = pickNumber(raw.reasoning_output_tokens);

  if (inputTokens == null && outputTokens == null && reasoningTokens == null) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens == null && outputTokens == null
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    reasoningTokens,
    raw,
  };
}

function normalizeNativeModel(raw: Record<string, unknown>): ModelRecord {
  const capabilities = typeof raw.capabilities === "object" ? (raw.capabilities as Record<string, unknown>) : {};
  const loadedInstances = Array.isArray(raw.loaded_instances) ? (raw.loaded_instances as Array<Record<string, unknown>>) : [];
  const loadedConfig =
    loadedInstances.length > 0 && typeof loadedInstances[0]?.config === "object"
      ? (loadedInstances[0].config as Record<string, unknown>)
      : {};
  const modelCapabilities: CapabilityRecord[] = [];
  const displayName = typeof raw.display_name === "string" ? raw.display_name : undefined;

  if (typeof capabilities.vision === "boolean") {
    const status = capabilities.vision ? ("supported" as const) : ("unsupported" as const);
    modelCapabilities.push({
      id: "model.vision",
      scope: "model",
      status,
      source: "model-metadata",
    });
    modelCapabilities.push({
      id: "model.input.image",
      scope: "model",
      status,
      source: "model-metadata",
    });

    if (capabilities.vision) {
      modelCapabilities.push({
        id: "model.multimodal",
        scope: "model",
        status: "supported",
        source: "model-metadata",
      });
    }
  }

  if (typeof capabilities.trained_for_tool_use === "boolean") {
    modelCapabilities.push({
      id: "model.trained-for-tool-use",
      scope: "model",
      status: capabilities.trained_for_tool_use ? ("supported" as const) : ("unsupported" as const),
      source: "model-metadata",
    });
  }

  const modelId = String(raw.key ?? raw.id ?? "unknown");

  return {
    id: modelId,
    runtimeId: "lmstudio-native",
    kind: raw.type === "embedding" ? "embedding" : "llm",
    availability: "available",
    metadata: {
      publisher: raw.publisher,
      displayName,
      architecture: raw.architecture,
      quantization: raw.quantization,
      sizeBytes: raw.size_bytes,
      parameterCount: raw.params_string,
      paramsString: raw.params_string,
      contextLength: pickNumber(loadedConfig.context_length, raw.max_context_length),
      maxContextLength: raw.max_context_length,
      format: raw.format,
      description: raw.description,
    },
    capabilities: withInferredModelFamilyCapabilities(modelId, modelCapabilities, {
      displayName,
      allowAudio: false,
    }),
    raw,
  };
}

function normalizeLoadedInstances(
  models: Array<Record<string, unknown>>,
  runtimeId = "lmstudio-native",
): LoadedModelInstance[] {
  const instances: LoadedModelInstance[] = [];
  for (const model of models) {
    const modelId = String(model.key ?? model.id ?? "unknown");
    const loaded = Array.isArray(model.loaded_instances) ? (model.loaded_instances as Array<Record<string, unknown>>) : [];
    for (const instance of loaded) {
      instances.push({
        id: String(instance.id ?? modelId),
        modelId,
        runtimeId,
        status: "loaded",
        config: typeof instance.config === "object" ? (instance.config as Record<string, unknown>) : {},
        capabilities: [],
        raw: instance,
      });
    }
  }
  return instances;
}

function parseNativeOutput(output: unknown): Pick<ChatResponse, "text" | "content" | "reasoning" | "toolCalls"> {
  if (!Array.isArray(output)) {
    return { text: "", content: [], toolCalls: [] };
  }

  let rawText = "";
  let reasoning = "";
  const toolCalls: ChatResponse["toolCalls"] = [];

  for (const value of output as Array<Record<string, unknown>>) {
    if (value.type === "message" && typeof value.content === "string") {
      rawText += value.content;
    }
    if (value.type === "reasoning" && typeof value.content === "string") {
      reasoning += value.content;
    }
    if (value.type === "tool_call") {
      toolCalls.push({
        id: typeof value.id === "string" ? value.id : `tool_${Math.random().toString(16).slice(2)}`,
        name: typeof value.tool === "string" ? value.tool : "unknown_tool",
        input: parseToolCallInput(value.arguments ?? {}),
      });
    }
  }

  const text = sanitizeLmStudioOpenAIText(rawText);

  return {
    text,
    content: text.length > 0 ? [{ type: "text", text }] : [],
    reasoning: reasoning || undefined,
    toolCalls,
  };
}

function sanitizeLmStudioOpenAIText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const withoutThoughtBlocks = text
    .replace(LMSTUDIO_TRANSPORT_THOUGHT_BLOCK_PATTERN, "")
    .replace(LMSTUDIO_TRANSPORT_INCOMPLETE_THOUGHT_BLOCK_PATTERN, "");
  const withoutRawToolCalls = withoutThoughtBlocks
    .replace(LMSTUDIO_TRANSPORT_TOOL_CALL_BLOCK_PATTERN, "")
    .replace(LMSTUDIO_TRANSPORT_INCOMPLETE_TOOL_CALL_BLOCK_PATTERN, "");
  const withoutWrappedArtifacts = withoutRawToolCalls.replace(LMSTUDIO_TRANSPORT_CHANNEL_PAIR_PATTERN, "");
  const withoutMarkers = withoutWrappedArtifacts
    .replace(LMSTUDIO_TRANSPORT_CHANNEL_MARKER_PATTERN, "")
    .replace(LMSTUDIO_TRANSPORT_TOOL_CALL_MARKER_PATTERN, "");
  let sawIncompleteXmlThought = false;
  const withoutXmlThoughtBlocks = withoutMarkers
    .replace(LMSTUDIO_XML_THOUGHT_COMPLETE_BLOCK_PATTERN, (_match, prefix: string) => prefix)
    .replace(LMSTUDIO_XML_THOUGHT_INCOMPLETE_BLOCK_PATTERN, () => {
      sawIncompleteXmlThought = true;
      return "";
    })
    .replace(LMSTUDIO_XML_THOUGHT_CLOSE_PATTERN, (_match, prefix: string) => prefix);
  const withoutIncompleteThoughtTrailingWhitespace = sawIncompleteXmlThought
    ? withoutXmlThoughtBlocks.replace(/[ \t]*(?:\r?\n)+$/g, "")
    : withoutXmlThoughtBlocks;
  const withoutLeadingLabel = withoutIncompleteThoughtTrailingWhitespace.replace(LMSTUDIO_LEADING_CHANNEL_LABEL_PATTERN, "");

  if (LMSTUDIO_CHANNEL_LABEL_ONLY_PATTERN.test(withoutLeadingLabel.trim())) {
    return "";
  }

  return withoutLeadingLabel.trim().length === 0
    ? ""
    : withoutLeadingLabel;
}

function toolSchemaAllowsEmptyInput(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }

  const record = schema as Record<string, unknown>;
  const required = Array.isArray(record.required) ? record.required : [];
  if (required.length > 0) {
    return false;
  }

  const properties =
    typeof record.properties === "object" && record.properties && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {};

  return Object.keys(properties).length === 0;
}

function normalizeLmStudioOpenAIToolCalls(
  toolCalls: ChatResponse["toolCalls"],
  tools: ChatRequest["tools"],
): ChatResponse["toolCalls"] {
  if (toolCalls.length === 0) {
    return toolCalls;
  }

  const toolDefinitions = new Map((tools ?? []).map((tool) => [tool.name, tool]));

  return toolCalls.flatMap((toolCall) => {
    if (typeof toolCall.input !== "string" || toolCall.input.trim().length > 0) {
      return [toolCall];
    }

    const definition = toolDefinitions.get(toolCall.name);
    if (definition && toolSchemaAllowsEmptyInput(definition.inputSchema)) {
      return [{
        ...toolCall,
        input: {},
      }];
    }

    return [];
  });
}

function sanitizeLmStudioOpenAIResponse(
  response: ChatResponse,
  tools?: ChatRequest["tools"],
): ChatResponse {
  const text = sanitizeLmStudioOpenAIText(response.text);
  const toolCalls = normalizeLmStudioOpenAIToolCalls(response.toolCalls, tools);

  if (text === response.text && toolCalls === response.toolCalls) {
    return response;
  }

  return {
    ...response,
    text,
    content: text.length > 0 ? [{ type: "text", text }] : [],
    toolCalls,
  };
}

export function createLmStudioNativeAdapter(options: LmStudioAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:1234";
  const identity: RuntimeIdentity = {
    id: "lmstudio-native",
    family: "lmstudio",
    kind: "native",
    displayName: "LM Studio Native",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const commandVersion = await detectCommandVersion("lms", ["version"]);
      const modelList = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/v1/models`, {
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      }).catch(() => undefined);
      const models = Array.isArray(modelList?.models) ? (modelList.models as Array<Record<string, unknown>>) : [];
      const normalizedModels = models.map(normalizeNativeModel);
      const loadedInstances = normalizeLoadedInstances(models);

      const warnings: string[] = [];
      const diagnosis: string[] = [];
      if (normalizedModels.length === 0 && modelList) {
        warnings.push("LM Studio is reachable, but it reported no available models.");
      }
      if (loadedInstances.length === 0 && modelList) {
        diagnosis.push("No LM Studio model instances are currently loaded.");
      }

      return {
        runtime: identity,
        installed: Boolean(commandVersion) || Boolean(modelList),
        reachable: Boolean(modelList),
        healthy: Boolean(modelList),
        version: commandVersion,
        capabilities: createNativeCapabilities(),
        models: normalizedModels,
        loadedInstances,
        warnings,
        diagnosis,
        raw: modelList,
      };
    },
    async generate(request: ChatRequest): Promise<ChatResponse> {
      const url = `${baseUrl}/api/v1/chat`;
      const input = await buildNativeInput(request.messages);
      const requestOptions = await resolveLmStudioNativeRequestOptions(
        request.model,
        request.settings,
        baseUrl,
        options.apiKey,
        request.signal,
      );
      const body = {
        model: request.model,
        input,
        stream: false,
        ...(requestOptions ?? {}),
      };
      request.debug?.({
        stage: "request",
        transport: "lmstudio-native.generate",
        url,
        method: "POST",
        payload: sanitizeDebugPayload(body),
      });

      const rawResponse = await fetch(url, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const responseText = await rawResponse.text();
      request.debug?.({
        stage: rawResponse.ok ? "response" : "error",
        transport: "lmstudio-native.generate",
        url,
        method: "POST",
        status: rawResponse.status,
        headers: headersToObject(rawResponse.headers),
        body: responseText,
      });
      if (!rawResponse.ok) {
        throw new Error(`LM Studio native request failed: ${rawResponse.status} ${responseText}`);
      }
      const response = JSON.parse(responseText) as Record<string, unknown>;
      const stats = typeof response.stats === "object" ? (response.stats as Record<string, unknown>) : undefined;
      const parsed = parseNativeOutput(response.output);
      return {
        ...parsed,
        responseId: typeof response.response_id === "string" ? response.response_id : undefined,
        usage: parseNativeUsage(stats),
        raw: response,
      };
    },
    async *stream(request: ChatRequest) {
      const url = `${baseUrl}/api/v1/chat`;
      const input = await buildNativeInput(request.messages);
      const requestOptions = await resolveLmStudioNativeRequestOptions(
        request.model,
        request.settings,
        baseUrl,
        options.apiKey,
        request.signal,
      );
      const body = {
        model: request.model,
        input,
        stream: true,
        ...(requestOptions ?? {}),
      };
      request.debug?.({
        stage: "request",
        transport: "lmstudio-native.stream",
        url,
        method: "POST",
        payload: sanitizeDebugPayload(body),
      });

      const response = await fetch(url, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) {
        const errorBody = await response.text();
        request.debug?.({
          stage: "error",
          transport: "lmstudio-native.stream",
          url,
          method: "POST",
          status: response.status,
          headers: headersToObject(response.headers),
          body: errorBody,
        });
        throw new Error(`LM Studio native stream failed: ${response.status}`);
      }
      request.debug?.({
        stage: "response",
        transport: "lmstudio-native.stream",
        url,
        method: "POST",
        status: response.status,
        headers: headersToObject(response.headers),
      });
      let rawMessageText = "";
      let emittedMessageText = "";
      for await (const message of parseSse(response.body, request.signal)) {
        request.debug?.({
          stage: "stream",
          transport: "lmstudio-native.stream",
          url,
          method: "POST",
          body: {
            event: message.event,
            data: message.data,
          },
        });
        const data = JSON.parse(message.data) as Record<string, unknown>;
        switch (message.event) {
          case undefined:
            break;
          case "message.delta":
            if (typeof data.content === "string") {
              rawMessageText += data.content;
              const sanitizedText = sanitizeLmStudioOpenAIText(rawMessageText);
              if (sanitizedText.startsWith(emittedMessageText)) {
                const delta = sanitizedText.slice(emittedMessageText.length);
                emittedMessageText = sanitizedText;
                if (delta.length > 0) {
                  yield { type: "text.delta" as const, delta };
                }
              }
            }
            break;
          case "reasoning.delta":
            if (typeof data.content === "string") {
              yield { type: "reasoning.delta" as const, delta: data.content };
            }
            break;
          case "model_load.start":
          case "model_load.progress":
          case "model_load.end":
          case "prompt_processing.start":
          case "prompt_processing.progress":
          case "prompt_processing.end":
            yield {
              type: "lifecycle" as const,
              stage: message.event,
              progress: typeof data.progress === "number" ? data.progress : undefined,
              raw: data,
            };
            break;
          case "error":
            yield {
              type: "warning" as const,
              warning: String((data.error as Record<string, unknown> | undefined)?.message ?? "LM Studio native stream error"),
              raw: data,
            };
            break;
          case "chat.end": {
            const result = typeof data.result === "object" ? (data.result as Record<string, unknown>) : {};
            const parsed = parseNativeOutput(result.output);
            const stats = typeof result.stats === "object" ? (result.stats as Record<string, unknown>) : undefined;
            yield {
              type: "response.complete" as const,
              response: {
                ...parsed,
                responseId: typeof result.response_id === "string" ? result.response_id : undefined,
                usage: parseNativeUsage(stats),
                raw: result,
              },
            };
            request.debug?.({
              stage: "response",
              transport: "lmstudio-native.stream.complete",
              url,
              method: "POST",
              body: result,
            });
            break;
          }
        }
      }
    },
    lifecycle: {
      async loadModel(modelId: string, loadOptions?: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/v1/models/load`, {
          model: modelId,
          ...(loadOptions ?? {}),
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
      async unloadModel(instanceOrModelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/v1/models/unload`, {
          instance_id: instanceOrModelId,
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
      async downloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/v1/models/download`, {
          model: modelId,
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
    },
  };
}

export function createLmStudioOpenAICompatibleAdapter(options: LmStudioAdapterOptions = {}): RuntimeAdapter {
  const nativeBaseUrl = options.baseUrl ?? "http://127.0.0.1:1234";
  const baseUrl = `${nativeBaseUrl}/v1`;
  const identity: RuntimeIdentity = {
    id: "lmstudio-openai",
    family: "lmstudio",
    kind: "openai-compatible",
    displayName: "LM Studio OpenAI-Compatible",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const modelList = await fetchJson<Record<string, unknown>>(`${baseUrl}/models`, {
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      }).catch(() => undefined);
      const nativeModelList = await fetchJson<Record<string, unknown>>(`${nativeBaseUrl}/api/v1/models`, {
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      }).catch(() => undefined);
      const rawNativeModels = Array.isArray(nativeModelList?.models)
        ? nativeModelList.models as Array<Record<string, unknown>>
        : [];
      const nativeModelsById = new Map(
        rawNativeModels
          .map((model) => normalizeNativeModel(model))
          .map((model) => [model.id, model]),
      );
      const models = Array.isArray(modelList?.data)
        ? (modelList.data as Array<Record<string, unknown>>).map((model) => {
            const modelId = String(model.id ?? "unknown");
            const nativeModel = nativeModelsById.get(modelId);
            const inferredCapabilities = withInferredModelFamilyCapabilities(
              modelId,
              nativeModel?.capabilities ?? [],
              {
                displayName:
                  typeof nativeModel?.metadata.displayName === "string"
                    ? nativeModel.metadata.displayName
                    : undefined,
              },
            );

            return {
              id: modelId,
            runtimeId: "lmstudio-openai",
            kind: "llm" as const,
            availability: "visible" as const,
            metadata: {
              ownedBy: model.owned_by,
              ...(nativeModel?.metadata ?? {}),
            },
            capabilities: inferredCapabilities,
            raw: {
              openai: model,
              native: nativeModel?.raw,
            },
          };
        })
        : [];
      return {
        runtime: identity,
        installed: Boolean(modelList) || Boolean(nativeModelList),
        reachable: Boolean(modelList),
        healthy: Boolean(modelList),
        capabilities: [
          { id: "inference.chat", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "inference.embeddings", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "runtime.list-available-models", scope: "runtime", status: "supported", source: "runtime-probe" },
          { id: "runtime.list-loaded-models", scope: "runtime", status: "supported", source: "runtime-probe" },
          { id: "runtime.load", scope: "runtime", status: "supported", source: "runtime-docs" },
          { id: "runtime.unload", scope: "runtime", status: "supported", source: "runtime-docs" },
          { id: "runtime.download", scope: "runtime", status: "supported", source: "runtime-docs" },
          { id: "request.tool-calling", scope: "request", status: "supported", source: "runtime-docs" },
          { id: "request.structured-output", scope: "request", status: "supported", source: "runtime-docs" },
        ],
        models,
        loadedInstances: normalizeLoadedInstances(rawNativeModels, "lmstudio-openai"),
        warnings: [],
        diagnosis: models.length === 0 ? ["No models are visible through the LM Studio OpenAI-compatible endpoint."] : [],
        raw: modelList,
      };
    },
    async generate(request) {
      const response = await generateOpenAICompatibleResponse(
        baseUrl,
        withLmStudioOpenAICompatibleSettings(request),
        options.apiKey ?? "lm-studio",
      );
      return sanitizeLmStudioOpenAIResponse(response, request.tools);
    },
    async *stream(request) {
      let rawText = "";
      let emittedText = "";

      for await (const event of streamOpenAICompatibleResponse(
        baseUrl,
        withLmStudioOpenAICompatibleSettings(request),
        options.apiKey ?? "lm-studio",
      )) {
        if (event.type === "text.delta") {
          rawText += event.delta;
          const sanitizedText = sanitizeLmStudioOpenAIText(rawText);
          if (sanitizedText.startsWith(emittedText)) {
            const delta = sanitizedText.slice(emittedText.length);
            emittedText = sanitizedText;
            if (delta.length > 0) {
              yield {
                type: "text.delta",
                delta,
              };
            }
          }
          continue;
        }

        if (event.type === "response.complete") {
          const response = sanitizeLmStudioOpenAIResponse(event.response, request.tools);
          if (response.text.startsWith(emittedText)) {
            const delta = response.text.slice(emittedText.length);
            emittedText = response.text;
            if (delta.length > 0) {
              yield {
                type: "text.delta",
                delta,
              };
            }
          }
          yield {
            ...event,
            response,
          };
          continue;
        }

        yield event;
      }
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await postJson<Record<string, unknown>>(`${baseUrl}/embeddings`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      });
      return {
        model: request.model,
        embeddings: Array.isArray(response.data)
          ? (response.data as Array<Record<string, unknown>>).map((item) =>
              Array.isArray(item.embedding) ? (item.embedding as number[]) : [],
            )
          : [],
        raw: response,
      };
    },
    lifecycle: {
      async loadModel(modelId: string, loadOptions?: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${nativeBaseUrl}/api/v1/models/load`, {
          model: modelId,
          ...(loadOptions ?? {}),
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
      async unloadModel(instanceOrModelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${nativeBaseUrl}/api/v1/models/unload`, {
          instance_id: instanceOrModelId,
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
      async downloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${nativeBaseUrl}/api/v1/models/download`, {
          model: modelId,
        }, {
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        });
      },
    },
  };
}
