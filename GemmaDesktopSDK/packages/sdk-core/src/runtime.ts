import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { GemmaDesktopEvent } from "./events.js";
import type { SessionSnapshot } from "./session.js";

export type JsonSchema = Record<string, unknown>;

export type CapabilityStatus = "supported" | "unsupported" | "conditional" | "unknown";
export type CapabilityScope = "runtime" | "model" | "instance" | "request" | "server-session";

export interface CapabilityRecord {
  id: string;
  scope: CapabilityScope;
  status: CapabilityStatus;
  source: string;
  conditions?: string[];
  notes?: string[];
  raw?: unknown;
}

export type AttachmentKind = "image" | "audio" | "video" | "pdf";

export const CANONICAL_ATTACHMENT_CAPABILITY_IDS: Record<AttachmentKind, string> = {
  image: "model.input.image",
  audio: "model.input.audio",
  video: "model.input.video",
  pdf: "model.input.pdf",
};

export const ATTACHMENT_CAPABILITY_IDS: Record<AttachmentKind, readonly string[]> = {
  image: [
    CANONICAL_ATTACHMENT_CAPABILITY_IDS.image,
    "model.vision",
    "model.image-input",
    "model.multimodal",
  ],
  audio: [
    CANONICAL_ATTACHMENT_CAPABILITY_IDS.audio,
    "model.audio",
    "model.multimodal",
  ],
  video: [
    CANONICAL_ATTACHMENT_CAPABILITY_IDS.video,
    "model.multimodal",
  ],
  pdf: [
    CANONICAL_ATTACHMENT_CAPABILITY_IDS.pdf,
    "model.multimodal",
  ],
};

export type ContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      url: string;
      mediaType?: string;
    }
  | {
      type: "audio_url";
      url: string;
      mediaType?: string;
    }
  | {
      type: "video_url";
      url: string;
      mediaType?: string;
    }
  | {
      type: "pdf_url";
      url: string;
      mediaType?: string;
    };

export type SessionInput = string | ContentPart[];

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolAttachment {
  type: "file" | "image" | "text";
  path?: string;
  name?: string;
  contentType?: string;
  content?: string;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  title?: string;
  output: string;
  structuredOutput?: unknown;
  attachments?: ToolAttachment[];
  metadata?: Record<string, unknown>;
}

export interface ToolSubsessionRequest {
  prompt: SessionInput;
  mode?: ModeSelection;
  systemInstructions?: string;
  responseFormat?: StructuredOutputSpec;
  toolNames?: string[];
  maxSteps?: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onSessionStarted?: (info: {
    sessionId: string;
    turnId: string;
  }) => void | Promise<void>;
  onEvent?: (event: GemmaDesktopEvent) => void | Promise<void>;
}

export interface ToolSubsessionResult {
  sessionId: string;
  turnId: string;
  events: GemmaDesktopEvent[];
  outputText: string;
  structuredOutput?: unknown;
  metadata?: Record<string, unknown>;
  snapshot?: SessionSnapshot;
}

export interface ToolProgressUpdate {
  id?: string;
  label: string;
  tone?: "info" | "success" | "warning";
}

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  mode: ModeSelection;
  sessionMetadata?: Record<string, unknown>;
  workingDirectory: string;
  signal?: AbortSignal;
  emit?: (event: GemmaDesktopEvent) => void;
  emitProgress?: (progress: ToolProgressUpdate) => void;
  runSubsession?: (request: ToolSubsessionRequest) => Promise<ToolSubsessionResult>;
  geminiApiKey?: string;
  geminiApiModel?: string;
}

export interface ToolExecutor {
  listTools(): ToolDefinition[];
  execute(toolCall: ModelToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface RuntimeDebugEvent {
  stage: "request" | "response" | "stream" | "error";
  transport: string;
  url: string;
  method: string;
  payload?: unknown;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: unknown;
}

export type RuntimeDebugRecorder = (event: RuntimeDebugEvent) => void;

export interface StructuredOutputSpec {
  schema: JsonSchema;
  name?: string;
  description?: string;
  strict?: boolean;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  raw?: unknown;
}

export function isGemma4ModelId(modelId: string): boolean {
  return modelId.toLowerCase().replace(/[^a-z0-9]+/g, "").includes("gemma4");
}

export interface SessionMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  createdAt: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: SessionMessage[];
  tools?: ToolDefinition[];
  responseFormat?: StructuredOutputSpec;
  signal?: AbortSignal;
  settings?: Record<string, unknown>;
  debug?: RuntimeDebugRecorder;
}

export interface ChatResponse {
  responseId?: string;
  text: string;
  content: ContentPart[];
  reasoning?: string;
  toolCalls: ModelToolCall[];
  usage?: TokenUsage;
  finishReason?: string;
  warnings?: string[];
  structuredOutput?: unknown;
  raw?: unknown;
  metadata?: Record<string, unknown>;
}

export type AdapterStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "warning"; warning: string; raw?: unknown }
  | { type: "lifecycle"; stage: string; progress?: number; raw?: unknown }
  | { type: "response.complete"; response: ChatResponse };

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  model: string;
  embeddings: number[][];
  raw?: unknown;
}

export interface RuntimeIdentity {
  id: string;
  family: "ollama" | "lmstudio" | "llamacpp" | "omlx" | "unknown";
  kind: "native" | "openai-compatible" | "server";
  displayName: string;
  endpoint: string;
}

export interface ModelRecord {
  id: string;
  runtimeId: string;
  kind: "llm" | "embedding" | "unknown";
  availability: "available" | "visible" | "loaded-only-view";
  metadata: Record<string, unknown>;
  capabilities: CapabilityRecord[];
  raw?: unknown;
}

export interface LoadedModelInstance {
  id: string;
  modelId: string;
  runtimeId: string;
  status: "loading" | "loaded" | "sleeping" | "unloaded" | "unknown";
  config: Record<string, unknown>;
  capabilities: CapabilityRecord[];
  raw?: unknown;
}

export interface RuntimeInspectionResult {
  runtime: RuntimeIdentity;
  installed: boolean;
  reachable: boolean;
  healthy: boolean;
  version?: string;
  capabilities: CapabilityRecord[];
  models: ModelRecord[];
  loadedInstances: LoadedModelInstance[];
  warnings: string[];
  diagnosis: string[];
  raw?: unknown;
}

export interface RuntimeLifecycleController {
  loadModel?(modelId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  unloadModel?(instanceOrModelId: string): Promise<Record<string, unknown>>;
  downloadModel?(modelId: string): Promise<Record<string, unknown>>;
}

export interface RuntimeAdapter {
  readonly identity: RuntimeIdentity;
  inspect(): Promise<RuntimeInspectionResult>;
  generate(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<AdapterStreamEvent>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
  lifecycle?: RuntimeLifecycleController;
}

export interface MachineProfile {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  totalMemoryBytes: number;
  cpuModel?: string;
  cpuCount: number;
  hostname: string;
}

export interface EnvironmentInspectionResult {
  inspectedAt: string;
  machine: MachineProfile;
  runtimes: RuntimeInspectionResult[];
  warnings: string[];
  diagnosis: string[];
}

export type PublicModePreset =
  | "assistant"
  | "explore"
  | "cowork"
  | "planner"
  | "plan"
  | "build";
export type InternalModePreset = "minimal" | "tool-worker";
export type ModePreset = PublicModePreset | InternalModePreset;

export type ModeSelection =
  | ModePreset
  | {
      base?: ModePreset;
      tools?: string[];
      withoutTools?: string[];
      requiredTools?: string[];
    };

export function makeId(prefix = "gemmaDesktop"): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeInput(input: SessionInput): ContentPart[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }
  return input;
}

export function contentPartToAttachmentKind(part: ContentPart): AttachmentKind | undefined {
  switch (part.type) {
    case "text":
      return undefined;
    case "image_url":
      return "image";
    case "audio_url":
      return "audio";
    case "video_url":
      return "video";
    case "pdf_url":
      return "pdf";
  }
}

export function describeAttachmentKind(kind: AttachmentKind): string {
  switch (kind) {
    case "image":
      return "images";
    case "audio":
      return "audio files";
    case "video":
      return "videos";
    case "pdf":
      return "PDF files";
  }
}

export function resolveCapabilityStatus(
  records: readonly CapabilityRecord[],
  ids: readonly string[],
): CapabilityRecord["status"] | undefined {
  let fallback: CapabilityRecord["status"] | undefined;

  for (const id of ids) {
    for (const record of records) {
      if (record.id !== id) {
        continue;
      }

      if (record.status === "supported" || record.status === "unsupported") {
        return record.status;
      }

      fallback ??= record.status;
    }
  }

  return fallback;
}

export interface InferModelFamilyCapabilitiesOptions {
  displayName?: string;
  allowImage?: boolean;
  allowAudio?: boolean;
}

interface InferredGemmaMultimodalSupport {
  image: boolean;
  audio: boolean;
}

const MODEL_FAMILY_INFERENCE_SOURCE = "model-family-inference";
const MODEL_FAMILY_INFERENCE_NOTE =
  "Inferred from Gemma model-family naming because the runtime did not report an explicit attachment capability flag.";

function inferGemmaMultimodalSupport(
  modelId: string,
  displayName?: string,
): InferredGemmaMultimodalSupport | undefined {
  const signature = [modelId, displayName]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (!signature.includes("gemma")) {
    return undefined;
  }

  const isGemma4 = signature.includes("gemma4");
  const isGemma3n = signature.includes("gemma3n");
  if (!isGemma4 && !isGemma3n) {
    return undefined;
  }

  return {
    image: isGemma4 || isGemma3n,
    audio: isGemma3n || signature.includes("gemma4e2b") || signature.includes("gemma4e4b"),
  };
}

function pushCapabilityIfUndecided(
  target: CapabilityRecord[],
  ids: readonly string[],
  records: CapabilityRecord[],
): void {
  const status = resolveCapabilityStatus(target, ids);
  if (status === "supported" || status === "unsupported") {
    return;
  }

  target.push(...records);
}

export function withInferredModelFamilyCapabilities(
  modelId: string,
  capabilities: readonly CapabilityRecord[],
  options: InferModelFamilyCapabilitiesOptions = {},
): CapabilityRecord[] {
  const inferred = inferGemmaMultimodalSupport(modelId, options.displayName);
  if (!inferred) {
    return [...capabilities];
  }

  const next = [...capabilities];
  const sourceDetails = {
    modelId,
    displayName: options.displayName,
    family: "gemma",
  };

  if (options.allowImage !== false && inferred.image) {
    pushCapabilityIfUndecided(next, ATTACHMENT_CAPABILITY_IDS.image, [
      {
        id: "model.vision",
        scope: "model",
        status: "supported",
        source: MODEL_FAMILY_INFERENCE_SOURCE,
        notes: [MODEL_FAMILY_INFERENCE_NOTE],
        raw: sourceDetails,
      },
      {
        id: CANONICAL_ATTACHMENT_CAPABILITY_IDS.image,
        scope: "model",
        status: "supported",
        source: MODEL_FAMILY_INFERENCE_SOURCE,
        notes: [MODEL_FAMILY_INFERENCE_NOTE],
        raw: sourceDetails,
      },
    ]);
  }

  if (options.allowAudio !== false) {
    pushCapabilityIfUndecided(next, ATTACHMENT_CAPABILITY_IDS.audio, [
      {
        id: "model.audio",
        scope: "model",
        status: inferred.audio ? "supported" : "unsupported",
        source: MODEL_FAMILY_INFERENCE_SOURCE,
        notes: [MODEL_FAMILY_INFERENCE_NOTE],
        raw: sourceDetails,
      },
      {
        id: CANONICAL_ATTACHMENT_CAPABILITY_IDS.audio,
        scope: "model",
        status: inferred.audio ? "supported" : "unsupported",
        source: MODEL_FAMILY_INFERENCE_SOURCE,
        notes: [MODEL_FAMILY_INFERENCE_NOTE],
        raw: sourceDetails,
      },
    ]);
  }

  if (inferred.image || inferred.audio) {
    pushCapabilityIfUndecided(next, ["model.multimodal"], [{
      id: "model.multimodal",
      scope: "model",
      status: "supported",
      source: MODEL_FAMILY_INFERENCE_SOURCE,
      notes: [MODEL_FAMILY_INFERENCE_NOTE],
      raw: sourceDetails,
    }]);
  }

  return next;
}

export function contentPartsToText(parts: ContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      const kind = contentPartToAttachmentKind(part);
      return kind ? `[${kind}:${part.url}]` : "";
    })
    .join("\n");
}

export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

const INVALID_JSON = Symbol("gemmaDesktop.invalid_json");

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function repairJsonLikeString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\""))) {
    return undefined;
  }

  let repaired = "";
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of trimmed) {
    if (inString) {
      repaired += char;
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
      repaired += char;
      continue;
    }

    if (char === "{") {
      closers.push("}");
      repaired += char;
      continue;
    }

    if (char === "[") {
      closers.push("]");
      repaired += char;
      continue;
    }

    if (char === "}" || char === "]") {
      if (closers.length === 0) {
        continue;
      }

      while (closers.length > 0 && closers[closers.length - 1] !== char) {
        repaired += closers.pop();
      }

      if (closers.length > 0 && closers[closers.length - 1] === char) {
        closers.pop();
        repaired += char;
      }

      continue;
    }

    repaired += char;
  }

  if (inString) {
    repaired += "\"";
  }

  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  while (closers.length > 0) {
    repaired += closers.pop();
  }

  return repaired;
}

export function parseToolCallInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const direct = safeJsonParse(value, INVALID_JSON);
  if (direct !== INVALID_JSON) {
    return direct;
  }

  const repaired = repairJsonLikeString(value);
  if (!repaired || repaired === value) {
    return value;
  }

  return safeJsonParse(repaired, value);
}

export interface ShellCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunShellCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function terminateChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct child termination when process-group signalling is unavailable.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Best effort.
  }
}

export async function runShellCommand(
  command: string,
  options: RunShellCommandOptions = {},
): Promise<ShellCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: options.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };

    const settleResolve = (result: ShellCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer =
      options.timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateChildProcess(child, "SIGTERM");
          }, options.timeoutMs);

    const abort = () => {
      terminateChildProcess(child, "SIGTERM");
      settleReject(new Error(`Command aborted: ${command}`));
    };

    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      settleReject(error);
    });

    child.on("close", (code) => {
      settleResolve({
        command,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function detectCommandVersion(
  command: string,
  args: string[] = ["--version"],
  timeoutMs = 1500,
): Promise<string | undefined> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`${command} version probe timed out`));
          }, timeoutMs)
        : undefined;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        callback();
      };
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (code) => {
        if (code === 0) {
          finish(() => resolve(output.trim()));
        } else {
          finish(() => reject(new Error(output.trim() || `${command} exited with code ${code}`)));
        }
      });
    });
    return result || undefined;
  } catch {
    return undefined;
  }
}
