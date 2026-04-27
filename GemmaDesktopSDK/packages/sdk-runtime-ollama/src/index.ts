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
  ToolDefinition,
  TokenUsage,
} from "@gemma-desktop/sdk-core";
import {
  detectCommandVersion,
  CANONICAL_ATTACHMENT_CAPABILITY_IDS,
  GemmaDesktopError,
  isGemmaDesktopError,
  parseToolCallInput,
  resolveBinaryAssetForRequest,
  resolveImageAssetForRequest,
  withInferredModelFamilyCapabilities,
} from "@gemma-desktop/sdk-core";
import {
  fetchJson,
  fetchWithRetry,
  generateOpenAICompatibleResponse,
  parseJsonLines,
  postJson,
  streamOpenAICompatibleResponse,
} from "@gemma-desktop/sdk-core";

export interface OllamaAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  streamIdleTimeoutMs?: number;
}

const DEFAULT_OLLAMA_STREAM_IDLE_TIMEOUT_MS = 300_000;

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
        key === "images" && Array.isArray(entry)
          ? `[${entry.length} multimodal payload(s) omitted]`
          : sanitizeDebugPayload(entry),
      ]),
    );
  }

  return value;
}

function errorMessageStack(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? error : "";
  }

  const parts = [error.message];
  if ("code" in error && typeof error.code === "string") {
    parts.push(error.code);
  }
  if ("cause" in error && error.cause instanceof Error) {
    parts.push(error.cause.message);
    if ("code" in error.cause && typeof error.cause.code === "string") {
      parts.push(error.cause.code);
    }
  }
  return parts.join("\n");
}

function normalizeOllamaStreamError(modelId: string, error: unknown): Error {
  if (isGemmaDesktopError(error)) {
    return error;
  }

  const haystack = errorMessageStack(error);
  if (/Body Timeout Error|UND_ERR_BODY_TIMEOUT|terminated|socket hang up|ECONNRESET|EOF|fetch failed/i.test(haystack)) {
    return new GemmaDesktopError(
      "transport_error",
      [
        `Ollama stopped sending data while running ${modelId}.`,
        "The local runner may have stalled, crashed, or closed the stream before Gemma Desktop received a final response.",
        "Try retrying after unloading other Ollama models, using a smaller or MoE model, or restarting Ollama.",
      ].join(" "),
      { cause: error },
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function createCapabilities(): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "inference.embeddings", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "runtime.list-available-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.list-loaded-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.download", scope: "runtime", status: "supported", source: "runtime-docs" },
    {
      id: "runtime.load-unload",
      scope: "runtime",
      status: "conditional",
      source: "runtime-docs",
      notes: ["Implemented through chat keep_alive behavior rather than a dedicated lifecycle endpoint."],
    },
    { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.tool-calling", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.reasoning-control", scope: "request", status: "conditional", source: "runtime-docs" },
  ];
}

function resolveReasoningControlValue(settings: ChatRequest["settings"]): boolean | undefined {
  const reasoningMode = settings?.reasoningMode;
  if (reasoningMode === "on") {
    return true;
  }
  if (reasoningMode === "off") {
    return false;
  }
  return undefined;
}

function resolveOllamaRequestOptions(
  settings: ChatRequest["settings"],
): Record<string, number> | undefined {
  const value = settings?.ollamaOptions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === "number" && Number.isFinite(entry)
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined;
}

function resolveOllamaKeepAliveValue(
  settings: ChatRequest["settings"],
): string | number | undefined {
  const value = settings?.ollamaKeepAlive;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function mapUsage(raw: Record<string, unknown>): TokenUsage | undefined {
  const promptEvalCount = typeof raw.prompt_eval_count === "number" ? raw.prompt_eval_count : undefined;
  const evalCount = typeof raw.eval_count === "number" ? raw.eval_count : undefined;
  if (promptEvalCount == null && evalCount == null) {
    return undefined;
  }
  return {
    inputTokens: promptEvalCount,
    outputTokens: evalCount,
    totalTokens: (promptEvalCount ?? 0) + (evalCount ?? 0),
    raw,
  };
}

function messageTextContent(message: ChatRequest["messages"][number]): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function toNativeMessages(messages: ChatRequest["messages"]): Promise<Array<Record<string, unknown>>> {
  return await Promise.all(messages.map(async (message) => {
    const nativeMessage: Record<string, unknown> = {
      role: message.role,
      content: messageTextContent(message),
    };

    const resolvedAssets = await Promise.all(
      message.content
        .filter((part) => part.type === "image_url" || part.type === "audio_url")
        .map(async (part) => {
          if (part.type === "audio_url") {
            return await resolveBinaryAssetForRequest(part.url);
          }
          return await resolveImageAssetForRequest(part.url);
        }),
    );
    const imagePayloads = resolvedAssets
      .map((resolved) => resolved?.base64Data)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (imagePayloads.length > 0) {
      nativeMessage.images = imagePayloads;
    }

    if (message.toolCalls && message.toolCalls.length > 0) {
      nativeMessage.tool_calls = message.toolCalls.map((toolCall) => ({
        function: {
          name: toolCall.name,
          arguments: toolCall.input,
        },
      }));
    }

    if (message.role === "tool" && message.name) {
      nativeMessage.tool_name = message.name;
    }

    return nativeMessage;
  }));
}

function toNativeTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function parseNativeToolCalls(raw: unknown): ChatResponse["toolCalls"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((value) => {
    const record = value as Record<string, unknown>;
    const fn = typeof record.function === "object" ? (record.function as Record<string, unknown>) : {};
    return {
      id: typeof record.id === "string" ? record.id : `tool_${Math.random().toString(16).slice(2)}`,
      name: typeof fn.name === "string" ? fn.name : "unknown_tool",
      input: parseToolCallInput(fn.arguments ?? {}),
    };
  });
}

function extractBalancedSection(
  text: string,
  start: number,
  openChar: string,
  closeChar: string,
): { inner: string; end: number } | undefined {
  if (text[start] !== openChar) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: text.slice(start + 1, index),
          end: index + 1,
        };
      }
    }
  }

  return undefined;
}

function normalizeInlineToolArguments(raw: string): string {
  return raw
    .trim()
    .replace(/<\|"\|>/g, "\"")
    .replace(/<\|tool_call\|>/gi, "")
    .replace(/<tool_call\|>/gi, "")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, "$1\"$2\"$3")
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value: string) => `: ${JSON.stringify(value.replace(/\\'/g, "'"))}`);
}

function parseInlineToolCallsFromText(text: string): {
  cleanedText: string;
  toolCalls: ChatResponse["toolCalls"];
} {
  if (!/\bcall:[a-z0-9_.:-]+\s*[{(]/i.test(text)) {
    return {
      cleanedText: text,
      toolCalls: [],
    };
  }

  const toolCalls: ChatResponse["toolCalls"] = [];
  let cleaned = "";
  let cursor = 0;
  const pattern = /\bcall:([a-zA-Z0-9_.:-]+)\s*([{(])/g;

  while (true) {
    const match = pattern.exec(text);
    if (!match || match.index == null) {
      cleaned += text.slice(cursor);
      break;
    }

    const name = match[1] ?? "";
    const opener = match[2] ?? "{";
    const openIndex = pattern.lastIndex - 1;
    const section = extractBalancedSection(
      text,
      openIndex,
      opener,
      opener === "(" ? ")" : "}",
    );

    if (!section) {
      cleaned += text.slice(cursor);
      break;
    }

    const rawArgs = opener === "{"
      ? `{${section.inner}}`
      : section.inner;
    const normalizedArgs = normalizeInlineToolArguments(rawArgs);
    const parsedInput = parseToolCallInput(normalizedArgs);

    if (typeof parsedInput === "string") {
      cleaned += text.slice(cursor, section.end);
      cursor = section.end;
      continue;
    }

    cleaned += text.slice(cursor, match.index);
    toolCalls.push({
      id: `tool_${Math.random().toString(16).slice(2)}`,
      name,
      input: parsedInput,
    });
    cursor = section.end;

    const trailingMarker = /^(\s*<\|tool_call\|>|\s*<tool_call\|>)/i.exec(text.slice(cursor));
    if (trailingMarker) {
      cursor += trailingMarker[0].length;
    }
  }

  return {
    cleanedText: cleaned.trim(),
    toolCalls,
  };
}

function parseNativeMessage(raw: unknown): Pick<ChatResponse, "text" | "content" | "reasoning" | "toolCalls"> {
  const message = typeof raw === "object" && raw ? (raw as Record<string, unknown>) : {};
  const rawText = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.thinking === "string" ? message.thinking : undefined;
  const nativeToolCalls = parseNativeToolCalls(message.tool_calls);
  const inlineFallback =
    nativeToolCalls.length === 0
      ? parseInlineToolCallsFromText(rawText)
      : {
          cleanedText: rawText,
          toolCalls: [],
        };
  const text = inlineFallback.cleanedText;

  return {
    text,
    content: text.length > 0 ? [{ type: "text", text }] : [],
    reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
    toolCalls: nativeToolCalls.length > 0 ? nativeToolCalls : inlineFallback.toolCalls,
  };
}

function pickNumericValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractModelInfoContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== "object" || Array.isArray(modelInfo)) {
    return undefined;
  }

  const record = modelInfo as Record<string, unknown>;
  const direct = pickNumericValue(
    record.context_length,
    record.contextLength,
    record.num_ctx,
    record.max_context_length,
  );
  if (direct != null) {
    return direct;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!/(\.|_|^)context_length$/i.test(key) && !/(\.|_|^)max_context_length$/i.test(key)) {
      continue;
    }
    const parsed = pickNumericValue(value);
    if (parsed != null) {
      return parsed;
    }
  }

  return undefined;
}

function parseParameterScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

function parseParametersText(parameters: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof parameters !== "string" || parameters.trim().length === 0) {
    return undefined;
  }

  const entries = parameters
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([a-zA-Z0-9_]+)\s+(.+)$/.exec(line);
      if (!match) {
        return undefined;
      }
      return [match[1], parseParameterScalar(match[2])] as const;
    })
    .filter((entry): entry is readonly [string, string | number | boolean] => Boolean(entry));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeModel(raw: Record<string, unknown>, show?: Record<string, unknown>): ModelRecord {
  const details = typeof raw.details === "object" ? (raw.details as Record<string, unknown>) : {};
  const modelInfo =
    typeof show?.model_info === "object" && show.model_info
      ? (show.model_info as Record<string, unknown>)
      : undefined;
  const showCapabilities = Array.isArray(show?.capabilities) ? (show.capabilities as string[]) : [];
  const hasExplicitCapabilities = Array.isArray(show?.capabilities);
  const supportsVision = hasExplicitCapabilities ? showCapabilities.includes("vision") : undefined;
  const supportsAudio = hasExplicitCapabilities ? showCapabilities.includes("audio") : undefined;
  const contextLength = extractModelInfoContextLength(modelInfo);
  const parameters = parseParametersText(show?.parameters);
  const capabilities = withInferredModelFamilyCapabilities(
    String(raw.name ?? raw.model ?? "unknown"),
    [
    {
      id: "model.vision",
      scope: "model",
      status:
        supportsVision == null
          ? "unknown"
          : supportsVision
            ? "supported"
            : "unsupported",
      source: "model-metadata",
    },
    {
      id: CANONICAL_ATTACHMENT_CAPABILITY_IDS.image,
      scope: "model",
      status:
        supportsVision == null
          ? "unknown"
          : supportsVision
            ? "supported"
            : "unsupported",
      source: "model-metadata",
    },
    {
      id: "model.audio",
      scope: "model",
      status:
        supportsAudio == null
          ? "unknown"
          : supportsAudio
            ? "supported"
            : "unsupported",
      source: "model-metadata",
    },
    {
      id: CANONICAL_ATTACHMENT_CAPABILITY_IDS.audio,
      scope: "model",
      status:
        supportsAudio == null
          ? "unknown"
          : supportsAudio
            ? "supported"
            : "unsupported",
      source: "model-metadata",
    },
    ],
    {
      displayName: typeof raw.name === "string" ? raw.name : undefined,
    },
  );

  if ((supportsVision || supportsAudio) && !capabilities.some((capability) =>
    capability.id === "model.multimodal" && capability.status === "supported"
  )) {
    capabilities.push({
      id: "model.multimodal",
      scope: "model",
      status: "supported",
      source: "model-metadata",
    });
  }

  return {
    id: String(raw.name ?? raw.model ?? "unknown"),
    runtimeId: "ollama-native",
    kind: "llm",
    availability: "available",
    metadata: {
      digest: raw.digest,
      size: raw.size,
      format: details.format,
      family: details.family,
      families: details.families,
      parameterSize: details.parameter_size,
      quantization: details.quantization_level,
      contextLength,
      maxContextLength: contextLength,
      modelInfo,
      template: show?.template,
      parameters,
      parametersText: show?.parameters,
    },
    capabilities: [
      ...capabilities,
      ...showCapabilities
        .filter((capability) => capability !== "vision" && capability !== "audio")
        .map((capability) => ({
          id: `model.${capability}`,
          scope: "model" as const,
          status: "supported" as const,
          source: "model-metadata",
        })),
    ],
    raw: {
      tags: raw,
      show,
    },
  };
}

export function createOllamaNativeAdapter(options: OllamaAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
  const streamIdleTimeoutMs =
    typeof options.streamIdleTimeoutMs === "number"
      && Number.isFinite(options.streamIdleTimeoutMs)
      && options.streamIdleTimeoutMs > 0
      ? options.streamIdleTimeoutMs
      : DEFAULT_OLLAMA_STREAM_IDLE_TIMEOUT_MS;
  const identity: RuntimeIdentity = {
    id: "ollama-native",
    family: "ollama",
    kind: "native",
    displayName: "Ollama Native",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const commandVersion = await detectCommandVersion("ollama");
      const version = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/version`).catch(() => undefined);
      const tags = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/tags`).catch(() => undefined);
      const ps = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/ps`).catch(() => undefined);

      const rawModels = Array.isArray(tags?.models) ? (tags.models as Array<Record<string, unknown>>) : [];
      const shows = await Promise.all(
        rawModels.map(async (model) => {
          try {
            return await postJson<Record<string, unknown>>(`${baseUrl}/api/show`, {
              model: model.name,
            });
          } catch {
            return undefined;
          }
        }),
      );

      const models = rawModels.map((model, index) => normalizeModel(model, shows[index]));
      const loadedInstances: LoadedModelInstance[] = Array.isArray(ps?.models)
        ? (ps.models as Array<Record<string, unknown>>).map((value) => ({
            id: String(value.name ?? value.model ?? "unknown"),
            modelId: String(value.name ?? value.model ?? "unknown"),
            runtimeId: "ollama-native",
            status: "loaded",
            config: {
              size: value.size,
              sizeVram: value.size_vram,
              context_length: value.context_length,
              expiresAt: value.expires_at,
              details: value.details,
            },
            capabilities: [],
            raw: value,
          }))
        : [];

      const installed = Boolean(commandVersion) || Boolean(version);
      const reachable = Boolean(version || tags || ps);
      const healthy = reachable;
      const warnings: string[] = [];
      const diagnosis: string[] = [];

      if (installed && !reachable) {
        warnings.push("Ollama appears installed, but the local server is not reachable.");
      }
      if (reachable && models.length === 0) {
        warnings.push("Ollama is reachable, but no local models were reported.");
      }
      if (reachable && loadedInstances.length === 0) {
        diagnosis.push("No models are currently loaded in memory.");
      }

      return {
        runtime: identity,
        installed,
        reachable,
        healthy,
        version: typeof version?.version === "string" ? version.version : commandVersion,
        capabilities: createCapabilities(),
        models,
        loadedInstances,
        warnings,
        diagnosis,
        raw: {
          version,
          tags,
          ps,
        },
      };
    },
    async generate(request: ChatRequest): Promise<ChatResponse> {
      const nativeMessages = await toNativeMessages(request.messages);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: nativeMessages,
        stream: false,
      };
      const think = resolveReasoningControlValue(request.settings);
      const options = resolveOllamaRequestOptions(request.settings);
      const keepAlive = resolveOllamaKeepAliveValue(request.settings);
      if (think !== undefined) {
        body.think = think;
      }
      if (options) {
        body.options = options;
      }
      if (keepAlive !== undefined) {
        body.keep_alive = keepAlive;
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = toNativeTools(request.tools);
      }
      if (request.responseFormat) {
        body.format = request.responseFormat.schema;
      }
      const url = `${baseUrl}/api/chat`;
      request.debug?.({
        stage: "request",
        transport: "ollama-native.generate",
        url,
        method: "POST",
        payload: sanitizeDebugPayload(body),
      });

      const rawResponse = await fetchWithRetry(url, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const responseText = await rawResponse.text();

      request.debug?.({
        stage: rawResponse.ok ? "response" : "error",
        transport: "ollama-native.generate",
        url,
        method: "POST",
        status: rawResponse.status,
        headers: headersToObject(rawResponse.headers),
        body: responseText,
      });

      if (!rawResponse.ok) {
        throw new Error(`Ollama generate failed: ${rawResponse.status}`);
      }

      const response = JSON.parse(responseText) as Record<string, unknown>;
      const parsed = parseNativeMessage(response.message);
      return {
        text: parsed.text,
        content: parsed.content,
        reasoning: parsed.reasoning,
        toolCalls: parsed.toolCalls,
        usage: mapUsage(response),
        finishReason: typeof response.done_reason === "string" ? response.done_reason : undefined,
        raw: response,
      };
    },
    async *stream(request: ChatRequest) {
      const nativeMessages = await toNativeMessages(request.messages);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: nativeMessages,
        stream: true,
      };
      const think = resolveReasoningControlValue(request.settings);
      const options = resolveOllamaRequestOptions(request.settings);
      const keepAlive = resolveOllamaKeepAliveValue(request.settings);
      if (think !== undefined) {
        body.think = think;
      }
      if (options) {
        body.options = options;
      }
      if (keepAlive !== undefined) {
        body.keep_alive = keepAlive;
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = toNativeTools(request.tools);
      }
      if (request.responseFormat) {
        body.format = request.responseFormat.schema;
      }
      const url = `${baseUrl}/api/chat`;
      request.debug?.({
        stage: "request",
        transport: "ollama-native.stream",
        url,
        method: "POST",
        payload: sanitizeDebugPayload(body),
      });

      const response = await fetchWithRetry(url, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      request.debug?.({
        stage: response.ok ? "response" : "error",
        transport: "ollama-native.stream",
        url,
        method: "POST",
        status: response.status,
        headers: headersToObject(response.headers),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama stream failed: ${response.status}`);
      }
      let text = "";
      let reasoning = "";
      let toolCalls: ChatResponse["toolCalls"] = [];
      let finalChunk: Record<string, unknown> | undefined;

      try {
        for await (const chunk of parseJsonLines(response.body, request.signal, {
          idleTimeoutMs: streamIdleTimeoutMs,
          idleTimeoutMessage:
            `Ollama accepted the ${request.model} stream but produced no data for ${Math.round(streamIdleTimeoutMs / 1000)} seconds. `
            + "The local runner may have stalled; Gemma Desktop is ending the turn instead of waiting indefinitely.",
        })) {
          finalChunk = chunk;
          const parsed = parseNativeMessage(chunk.message);
          if (parsed.reasoning) {
            reasoning += parsed.reasoning;
            yield {
              type: "reasoning.delta" as const,
              delta: parsed.reasoning,
            };
          }
          if (parsed.text.length > 0) {
            text += parsed.text;
            yield {
              type: "text.delta" as const,
              delta: parsed.text,
            };
          }
          if (parsed.toolCalls.length > 0) {
            toolCalls = parsed.toolCalls;
          }
        }
      } catch (error) {
        throw normalizeOllamaStreamError(request.model, error);
      }

      if (finalChunk) {
        request.debug?.({
          stage: "stream",
          transport: "ollama-native.stream",
          url,
          method: "POST",
          body: finalChunk,
        });
      }

      const inlineFallback =
        toolCalls.length === 0
          ? parseInlineToolCallsFromText(text)
          : {
              cleanedText: text,
              toolCalls: [],
            };
      const finalText = inlineFallback.cleanedText;
      if (toolCalls.length === 0 && inlineFallback.toolCalls.length > 0) {
        toolCalls = inlineFallback.toolCalls;
      }

      yield {
        type: "response.complete" as const,
        response: {
          text: finalText,
          content: finalText.length > 0 ? [{ type: "text", text: finalText }] : [],
          reasoning: reasoning || undefined,
          toolCalls,
          usage: finalChunk ? mapUsage(finalChunk) : undefined,
          finishReason: typeof finalChunk?.done_reason === "string" ? finalChunk.done_reason : undefined,
          raw: finalChunk,
        },
      };
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await postJson<Record<string, unknown>>(`${baseUrl}/api/embed`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
      });
      return {
        model: request.model,
        embeddings: Array.isArray(response.embeddings) ? (response.embeddings as number[][]) : [],
        raw: response,
      };
    },
    lifecycle: {
      async loadModel(modelId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/chat`, {
          model: modelId,
          messages: [],
          ...(options ? { options } : {}),
          stream: false,
        });
      },
      async unloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/chat`, {
          model: modelId,
          messages: [],
          keep_alive: 0,
          stream: false,
        });
      },
      async downloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/api/pull`, {
          model: modelId,
          stream: false,
        });
      },
    },
  };
}

export function createOllamaOpenAICompatibleAdapter(options: OllamaAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = `${options.baseUrl ?? "http://127.0.0.1:11434"}/v1`;
  const identity: RuntimeIdentity = {
    id: "ollama-openai",
    family: "ollama",
    kind: "openai-compatible",
    displayName: "Ollama OpenAI-Compatible",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const commandVersion = await detectCommandVersion("ollama");
      const modelsResponse = await fetchJson<Record<string, unknown>>(`${baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${options.apiKey ?? "ollama"}`,
        },
      }).catch(() => undefined);
      const models = Array.isArray(modelsResponse?.data)
        ? (modelsResponse.data as Array<Record<string, unknown>>).map((value) => ({
            id: String(value.id ?? "unknown"),
            runtimeId: "ollama-openai",
            kind: "llm" as const,
            availability: "visible" as const,
            metadata: {
              ownedBy: value.owned_by,
            },
            capabilities: [],
            raw: value,
          }))
        : [];
      return {
        runtime: identity,
        installed: Boolean(commandVersion) || Boolean(modelsResponse),
        reachable: Boolean(modelsResponse),
        healthy: Boolean(modelsResponse),
        version: commandVersion,
        capabilities: [
          { id: "inference.chat", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "inference.embeddings", scope: "request", status: "supported", source: "runtime-probe" },
          { id: "request.tool-calling", scope: "request", status: "conditional", source: "runtime-docs" },
          { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
        ],
        models,
        loadedInstances: [],
        warnings: models.length === 0 ? ["No OpenAI-compatible models were reported by Ollama."] : [],
        diagnosis: [],
        raw: modelsResponse,
      };
    },
    async generate(request) {
      return await generateOpenAICompatibleResponse(baseUrl, request, options.apiKey ?? "ollama");
    },
    async *stream(request) {
      yield* streamOpenAICompatibleResponse(baseUrl, request, options.apiKey ?? "ollama");
    },
    async embed(request) {
      const response = await postJson<Record<string, unknown>>(`${baseUrl}/embeddings`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
        headers: {
          authorization: `Bearer ${options.apiKey ?? "ollama"}`,
        },
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
  };
}
