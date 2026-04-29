import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GemmaDesktopError } from "./errors.js";
import type {
  AdapterStreamEvent,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelToolCall,
  SessionMessage,
  ToolDefinition,
  TokenUsage,
} from "./runtime.js";
import { contentPartsToText, makeId, parseToolCallInput } from "./runtime.js";

export interface SseMessage {
  event?: string;
  data: string;
}

export interface StreamReadTimeoutOptions {
  idleTimeoutMs?: number;
  idleTimeoutMessage?: string;
}

export interface ResolvedRequestImage {
  sourceUrl: string;
  mimeType: string;
  base64Data: string;
  dataUrl: string;
  originalBytes: number;
  preparedBytes: number;
}

export interface ResolvedRequestBinaryAsset {
  sourceUrl: string;
  mimeType: string;
  base64Data: string;
  dataUrl: string;
  originalBytes: number;
}

const execFileAsync = promisify(execFile);
const REQUEST_IMAGE_MAX_LONG_EDGE = 2048;
const requestImageCache = new Map<string, Promise<ResolvedRequestImage>>();
const requestBinaryAssetCache = new Map<string, Promise<ResolvedRequestBinaryAsset>>();

function headersToObject(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

function inferMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".m4v":
      return "video/x-m4v";
    case ".webm":
      return "video/webm";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function resolveImageUrlForRequest(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  const resolved = await resolveImageAssetForRequest(url);
  return resolved?.dataUrl ?? url;
}

function parseImageDataUrl(value: string): ResolvedRequestImage | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(value);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");
  return {
    sourceUrl: value,
    mimeType,
    base64Data,
    dataUrl: value,
    originalBytes: buffer.byteLength,
    preparedBytes: buffer.byteLength,
  };
}

function parseBinaryDataUrl(value: string): ResolvedRequestBinaryAsset | undefined {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");
  return {
    sourceUrl: value,
    mimeType,
    base64Data,
    dataUrl: value,
    originalBytes: buffer.byteLength,
  };
}

function resolveImageFilePath(url: string): string | undefined {
  if (url.startsWith("file://")) {
    return fileURLToPath(url);
  }
  if (path.isAbsolute(url)) {
    return url;
  }
  return undefined;
}

async function probeImageLongEdge(filePath: string): Promise<number | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath]);
    const width = Number(/pixelWidth:\s+(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s+(\d+)/.exec(stdout)?.[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return Math.max(width, height);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function normalizeLocalImageForRequest(filePath: string, originalBytes: Buffer): Promise<Buffer> {
  const longEdge = await probeImageLongEdge(filePath);
  if (longEdge == null || longEdge <= REQUEST_IMAGE_MAX_LONG_EDGE) {
    return originalBytes;
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-image-"));
  const outputPath = path.join(tempDirectory, path.basename(filePath));

  try {
    await execFileAsync("sips", [
      "--resampleHeightWidthMax",
      String(REQUEST_IMAGE_MAX_LONG_EDGE),
      filePath,
      "--out",
      outputPath,
    ]);
    return await readFile(outputPath);
  } catch {
    return originalBytes;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildResolvedLocalImage(filePath: string): Promise<ResolvedRequestImage> {
  const originalBytes = await readFile(filePath);
  const preparedBytes = await normalizeLocalImageForRequest(filePath, originalBytes);
  const mimeType = inferMimeTypeFromPath(filePath);
  const base64Data = preparedBytes.toString("base64");
  return {
    sourceUrl: filePath,
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    originalBytes: originalBytes.byteLength,
    preparedBytes: preparedBytes.byteLength,
  };
}

async function buildResolvedLocalBinaryAsset(filePath: string): Promise<ResolvedRequestBinaryAsset> {
  const originalBytes = await readFile(filePath);
  const mimeType = inferMimeTypeFromPath(filePath);
  const base64Data = originalBytes.toString("base64");
  return {
    sourceUrl: filePath,
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    originalBytes: originalBytes.byteLength,
  };
}

export async function resolveImageAssetForRequest(url: string): Promise<ResolvedRequestImage | undefined> {
  const inline = parseImageDataUrl(url);
  if (inline) {
    return inline;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return undefined;
  }

  const filePath = resolveImageFilePath(url);
  if (!filePath) {
    return undefined;
  }

  const fileStats = await stat(filePath).catch(() => undefined);
  if (!fileStats?.isFile()) {
    return undefined;
  }

  const cacheKey = `${filePath}:${fileStats.size}:${fileStats.mtimeMs}`;
  let cached = requestImageCache.get(cacheKey);
  if (!cached) {
    cached = buildResolvedLocalImage(filePath);
    requestImageCache.set(cacheKey, cached);
  }

  return await cached;
}

export async function resolveBinaryAssetForRequest(url: string): Promise<ResolvedRequestBinaryAsset | undefined> {
  const inline = parseBinaryDataUrl(url);
  if (inline) {
    return inline;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return undefined;
  }

  const filePath = resolveImageFilePath(url);
  if (!filePath) {
    return undefined;
  }

  const fileStats = await stat(filePath).catch(() => undefined);
  if (!fileStats?.isFile()) {
    return undefined;
  }

  const cacheKey = `${filePath}:${fileStats.size}:${fileStats.mtimeMs}`;
  let cached = requestBinaryAssetCache.get(cacheKey);
  if (!cached) {
    cached = buildResolvedLocalBinaryAsset(filePath);
    requestBinaryAssetCache.set(cacheKey, cached);
  }

  return await cached;
}

function audioFormatFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/flac":
      return "flac";
    default:
      return "wav";
  }
}

function sanitizeDebugPayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      const mimeBoundary = value.indexOf(";");
      const mimeType = mimeBoundary > 5 ? value.slice(5, mimeBoundary) : "image";
      return `[${mimeType} data url omitted]`;
    }
    if (value.startsWith("data:audio/")) {
      const mimeBoundary = value.indexOf(";");
      const mimeType = mimeBoundary > 5 ? value.slice(5, mimeBoundary) : "audio";
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

export interface FetchRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 2000;

const TRANSIENT_ERROR_MARKERS = [
  "fetch failed",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "socket hang up",
  "network request failed",
  "other side closed",
];

export function isTransientFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };

    if (record.name === "AbortError") {
      return false;
    }

    const codeStr = typeof record.code === "string" ? record.code : "";
    if (codeStr && TRANSIENT_ERROR_MARKERS.some((marker) => codeStr === marker || codeStr.includes(marker))) {
      return true;
    }

    const messageStr = typeof record.message === "string" ? record.message : "";
    if (messageStr && TRANSIENT_ERROR_MARKERS.some((marker) => messageStr.toLowerCase().includes(marker.toLowerCase()))) {
      return true;
    }

    current = record.cause;
  }

  return false;
}

async function sleepWithAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw new GemmaDesktopError("cancellation", "Request cancelled.");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      clearTimeout(timer);
      reject(new GemmaDesktopError("cancellation", "Request cancelled."));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const signal = init.signal ?? undefined;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new GemmaDesktopError("cancellation", "Request cancelled.");
    }
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || !isTransientFetchError(error) || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(attempt, error, delayMs);
      await sleepWithAbort(delayMs, signal ?? undefined);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new GemmaDesktopError("transport_error", `Request failed for ${url}`);
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithRetry(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new GemmaDesktopError("transport_error", `Request failed for ${url}: ${response.status}`, {
      details: { status: response.status, body },
      raw: body,
    });
  }
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body: Record<string, unknown>, init: RequestInit = {}): Promise<T> {
  return await fetchJson<T>(url, {
    ...init,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  options: StreamReadTimeoutOptions = {},
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const idleTimeoutMs =
    typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : undefined;

  if (!signal && idleTimeoutMs === undefined) {
    return await reader.read();
  }

  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw new GemmaDesktopError("cancellation", "Stream cancelled.");
  }

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (timeout) {
        clearTimeout(timeout);
      }
    };

    const settleResolve = (result: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "Stream read failed."),
      );
    };

    const onAbort = () => {
      settleReject(new GemmaDesktopError("cancellation", "Stream cancelled."));
      void reader.cancel().catch(() => {});
    };

    const onTimeout = () => {
      settleReject(
        new GemmaDesktopError(
          "timeout",
          options.idleTimeoutMessage ?? `Stream produced no data for ${idleTimeoutMs}ms.`,
          {
            details: { idleTimeoutMs },
          },
        ),
      );
      void reader.cancel().catch(() => {});
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (idleTimeoutMs !== undefined) {
      timeout = setTimeout(onTimeout, idleTimeoutMs);
    }
    void reader.read().then(settleResolve, settleReject);
  });
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: StreamReadTimeoutOptions = {},
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await readStreamChunk(reader, signal, options);
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary === -1) {
        break;
      }

      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));

      let event: string | undefined;
      const dataParts: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataParts.push(line.slice(5).trim());
        }
      }

      if (dataParts.length > 0) {
        yield {
          event,
          data: dataParts.join("\n"),
        };
      }
    }
  }

  if (buffer.trim().length > 0) {
    let event: string | undefined;
    const dataParts: string[] = [];
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).trim());
      }
    }
    if (dataParts.length > 0) {
      yield { event, data: dataParts.join("\n") };
    }
  }
}

export async function* parseJsonLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: StreamReadTimeoutOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await readStreamChunk(reader, signal, options);
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        yield JSON.parse(line) as Record<string, unknown>;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer.trim().length > 0) {
    yield JSON.parse(buffer.trim()) as Record<string, unknown>;
  }
}

export async function buildOpenAICompatibleMessages(messages: SessionMessage[]): Promise<Array<Record<string, unknown>>> {
  return await Promise.all(messages.map(async (message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: contentPartsToText(message.content),
        tool_call_id: message.toolCallId,
        name: message.name,
      };
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content.length > 0 ? contentPartsToText(message.content) : null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        })),
      };
    }

    const content =
      message.content.some((part) => part.type !== "text")
        ? await Promise.all(message.content.map(async (part) => {
            if (part.type === "text") {
              return {
                type: "text",
                text: part.text,
              };
            }
            if (part.type === "audio_url") {
              const resolved = await resolveBinaryAssetForRequest(part.url);
              if (!resolved) {
                return {
                  type: "text",
                  text: `[audio:${part.url}]`,
                };
              }
              return {
                type: "input_audio",
                input_audio: {
                  data: resolved.base64Data,
                  format: audioFormatFromMimeType(part.mediaType ?? resolved.mimeType),
                },
              };
            }
            if (part.type !== "image_url") {
              return {
                type: "text",
                text: `[${part.type}:${part.url}]`,
              };
            }
            return {
              type: "image_url",
              image_url: {
                url: await resolveImageUrlForRequest(part.url),
              },
            };
          }))
        : contentPartsToText(message.content);

    return {
      role: message.role,
      content,
      name: message.name,
    };
  }));
}

export function buildOpenAICompatibleTools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.strict == null ? {} : { strict: tool.strict }),
    },
  }));
}

const OPENAI_COMPATIBLE_OPTION_KEYS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "max_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "repeat_penalty",
  "seed",
  "xtc_probability",
  "xtc_threshold",
  "thinking_budget",
  "chat_template_kwargs",
]);

function normalizeOpenAICompatiblePrimitiveRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    (typeof entry === "number" && Number.isFinite(entry))
    || typeof entry === "string"
    || typeof entry === "boolean"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOpenAICompatibleOptionValue(key: string, value: unknown): unknown {
  if (key === "chat_template_kwargs") {
    return normalizeOpenAICompatiblePrimitiveRecord(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
      typeof entry === "number" && Number.isFinite(entry)
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

function resolveOpenAICompatibleRequestOptions(
  settings: ChatRequest["settings"],
): Record<string, unknown> | undefined {
  const value = settings?.openAICompatibleOptions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, rawValue]) => {
    if (!OPENAI_COMPATIBLE_OPTION_KEYS.has(key)) {
      return [];
    }
    const normalized = normalizeOpenAICompatibleOptionValue(key, rawValue);
    return normalized === undefined ? [] : [[key, normalized] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseOpenAICompatibleUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) {
    return undefined;
  }

  const promptDetails = typeof raw.prompt_tokens_details === "object" ? (raw.prompt_tokens_details as Record<string, unknown>) : undefined;
  const completionDetails =
    typeof raw.completion_tokens_details === "object"
      ? (raw.completion_tokens_details as Record<string, unknown>)
      : undefined;

  return {
    inputTokens: typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : undefined,
    outputTokens:
      typeof raw.completion_tokens === "number"
        ? raw.completion_tokens
        : typeof raw.output_tokens === "number"
          ? raw.output_tokens
          : typeof raw.total_output_tokens === "number"
            ? raw.total_output_tokens
            : undefined,
    totalTokens: typeof raw.total_tokens === "number" ? raw.total_tokens : undefined,
    reasoningTokens: typeof completionDetails?.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : undefined,
    cacheReadTokens: typeof promptDetails?.cached_tokens === "number" ? promptDetails.cached_tokens : undefined,
    raw,
  };
}

function parseOpenAICompatibleToolCalls(rawCalls: unknown): ModelToolCall[] {
  if (!Array.isArray(rawCalls)) {
    return [];
  }

  return rawCalls
    .map((value) => {
      const record = value as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      const rawArgs = typeof fn?.arguments === "string" ? fn.arguments : "{}";
      return {
        id: typeof record.id === "string" ? record.id : makeId("tool_call"),
        name: typeof fn?.name === "string" ? fn.name : "unknown_tool",
        input: parseToolCallInput(rawArgs),
      } satisfies ModelToolCall;
    })
    .filter((toolCall) => toolCall.name.length > 0);
}

function parseOpenAICompatibleMessageContent(message: Record<string, unknown>): { text: string; content: ContentPart[]; reasoning?: string } {
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    const parts: ContentPart[] = [];
    let reasoning = "";
    for (const value of rawContent) {
      const record = value as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        parts.push({ type: "text", text: record.text });
      }
      if (record.type === "audio" && typeof record.transcript === "string") {
        parts.push({ type: "text", text: record.transcript });
      }
      if (record.type === "reasoning" && typeof record.text === "string") {
        reasoning += record.text;
      }
    }
    return {
      text: parts.map((part) => part.type === "text" ? part.text : "").join(""),
      content: parts,
      reasoning: reasoning || undefined,
    };
  }

  const text = typeof rawContent === "string" ? rawContent : "";
  const reasoningContent =
    typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : undefined;

  return {
    text,
    content: text.length > 0 ? [{ type: "text", text }] : [],
    reasoning: reasoningContent,
  };
}

export async function generateOpenAICompatibleResponse(
  baseUrl: string,
  request: ChatRequest,
  apiKey = "not-required",
): Promise<ChatResponse> {
  const messages = await buildOpenAICompatibleMessages(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    tools: buildOpenAICompatibleTools(request.tools),
    stream: false,
    ...resolveOpenAICompatibleRequestOptions(request.settings),
  };

  if (request.responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.responseFormat.name ?? "response",
        description: request.responseFormat.description,
        schema: request.responseFormat.schema,
        strict: request.responseFormat.strict ?? true,
      },
    };
  }

  const url = `${baseUrl}/chat/completions`;
  request.debug?.({
    stage: "request",
    transport: "openai-compatible.generate",
    url,
    method: "POST",
    payload: sanitizeDebugPayload(body),
  });

  const rawResponse = await fetchWithRetry(url, {
    method: "POST",
    signal: request.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await rawResponse.text();

  request.debug?.({
    stage: rawResponse.ok ? "response" : "error",
    transport: "openai-compatible.generate",
    url,
    method: "POST",
    status: rawResponse.status,
    headers: headersToObject(rawResponse.headers),
    body: responseText,
  });

  if (!rawResponse.ok) {
    throw new GemmaDesktopError("transport_error", `Request failed for ${url}: ${rawResponse.status}`, {
      details: { status: rawResponse.status, body: responseText },
      raw: responseText,
    });
  }

  const response = JSON.parse(responseText) as Record<string, unknown>;

  const choices = Array.isArray(response.choices) ? (response.choices as Array<Record<string, unknown>>) : [];
  const choice = choices[0] ?? {};
  const message = typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : {};
  const content = parseOpenAICompatibleMessageContent(message);

  return {
    responseId: typeof response.id === "string" ? response.id : undefined,
    text: content.text,
    content: content.content,
    reasoning: content.reasoning,
    toolCalls: parseOpenAICompatibleToolCalls(message.tool_calls),
    usage: parseOpenAICompatibleUsage(typeof response.usage === "object" ? (response.usage as Record<string, unknown>) : undefined),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
    raw: response,
  };
}

export async function* streamOpenAICompatibleResponse(
  baseUrl: string,
  request: ChatRequest,
  apiKey = "not-required",
): AsyncGenerator<AdapterStreamEvent> {
  const messages = await buildOpenAICompatibleMessages(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    tools: buildOpenAICompatibleTools(request.tools),
    stream: true,
    ...resolveOpenAICompatibleRequestOptions(request.settings),
  };

  if (request.responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.responseFormat.name ?? "response",
        description: request.responseFormat.description,
        schema: request.responseFormat.schema,
        strict: request.responseFormat.strict ?? true,
      },
    };
  }

  const url = `${baseUrl}/chat/completions`;
  request.debug?.({
    stage: "request",
    transport: "openai-compatible.stream",
    url,
    method: "POST",
    payload: sanitizeDebugPayload(body),
  });

  const response = await fetchWithRetry(url, {
    method: "POST",
    signal: request.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    request.debug?.({
      stage: "error",
      transport: "openai-compatible.stream",
      url,
      method: "POST",
      status: response.status,
      headers: headersToObject(response.headers),
      body: errorBody,
    });
    throw new GemmaDesktopError("transport_error", `Streaming request failed for ${baseUrl}/chat/completions`, {
      details: { status: response.status, body: errorBody },
    });
  }

  request.debug?.({
    stage: "response",
    transport: "openai-compatible.stream",
    url,
    method: "POST",
    status: response.status,
    headers: headersToObject(response.headers),
  });

  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  let responseId: string | undefined;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const message of parseSse(response.body, request.signal)) {
    if (message.data === "[DONE]") {
      request.debug?.({
        stage: "stream",
        transport: "openai-compatible.stream",
        url,
        method: "POST",
        body: "[DONE]",
      });
      break;
    }

    request.debug?.({
      stage: "stream",
      transport: "openai-compatible.stream",
      url,
      method: "POST",
      body: {
        event: message.event,
        data: message.data,
      },
    });

    const chunk = JSON.parse(message.data) as Record<string, unknown>;
    if (typeof chunk.id === "string") {
      responseId = chunk.id;
    }

    if (typeof chunk.usage === "object") {
      usage = parseOpenAICompatibleUsage(chunk.usage as Record<string, unknown>);
    }

    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : [];
    const choice = choices[0];
    if (!choice) {
      continue;
    }

    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }

    const delta = typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : {};

    if (typeof delta.content === "string") {
      text += delta.content;
      yield {
        type: "text.delta",
        delta: delta.content,
      };
    }

    const reasoningDelta =
      typeof delta.reasoning === "string"
        ? delta.reasoning
        : typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : undefined;

    if (reasoningDelta) {
      reasoning += reasoningDelta;
      yield {
        type: "reasoning.delta",
        delta: reasoningDelta,
      };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof rawCall.index === "number" ? rawCall.index : toolCalls.size;
        const current = toolCalls.get(index) ?? {
          id: typeof rawCall.id === "string" ? rawCall.id : makeId("tool_call"),
          name: "",
          arguments: "",
        };
        const fn = typeof rawCall.function === "object" ? (rawCall.function as Record<string, unknown>) : {};
        if (typeof rawCall.id === "string") {
          current.id = rawCall.id;
        }
        if (typeof fn.name === "string" && fn.name.length > 0) {
          current.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          current.arguments += fn.arguments;
        }
        toolCalls.set(index, current);
      }
    }
  }

  const finalToolCalls: ModelToolCall[] = [...toolCalls.values()].map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name || "unknown_tool",
    input: parseToolCallInput(toolCall.arguments),
  }));

  yield {
    type: "response.complete",
    response: {
      responseId,
      text,
      content: text.length > 0 ? [{ type: "text", text }] : [],
      reasoning: reasoning || undefined,
      toolCalls: finalToolCalls,
      usage,
      finishReason,
    },
  };

  request.debug?.({
    stage: "response",
    transport: "openai-compatible.stream.complete",
    url,
    method: "POST",
    body: {
      responseId,
      text,
      reasoning,
      finishReason,
      usage,
      toolCalls: finalToolCalls,
    },
  });
}
