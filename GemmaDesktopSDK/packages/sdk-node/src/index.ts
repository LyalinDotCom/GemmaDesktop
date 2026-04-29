import { mkdir, readFile, writeFile as writeWorkspaceFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SessionCompactionOptions,
  SessionCompactionResult,
  SessionCompactionState,
  SessionSnapshot,
  StructuredOutputSpec,
  ToolSubsessionRequest,
  ToolSubsessionResult,
} from "@gemma-desktop/sdk-core";
import {
  FINALIZE_BUILD_TOOL_NAME,
  GemmaDesktopError,
  buildFileEditArtifact,
  composeSystemPrompt,
  createEvent,
  isGemma4ModelId,
  renderTrace,
  resolveSessionSystemInstructions,
  runShellCommand,
  SessionEngine,
  type BuildTurnPolicy,
  type BuildTurnPolicyInput,
  type EnvironmentInspectionResult,
  type GemmaDesktopEvent,
  type MachineProfile,
  type ModeSelection,
  type ResolvedSystemInstructionSection,
  type RuntimeAdapter,
  type RuntimeInspectionResult,
  type SessionInput,
  type SessionMessage,
  type SessionTurnOptions,
  type ToolDefinition,
  type TurnResult,
} from "@gemma-desktop/sdk-core";
import { HarnessRunner } from "@gemma-desktop/sdk-harness";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createLmStudioNativeAdapter, createLmStudioOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createOllamaNativeAdapter, createOllamaOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import {
  ToolRegistry,
  ToolRuntime,
  createHostTools,
  type RegisteredTool,
  type ToolPermissionPolicy,
} from "@gemma-desktop/sdk-tools";
import { extractPdfText as extractPdfTextFromPdf } from "./pdf.js";
import { ResearchRunner, type ResearchRunOptions, type ResearchRunResult } from "./research.js";
export {
  PDF_RENDERER_INFO,
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
  type ExtractPdfTextOptions,
  type ExtractedPdfTextPage,
  type PdfTextExtractionResult,
  type PdfDocumentInfo,
  type RenderedPdfPage,
  type RenderPdfPagesOptions,
} from "./pdf.js";
export type {
  ResearchRunOptions,
  ResearchRunResult,
  ResearchRunStatus,
  ResearchSourceFamily,
} from "./research.js";

const INTERNAL_WORKER_MODE = "tool-worker";
const SHARED_COWORK_TOOLS = [
  "list_tree",
  "search_paths",
  "search_text",
  "inspect_file",
  "extract_pdf_text",
  "materialize_content",
  "read_content",
  "search_content",
  "read_file",
  "read_files",
  "fetch_url",
  "search_web",
  "workspace_inspector_agent",
  "workspace_search_agent",
  "web_research_agent",
] as const;

const DEFAULT_MODE_PRESETS: Record<string, string[]> = {
  minimal: [],
  assistant: [...SHARED_COWORK_TOOLS],
  explore: [...SHARED_COWORK_TOOLS],
  cowork: [...SHARED_COWORK_TOOLS],
  plan: [...SHARED_COWORK_TOOLS],
  planner: [...SHARED_COWORK_TOOLS],
  build: [
    ...SHARED_COWORK_TOOLS,
    "write_file",
    "edit_file",
    "exec_command",
    FINALIZE_BUILD_TOOL_NAME,
    "workspace_editor_agent",
    "workspace_command_agent",
  ],
  [INTERNAL_WORKER_MODE]: [],
};

const DELEGATED_WORKER_PROMPT = [
  "Favor the smallest safe action set.",
  "If structured output is requested, return valid compact output.",
].join("\n");
const WEB_RESEARCH_WORKER_PROMPT = [
  "If the goal names outlets, publications, or sites, gather evidence from each named source directly instead of inferring one outlet from another.",
  "Use search_web first only when you still need to discover the right page, current headline cluster, or canonical domain.",
  "Once you know the outlet page you need, prefer one direct fetch_url_safe call for that outlet over more blended searches.",
  "When the goal is a latest-coverage scan or broad headline comparison, default search_web calls to depth \"quick\" and narrow them with outlet domains when helpful.",
  "If quick-search snippets already answer the goal, do not fetch extra pages just to restate them.",
  "When page reads are needed, use fetch_url_safe sparingly. For named-outlet comparisons, one direct fetch per named outlet is usually enough.",
  "Do not use third-party aggregators as stand-ins for a named outlet unless direct fetches fail, and if you use a fallback say so plainly.",
  "Keep enough budget for a final synthesis step. Do not spend the last available step on another fetch when the answer is already grounded.",
  "Do not browse recursively or keep searching once the requested comparison is answerable.",
  "Return a short synthesis and the exact URLs you actually used.",
].join("\n");
const DEFAULT_DELEGATED_WEB_RESEARCH_TIMEOUT_MS = 3 * 60_000;
const MAX_DELEGATED_WEB_RESEARCH_ASSISTANT_CHARS = 8_000;
const WEB_RESEARCH_TOOL_NAMES = new Set(["search_web", "fetch_url_safe", "fetch_url"]);

function resolveToolPath(workingDirectory: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(workingDirectory, inputPath);
}

function createNodeContentTools(): RegisteredTool[] {
  return [
    {
      name: "extract_pdf_text",
      description:
        "Direct tool. Extract embedded text from a known local PDF file. Optionally write the extracted text to a local text artifact for later read_content or search_content calls.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          outputPath: { type: "string" },
          startPage: { type: "integer", minimum: 1 },
          endPage: { type: "integer", minimum: 1 },
          maxChars: { type: "integer", minimum: 100, maximum: 50000 },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          path: string;
          outputPath?: string;
          startPage?: number;
          endPage?: number;
          maxChars?: number;
        },
        context,
      ) {
        const sourcePath = resolveToolPath(context.workingDirectory, input.path);
        const result = await extractPdfTextFromPdf({
          path: sourcePath,
          ...(input.startPage ? { startPage: input.startPage } : {}),
          ...(input.endPage ? { endPage: input.endPage } : {}),
        });
        const outputPath = input.outputPath?.trim()
          ? resolveToolPath(context.workingDirectory, input.outputPath)
          : undefined;

        if (outputPath) {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeWorkspaceFile(outputPath, result.text, "utf8");
        }

        const maxChars = input.maxChars ?? 12_000;
        const preview = result.text.slice(0, maxChars);
        return {
          output: [
            "Extracted PDF text.",
            `Source: ${sourcePath}`,
            outputPath ? `Artifact path: ${outputPath}` : undefined,
            `Pages: ${result.pageCount}`,
            `Extracted characters: ${result.extractedCharCount}`,
            "",
            preview,
            result.text.length > preview.length ? "\n[truncated]" : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          structuredOutput: {
            sourcePath,
            ...(outputPath ? { artifactPath: outputPath } : {}),
            pageCount: result.pageCount,
            extractedCharCount: result.extractedCharCount,
            pages: result.pages.map((page) => ({
              pageNumber: page.pageNumber,
              charCount: page.charCount,
            })),
          },
          metadata: {
            truncated: result.text.length > preview.length,
          },
        };
      },
    },
  ];
}

interface WebResearchOutletHint {
  name: string;
  pattern: RegExp;
  primaryUrl: string;
  fallbackUrl?: string;
}

const WEB_RESEARCH_OUTLET_HINTS: WebResearchOutletHint[] = [
  {
    name: "MSNBC",
    pattern: /\bmsnbc\b/i,
    primaryUrl: "https://www.msnbc.com/",
    fallbackUrl: "https://www.nbcnews.com/",
  },
  {
    name: "Fox News",
    pattern: /\bfox\s*news\b|\bfoxnews\b/i,
    primaryUrl: "https://www.foxnews.com/",
  },
  {
    name: "CNN",
    pattern: /\bcnn\b/i,
    primaryUrl: "https://www.cnn.com/",
  },
];

function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(createHostTools());
  registry.registerMany(createNodeContentTools());
  registry.registerMany(createDelegatedTools());
  return registry;
}

export interface SessionDebugSnapshot {
  sessionId: string;
  runtimeId: string;
  modelId: string;
  mode: ModeSelection;
  workingDirectory: string;
  savedAt: string;
  started: boolean;
  maxSteps: number;
  buildPolicy?: BuildTurnPolicy;
  compaction?: SessionCompactionState;
  metadata?: Record<string, unknown>;
  historyMessageCount: number;
  toolNames: string[];
  tools: ToolDefinition[];
  systemPromptSections: ResolvedSystemInstructionSection[];
  systemPrompt: string;
  requestPreview: {
    model: string;
    messages: Array<{
      role: SessionMessage["role"];
      content: SessionMessage["content"];
      name?: string;
      toolCallId?: string;
      toolCalls?: SessionMessage["toolCalls"];
      metadata?: SessionMessage["metadata"];
    }>;
    tools: ToolDefinition[];
    settings: Record<string, unknown>;
  };
}

function buildRequestPreviewSettings(
  mode: ModeSelection,
  metadata: Record<string, unknown> | undefined,
  modelId?: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    mode: structuredClone(mode),
    sessionMetadata: metadata ? structuredClone(metadata) : undefined,
  };
  const preferencesValue = metadata?.requestPreferences;
  const preferences =
    preferencesValue && typeof preferencesValue === "object" && !Array.isArray(preferencesValue)
      ? preferencesValue as Record<string, unknown>
      : undefined;
  if (modelId && isGemma4ModelId(modelId)) {
    settings.reasoningMode = "on";
  } else if (preferences?.reasoningMode === "auto" || preferences?.reasoningMode === "on") {
    settings.reasoningMode = preferences.reasoningMode;
  }
  const ollamaOptions =
    preferences?.ollamaOptions && typeof preferences.ollamaOptions === "object" && !Array.isArray(preferences.ollamaOptions)
      ? Object.fromEntries(
          Object.entries(preferences.ollamaOptions as Record<string, unknown>).filter(([, value]) =>
            typeof value === "number" && Number.isFinite(value),
          ),
        )
      : undefined;
  if (ollamaOptions && Object.keys(ollamaOptions).length > 0) {
    settings.ollamaOptions = structuredClone(ollamaOptions);
  }
  if (typeof preferences?.ollamaKeepAlive === "string" && preferences.ollamaKeepAlive.trim().length > 0) {
    settings.ollamaKeepAlive = preferences.ollamaKeepAlive.trim();
  }
  return settings;
}

function resolveNamedWebResearchOutlets(goal: string): WebResearchOutletHint[] {
  return WEB_RESEARCH_OUTLET_HINTS.filter((outlet) => outlet.pattern.test(goal));
}

function buildWebResearchPrompt(goal: string): string {
  const outlets = resolveNamedWebResearchOutlets(goal);
  const lines = [
    "Research the web for this goal and return only the essentials.",
  ];

  if (outlets.length > 0) {
    lines.push(
      "The goal names specific outlets. Compare those named outlets directly instead of using unrelated aggregators as stand-ins.",
    );
    for (const outlet of outlets) {
      lines.push(
        outlet.fallbackUrl
          ? `Prefer fetching ${outlet.name} directly from ${outlet.primaryUrl}. If that page is blocked or thin, use ${outlet.fallbackUrl} as the canonical fallback and say that you used the fallback.`
          : `Prefer fetching ${outlet.name} directly from ${outlet.primaryUrl}.`,
      );
    }
  }

  lines.push(
    "If direct outlet pages are enough, stop after you can compare the named outlets confidently.",
    "Goal:",
    goal,
  );

  return lines.join("\n");
}

function buildSessionDebugSnapshot(
  snapshot: SessionSnapshot,
  registry: ToolRegistry,
): SessionDebugSnapshot {
  const toolNames = resolveModeToolNames(snapshot.mode);
  const tools = toolNames.length > 0 ? registry.definitions(toolNames) : [];
  const capabilityContext =
    snapshot.capabilityContext
    && snapshot.capabilityContext.modelId === snapshot.modelId
    && snapshot.capabilityContext.runtime.id === snapshot.runtimeId
      ? snapshot.capabilityContext
      : undefined;
  const systemPromptSections = resolveSessionSystemInstructions({
    modelId: snapshot.modelId,
    mode: snapshot.mode,
    workingDirectory: snapshot.workingDirectory,
    capabilityContext,
    systemInstructions: snapshot.systemInstructions,
    history: snapshot.history,
    availableTools: toolNames,
  });
  const systemPrompt = composeSystemPrompt(systemPromptSections);

  return {
    sessionId: snapshot.sessionId,
    runtimeId: snapshot.runtimeId,
    modelId: snapshot.modelId,
    mode: structuredClone(snapshot.mode),
    workingDirectory: snapshot.workingDirectory,
    savedAt: snapshot.savedAt,
    started: snapshot.started,
    maxSteps: snapshot.maxSteps,
    buildPolicy: snapshot.buildPolicy ? structuredClone(snapshot.buildPolicy) : undefined,
    compaction: snapshot.compaction ? structuredClone(snapshot.compaction) : undefined,
    metadata: snapshot.metadata ? structuredClone(snapshot.metadata) : undefined,
    historyMessageCount: snapshot.history.length,
    toolNames,
    tools: structuredClone(tools),
    systemPromptSections,
    systemPrompt: systemPrompt ?? "",
    requestPreview: {
      model: snapshot.modelId,
      messages: [
        ...(systemPrompt
          ? [{
              role: "system" as const,
              content: [{ type: "text" as const, text: systemPrompt }],
              metadata: {
                sources: systemPromptSections.map((section) =>
                  section.id ? `${section.source}:${section.id}` : section.source,
                ),
              },
            }]
          : []),
        ...snapshot.history.map((message) => ({
          role: message.role,
          content: structuredClone(message.content),
          name: message.name,
          toolCallId: message.toolCallId,
          toolCalls: message.toolCalls
            ? structuredClone(message.toolCalls)
            : undefined,
          metadata: message.metadata
            ? structuredClone(message.metadata)
            : undefined,
        })),
      ],
      tools: structuredClone(tools),
      settings: {
        ...buildRequestPreviewSettings(snapshot.mode, snapshot.metadata, snapshot.modelId),
        ...(snapshot.buildPolicy
          ? { buildPolicy: structuredClone(snapshot.buildPolicy) }
          : {}),
      },
    },
  };
}

export function describeSessionSnapshot(
  snapshot: SessionSnapshot,
  extraTools: RegisteredTool[] = [],
): SessionDebugSnapshot {
  const registry = createDefaultToolRegistry();
  if (extraTools.length > 0) {
    registry.registerMany(extraTools);
  }
  return buildSessionDebugSnapshot(snapshot, registry);
}

function makeStructuredResponseFormat(
  name: string,
  properties: Record<string, unknown>,
  required: string[],
): StructuredOutputSpec {
  return {
    name,
    strict: false,
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: true,
    },
  };
}

function formatSubsessionOutput(result: ToolSubsessionResult): string {
  if (result.structuredOutput && typeof result.structuredOutput === "object") {
    const record = result.structuredOutput as Record<string, unknown>;
    if (typeof record.summary === "string") {
      const extra = [
        Array.isArray(record.filesChanged) ? `Files changed: ${record.filesChanged.join(", ")}` : "",
        Array.isArray(record.evidence) ? `Evidence: ${record.evidence.join(" | ")}` : "",
        Array.isArray(record.sources) ? `Sources: ${record.sources.join(", ")}` : "",
        typeof record.output === "string" ? `Output: ${record.output}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return extra.length > 0 ? `${record.summary}\n${extra}` : record.summary;
    }
  }

  return result.outputText;
}

function collectWebResearchUrl(urls: Set<string>, candidate: unknown): void {
  if (typeof candidate !== "string") {
    return;
  }
  const trimmed = candidate.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    return;
  }
  urls.add(trimmed.replace(/[),.;:!?]+$/u, ""));
}

function collectWebResearchUrlsFromText(urls: Set<string>, text: string): void {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    collectWebResearchUrl(urls, match[0]);
  }
}

function collectWebResearchUrlsFromRecord(
  urls: Set<string>,
  record: Record<string, unknown>,
): void {
  collectWebResearchUrl(urls, record.url);
  collectWebResearchUrl(urls, record.requestedUrl);
  collectWebResearchUrl(urls, record.resolvedUrl);
}

function collectWebResearchSearchPageUrls(
  urls: Set<string>,
  record: Record<string, unknown>,
): void {
  const pages = Array.isArray(record.pages) ? record.pages : [];
  for (const page of pages) {
    if (page && typeof page === "object" && !Array.isArray(page)) {
      collectWebResearchUrlsFromRecord(urls, page as Record<string, unknown>);
    }
  }
}

function inspectWebResearchEvents(
  result: ToolSubsessionResult,
): { toolsUsed: string[]; sourceUrls: string[] } {
  const toolsUsed = new Set<string>();
  const sourceUrls = new Set<string>();

  if (result.structuredOutput && typeof result.structuredOutput === "object" && !Array.isArray(result.structuredOutput)) {
    const record = result.structuredOutput as Record<string, unknown>;
    const sources = Array.isArray(record.sources) ? record.sources : [];
    for (const source of sources) {
      collectWebResearchUrl(sourceUrls, source);
    }
  }
  collectWebResearchUrlsFromText(sourceUrls, result.outputText);

  for (const event of result.events) {
    if (event.type !== "tool.call" && event.type !== "tool.result") {
      continue;
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
    if (!toolName || !WEB_RESEARCH_TOOL_NAMES.has(toolName)) {
      continue;
    }
    toolsUsed.add(toolName);

    if (
      record.structuredOutput
      && typeof record.structuredOutput === "object"
      && !Array.isArray(record.structuredOutput)
    ) {
      const structuredRecord = record.structuredOutput as Record<string, unknown>;
      if (toolName === "fetch_url_safe" || toolName === "fetch_url") {
        collectWebResearchUrlsFromRecord(sourceUrls, structuredRecord);
      }
      if (toolName === "search_web") {
        collectWebResearchSearchPageUrls(sourceUrls, structuredRecord);
      }
    }
  }

  return {
    toolsUsed: [...toolsUsed],
    sourceUrls: [...sourceUrls].slice(0, 10),
  };
}

function normalizeWebResearchResult(
  result: ToolSubsessionResult,
): { summary: string; sources: string[] } {
  const trace = inspectWebResearchEvents(result);
  const record =
    result.structuredOutput && typeof result.structuredOutput === "object" && !Array.isArray(result.structuredOutput)
      ? result.structuredOutput as Record<string, unknown>
      : undefined;
  const structuredSummary =
    typeof record?.summary === "string" ? record.summary.trim() : "";
  const textSummary = result.outputText.trim();
  const summary = structuredSummary || textSummary;
  const sources = Array.isArray(record?.sources)
    ? (record?.sources as unknown[])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  if (trace.toolsUsed.length === 0) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      "Web research agent finished without using search_web or fetch_url_safe.",
    );
  }

  if (summary.length === 0) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      "Web research agent finished without a usable summary.",
    );
  }

  return {
    summary,
    sources: [...new Set([...sources, ...trace.sourceUrls])].slice(0, 10),
  };
}

function resolveWorkspacePath(workingDirectory: string, targetPath: string): string {
  const resolved = path.resolve(workingDirectory, targetPath);
  const relative = path.relative(workingDirectory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GemmaDesktopError("permission_denied", `Refusing to access path outside the working directory: ${targetPath}`);
  }
  return resolved;
}

function normalizeDelegatedWriteContent(content: string): string {
  const actualNewlines = [...content.matchAll(/\n/g)].length;
  const escapedNewlines = [...content.matchAll(/\\+n/g)].length;

  if (actualNewlines === 0 && escapedNewlines >= 2) {
    return content.replace(/\\+r\\+n/g, "\n").replace(/\\+n/g, "\n");
  }

  return content;
}

async function applyDelegatedWrites(
  workingDirectory: string,
  writes: Array<{ path: string; content: string }>,
): Promise<Array<{ path: string; bytes: number; edit?: ReturnType<typeof buildFileEditArtifact> }>> {
  const applied: Array<{ path: string; bytes: number; edit?: ReturnType<typeof buildFileEditArtifact> }> = [];
  for (const write of writes) {
    const resolved = resolveWorkspacePath(workingDirectory, write.path);
    const normalizedContent = normalizeDelegatedWriteContent(write.content);
    let beforeText: string | null | undefined;
    try {
      const existing = await readFile(resolved, "utf8");
      beforeText = existing.includes("\u0000") ? undefined : existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        beforeText = null;
      } else {
        throw error;
      }
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeWorkspaceFile(resolved, normalizedContent, "utf8");
    const relativePath = path.relative(workingDirectory, resolved) || path.basename(resolved);
    const edit =
      beforeText !== undefined
        ? buildFileEditArtifact({
            path: relativePath,
            beforeText,
            afterText: normalizedContent,
            changeType: beforeText == null ? "created" : "edited",
          })
        : undefined;
    applied.push({
      path: relativePath,
      bytes: normalizedContent.length,
      ...(edit ? { edit } : {}),
    });
  }
  return applied;
}

function createDelegatedSubsessionHooks(
  context: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    emit?: (event: GemmaDesktopEvent) => void;
  },
  toolName: string,
  goal?: string,
): {
  onSessionStarted: NonNullable<ToolSubsessionRequest["onSessionStarted"]>;
  onEvent: NonNullable<ToolSubsessionRequest["onEvent"]>;
  emitCompleted: () => void;
} {
  let childSessionId: string | undefined;
  let childTurnId: string | undefined;

  return {
    onSessionStarted: ({ sessionId, turnId }) => {
      childSessionId = sessionId;
      childTurnId = turnId;
      context.emit?.(
        createEvent(
          "tool.subsession.started",
          {
            toolName,
            goal,
            childSessionId: sessionId,
            childTurnId: turnId,
          },
          {
            sessionId: context.sessionId,
            turnId: context.turnId,
            parentToolCallId: context.toolCallId,
          },
        ),
      );
    },
    onEvent: (event) => {
      context.emit?.(
        createEvent(
          "tool.subsession.event",
          {
            toolName,
            childSessionId,
            childTurnId,
            childEventType: event.type,
            childPayload: event.payload,
          },
          {
            sessionId: context.sessionId,
            turnId: context.turnId,
            parentToolCallId: context.toolCallId,
          },
          event,
        ),
      );
    },
    emitCompleted: () => {
      context.emit?.(
        createEvent(
          "tool.subsession.completed",
          {
            toolName,
            childSessionId,
            childTurnId,
          },
          {
            sessionId: context.sessionId,
            turnId: context.turnId,
            parentToolCallId: context.toolCallId,
          },
        ),
      );
    },
  };
}

function extractRequestPreferences(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const value = metadata?.requestPreferences;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function buildWebResearchSubsessionMetadata(
  sessionMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parentPreferences = extractRequestPreferences(sessionMetadata);
  return {
    delegatedTool: "web_research_agent",
    requestPreferences: {
      ...(parentPreferences ?? {}),
    },
  };
}

function createDelegatedWebResearchBudgetGuard(options: {
  parentSignal?: AbortSignal;
}): {
  signal: AbortSignal;
  onEvent: (event: { type: string; payload: Record<string, unknown> }) => void;
  cleanup: () => void;
  wrapError: (error: unknown) => unknown;
} {
  const budgetController = new AbortController();
  let assistantChars = 0;
  let budgetFailureMessage: string | undefined;

  const timeoutHandle = setTimeout(() => {
    budgetFailureMessage =
      `Web research agent exceeded the ${Math.ceil(DEFAULT_DELEGATED_WEB_RESEARCH_TIMEOUT_MS / 60_000)} minute time budget while generating its result.`;
    budgetController.abort();
  }, DEFAULT_DELEGATED_WEB_RESEARCH_TIMEOUT_MS);

  const signals = options.parentSignal
    ? [options.parentSignal, budgetController.signal]
    : [budgetController.signal];

  return {
    signal: AbortSignal.any(signals),
    onEvent(event): void {
      if (event.type !== "content.delta") {
        return;
      }
      const channel = typeof event.payload.channel === "string" ? event.payload.channel : undefined;
      const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
      if (channel !== "assistant" || delta.length === 0) {
        return;
      }

      assistantChars += delta.length;
      if (
        assistantChars <= MAX_DELEGATED_WEB_RESEARCH_ASSISTANT_CHARS
        || budgetFailureMessage
      ) {
        return;
      }

      budgetFailureMessage =
        `Web research agent exceeded the ${MAX_DELEGATED_WEB_RESEARCH_ASSISTANT_CHARS.toLocaleString()} character output budget and looks runaway.`;
      budgetController.abort();
    },
    cleanup(): void {
      clearTimeout(timeoutHandle);
    },
    wrapError(error: unknown): unknown {
      if (!budgetFailureMessage) {
        return error;
      }
      return new GemmaDesktopError("tool_execution_failed", budgetFailureMessage);
    },
  };
}

function createDelegatedTools(): RegisteredTool[] {
  return [
    {
      name: "workspace_inspector_agent",
      description:
        "Delegated agent. Starts a child model session with read-only workspace tools to inspect broader repository context and return a compact summary. Use this for exploratory, multi-file inspection, not for reading one known file.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }, context) {
        if (!context.runSubsession) {
          throw new GemmaDesktopError("tool_execution_failed", "Subsession runner is not available for workspace_inspector_agent.");
        }
        const hooks = createDelegatedSubsessionHooks(context, "workspace_inspector_agent", input.goal);
        const result = await context.runSubsession({
          prompt: `Inspect the workspace and satisfy this goal:\n${input.goal}`,
          mode: {
            base: INTERNAL_WORKER_MODE,
            tools: [
              "list_tree",
              "search_paths",
              "search_text",
              "materialize_content",
              "read_content",
              "search_content",
              "read_file",
              "read_files",
            ],
          },
          systemInstructions: DELEGATED_WORKER_PROMPT,
          responseFormat: makeStructuredResponseFormat(
            "workspace_inspection",
            {
              summary: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
            },
            ["summary"],
          ),
          maxSteps: 4,
          metadata: {
            delegatedTool: "workspace_inspector_agent",
          },
          onSessionStarted: hooks.onSessionStarted,
          onEvent: hooks.onEvent,
        });
        hooks.emitCompleted();
        return {
          output: formatSubsessionOutput(result),
          structuredOutput: result.structuredOutput,
          metadata: {
            childSessionId: result.sessionId,
            childTurnId: result.turnId,
            childTrace: renderTrace(result.events),
          },
        };
      },
    },
    {
      name: "workspace_search_agent",
      description:
        "Delegated agent. Starts a child model session with read-only workspace tools to search across the codebase and summarize relevant findings. Use this for multi-step search or synthesis, not for one direct grep or file read.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }, context) {
        if (!context.runSubsession) {
          throw new GemmaDesktopError("tool_execution_failed", "Subsession runner is not available for workspace_search_agent.");
        }
        const hooks = createDelegatedSubsessionHooks(context, "workspace_search_agent", input.goal);
        const result = await context.runSubsession({
          prompt: `Search the workspace to satisfy this goal:\n${input.goal}`,
          mode: {
            base: INTERNAL_WORKER_MODE,
            tools: [
              "list_tree",
              "search_paths",
              "search_text",
              "materialize_content",
              "read_content",
              "search_content",
              "read_file",
              "read_files",
            ],
          },
          systemInstructions: DELEGATED_WORKER_PROMPT,
          responseFormat: makeStructuredResponseFormat(
            "workspace_search",
            {
              summary: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
            },
            ["summary"],
          ),
          maxSteps: 4,
          metadata: {
            delegatedTool: "workspace_search_agent",
          },
          onSessionStarted: hooks.onSessionStarted,
          onEvent: hooks.onEvent,
        });
        hooks.emitCompleted();
        return {
          output: formatSubsessionOutput(result),
          structuredOutput: result.structuredOutput,
          metadata: {
            childSessionId: result.sessionId,
            childTurnId: result.turnId,
            childTrace: renderTrace(result.events),
          },
        };
      },
    },
    {
      name: "workspace_editor_agent",
      description:
        "Delegated agent. Starts a child model session to plan workspace edits or file creation, then applies the returned writes. Use this for broader editing goals that may span files, not for one known write or exact text replacement.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }, context) {
        if (!context.runSubsession) {
          throw new GemmaDesktopError("tool_execution_failed", "Subsession runner is not available for workspace_editor_agent.");
        }
        const hooks = createDelegatedSubsessionHooks(context, "workspace_editor_agent", input.goal);
        const result = await context.runSubsession({
          prompt: [
            "Decide the concrete file writes needed for this goal.",
            "Creating new files and directories is valid when the user asks for them.",
            "You do not need prior workspace evidence before creating a brand-new user-requested artifact.",
            "Do not claim a file changed unless you return that file in writes[].",
            "Preserve exact user-provided file and directory names. Do not silently fix typos in paths.",
            "Prefer relative paths rooted at the workspace when you return writes[].",
            "Goal:",
            input.goal,
          ].join("\n"),
          mode: {
            base: INTERNAL_WORKER_MODE,
            tools: [
              "list_tree",
              "search_paths",
              "search_text",
              "materialize_content",
              "read_content",
              "search_content",
              "read_file",
              "read_files",
            ],
          },
          systemInstructions: `${DELEGATED_WORKER_PROMPT}\nRead existing files before editing them. Return the exact file contents to write.\nUse real newline characters inside file content instead of escaped \\n sequences whenever possible.`,
          responseFormat: makeStructuredResponseFormat(
            "workspace_edit",
            {
              summary: { type: "string" },
              writes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["path", "content"],
                  additionalProperties: false,
                },
              },
              filesChanged: { type: "array", items: { type: "string" } },
            },
            ["summary"],
          ),
          maxSteps: 6,
          metadata: {
            delegatedTool: "workspace_editor_agent",
          },
          onSessionStarted: hooks.onSessionStarted,
          onEvent: hooks.onEvent,
        });
        hooks.emitCompleted();
        const record = (result.structuredOutput ?? {}) as Record<string, unknown>;
        const writes = Array.isArray(record.writes)
          ? (record.writes as Array<Record<string, unknown>>)
              .filter((write) => typeof write.path === "string" && typeof write.content === "string")
              .map((write) => ({
                path: write.path as string,
                content: write.content as string,
              }))
          : [];
        const appliedWrites = await applyDelegatedWrites(context.workingDirectory, writes);
        return {
          output:
            appliedWrites.length > 0
              ? `${String(record.summary ?? formatSubsessionOutput(result))}\nFiles changed: ${appliedWrites.map((write) => write.path).join(", ")}`
              : formatSubsessionOutput(result),
          structuredOutput: {
            ...record,
            appliedWrites,
          },
          metadata: {
            childSessionId: result.sessionId,
            childTurnId: result.turnId,
            childTrace: renderTrace(result.events),
          },
        };
      },
    },
    {
      name: "workspace_command_agent",
      description:
        "Delegated agent. Starts a child model session to inspect the workspace, choose the shell commands needed for the goal, and return a compact result after those commands are executed. Use this when command selection depends on repository context, not when the exact command is already known.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }, context) {
        if (!context.runSubsession) {
          throw new GemmaDesktopError("tool_execution_failed", "Subsession runner is not available for workspace_command_agent.");
        }
        const hooks = createDelegatedSubsessionHooks(context, "workspace_command_agent", input.goal);
        const result = await context.runSubsession({
          prompt: [
            "Inspect the workspace and decide the exact shell commands needed for this goal.",
            "Do not claim a command ran unless you return it in commands[].",
            "Preserve exact user-provided file and directory names. Do not silently fix typos in paths.",
            "Goal:",
            input.goal,
          ].join("\n"),
          mode: {
            base: INTERNAL_WORKER_MODE,
            tools: [
              "read_file",
              "read_files",
              "materialize_content",
              "read_content",
              "search_content",
              "list_tree",
              "search_paths",
              "search_text",
            ],
          },
          systemInstructions: `${DELEGATED_WORKER_PROMPT}\nReturn the smallest safe command list. Use relative cwd values when helpful.\nAvoid destructive commands unless the goal clearly requires them.`,
          responseFormat: makeStructuredResponseFormat(
            "workspace_command",
            {
              summary: { type: "string" },
              commands: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    cwd: { type: "string" },
                  },
                  required: ["command"],
                  additionalProperties: false,
                },
              },
            },
            ["summary"],
          ),
          maxSteps: 4,
          metadata: {
            delegatedTool: "workspace_command_agent",
          },
          onSessionStarted: hooks.onSessionStarted,
          onEvent: hooks.onEvent,
        });
        hooks.emitCompleted();
        const record = (result.structuredOutput ?? {}) as Record<string, unknown>;
        const commands = Array.isArray(record.commands)
          ? (record.commands as Array<Record<string, unknown>>)
              .filter((command) => typeof command.command === "string")
              .map((command) => ({
                command: command.command as string,
                cwd: typeof command.cwd === "string" ? command.cwd : undefined,
              }))
          : [];
        const executions = [];
        for (const command of commands) {
          const cwd = command.cwd ? resolveWorkspacePath(context.workingDirectory, command.cwd) : context.workingDirectory;
          executions.push(
            await runShellCommand(command.command, {
              cwd,
              signal: context.signal,
              timeoutMs: 30_000,
            }),
          );
        }
        const mergedOutput = executions
          .map((execution) => [execution.stdout.trim(), execution.stderr.trim()].filter(Boolean).join("\n"))
          .filter(Boolean)
          .join("\n\n");
        return {
          output:
            mergedOutput.length > 0
              ? `${String(record.summary ?? formatSubsessionOutput(result))}\n${mergedOutput}`
              : formatSubsessionOutput(result),
          structuredOutput: {
            ...record,
            executions,
          },
          metadata: {
            childSessionId: result.sessionId,
            childTurnId: result.turnId,
            childTrace: renderTrace(result.events),
          },
        };
      },
    },
    {
      name: "web_research_agent",
      description:
        "Delegated agent. Starts a child model session that can search the web and fetch pages, then returns a synthesized result with sources. Use this for multi-source research, comparison, or synthesis, not for one search or one page fetch.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }, context) {
        if (!context.runSubsession) {
          throw new GemmaDesktopError("tool_execution_failed", "Subsession runner is not available for web_research_agent.");
        }
        const hooks = createDelegatedSubsessionHooks(context, "web_research_agent", input.goal);
        const budgetGuard = createDelegatedWebResearchBudgetGuard({
          parentSignal: context.signal,
        });
        try {
          const result = await context.runSubsession({
            prompt: buildWebResearchPrompt(input.goal),
            mode: {
              base: INTERNAL_WORKER_MODE,
              tools: ["search_web", "fetch_url_safe"],
            },
            systemInstructions: `${DELEGATED_WORKER_PROMPT}\n${WEB_RESEARCH_WORKER_PROMPT}\nCite only the sources you actually used.`,
            responseFormat: makeStructuredResponseFormat(
              "web_research",
              {
                summary: { type: "string", maxLength: 3_000 },
                sources: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 10,
                },
              },
              ["summary"],
            ),
            maxSteps: 7,
            metadata: buildWebResearchSubsessionMetadata(context.sessionMetadata),
            signal: budgetGuard.signal,
            onSessionStarted: hooks.onSessionStarted,
            onEvent: async (event) => {
              budgetGuard.onEvent(event);
              await hooks.onEvent(event);
            },
          });
          const normalized = normalizeWebResearchResult(result);
          hooks.emitCompleted();
          return {
            output:
              normalized.sources.length > 0
                ? `${normalized.summary}\nSources: ${normalized.sources.join(", ")}`
                : normalized.summary,
            structuredOutput: {
              ...(result.structuredOutput && typeof result.structuredOutput === "object" && !Array.isArray(result.structuredOutput)
                ? result.structuredOutput as Record<string, unknown>
                : {}),
              summary: normalized.summary,
              sources: normalized.sources,
            },
            metadata: {
              childSessionId: result.sessionId,
              childTurnId: result.turnId,
              childTrace: renderTrace(result.events),
            },
          };
        } catch (error) {
          throw budgetGuard.wrapError(error);
        } finally {
          budgetGuard.cleanup();
        }
      },
    },
  ];
}

function resolveModeToolNames(mode: ModeSelection): string[] {
  const spec = typeof mode === "string" ? { base: mode } : mode;
  const base = spec.base ?? "explore";
  const preset = DEFAULT_MODE_PRESETS[base];
  if (!preset) {
    throw new GemmaDesktopError("runtime_mode_unsupported", `Unknown mode preset "${base}".`);
  }

  const names = new Set<string>(preset);
  for (const name of spec.tools ?? []) {
    names.add(name);
  }
  for (const name of spec.withoutTools ?? []) {
    names.delete(name);
  }
  return [...names];
}

export interface CreateGemmaDesktopOptions {
  workingDirectory?: string;
  adapters?: RuntimeAdapter[];
  toolPolicy?: ToolPermissionPolicy;
  extraTools?: RegisteredTool[];
  geminiApiKey?: string;
  geminiApiModel?: string;
}

export interface CreateSessionOptions {
  runtime: string;
  model: string;
  mode: ModeSelection;
  workingDirectory?: string;
  systemInstructions?: string;
  metadata?: Record<string, unknown>;
  toolPolicy?: ToolPermissionPolicy;
  maxSteps?: number;
  buildPolicy?: BuildTurnPolicyInput;
  geminiApiKey?: string;
  geminiApiModel?: string;
}

export interface ResumeSessionOptions {
  snapshot: SessionSnapshot;
  toolPolicy?: ToolPermissionPolicy;
}

export class GemmaDesktopSession {
  private readonly engine: SessionEngine;
  private readonly researchRunner?: (snapshot: SessionSnapshot, input: SessionInput, options: ResearchRunOptions) => Promise<ResearchRunResult>;

  public constructor(
    engine: SessionEngine,
    researchRunner?: (snapshot: SessionSnapshot, input: SessionInput, options: ResearchRunOptions) => Promise<ResearchRunResult>,
  ) {
    this.engine = engine;
    this.researchRunner = researchRunner;
  }

  public get id(): string {
    return this.engine.sessionId;
  }

  public async run(input: SessionInput, options: SessionTurnOptions = {}): Promise<TurnResult> {
    return await this.engine.run(input, options);
  }

  public async runStreamed(input: SessionInput, options: SessionTurnOptions = {}) {
    return await this.engine.runStreamed(input, options);
  }

  public async compact(options: SessionCompactionOptions = {}): Promise<SessionCompactionResult> {
    return await this.engine.compact(options);
  }

  public async runResearch(
    input: SessionInput,
    options: ResearchRunOptions = {},
  ): Promise<ResearchRunResult> {
    if (!this.researchRunner) {
      throw new GemmaDesktopError("runtime_unavailable", "Research runner is not available for this session.");
    }
    return await this.researchRunner(this.engine.snapshot(), input, options);
  }

  public snapshot(): SessionSnapshot {
    return this.engine.snapshot();
  }
}

export class GemmaDesktop {
  public readonly harness: HarnessRunner;
  public readonly sessions: {
    create: (options: CreateSessionOptions) => Promise<GemmaDesktopSession>;
    resume: (options: ResumeSessionOptions) => Promise<GemmaDesktopSession>;
  };

  private readonly workingDirectory: string;
  private readonly adapters: Map<string, RuntimeAdapter>;
  private readonly registry: ToolRegistry;
  private readonly toolPolicy?: ToolPermissionPolicy;
  private geminiApiKey?: string;
  private geminiApiModel?: string;
  private readonly capabilityContextCache = new Map<string, Promise<SessionSnapshot["capabilityContext"]>>();

  public constructor(options: CreateGemmaDesktopOptions = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.adapters = new Map(
      (options.adapters ?? [
        createOllamaNativeAdapter(),
        createOllamaOpenAICompatibleAdapter(),
        createLmStudioNativeAdapter(),
        createLmStudioOpenAICompatibleAdapter(),
        createLlamaCppServerAdapter(),
      ]).map((adapter) => [adapter.identity.id, adapter]),
    );
    this.toolPolicy = options.toolPolicy;
    this.geminiApiKey = options.geminiApiKey;
    this.geminiApiModel = options.geminiApiModel;
    this.registry = createDefaultToolRegistry();
    if (options.extraTools && options.extraTools.length > 0) {
      this.registry.registerMany(options.extraTools);
    }

    this.sessions = {
      create: async (sessionOptions) => await this.createSession(sessionOptions),
      resume: async (sessionOptions) => await this.resumeSession(sessionOptions),
    };

    this.harness = new HarnessRunner({
      factory: {
        create: async (input) => await this.createSession(input),
      },
    });
  }

  public async inspectEnvironment(): Promise<EnvironmentInspectionResult> {
    const machine = this.inspectMachine();
    const runtimes = await Promise.all([...this.adapters.values()].map(async (adapter) => await adapter.inspect()));
    const warnings = runtimes.flatMap((runtime) => runtime.warnings);
    const diagnosis = runtimes.flatMap((runtime) => runtime.diagnosis);
    return {
      inspectedAt: new Date().toISOString(),
      machine,
      runtimes,
      warnings,
      diagnosis,
    };
  }

  public async listAvailableRuntimes(): Promise<RuntimeInspectionResult[]> {
    return await Promise.all([...this.adapters.values()].map(async (adapter) => await adapter.inspect()));
  }

  public describeSession(snapshot: SessionSnapshot): SessionDebugSnapshot {
    return buildSessionDebugSnapshot(snapshot, this.registry);
  }

  public updateIntegrations(options: { geminiApiKey?: string; geminiApiModel?: string }): void {
    this.geminiApiKey = options.geminiApiKey;
    this.geminiApiModel = options.geminiApiModel;
  }

  private async runResearchFromSnapshot(
    snapshot: SessionSnapshot,
    input: SessionInput,
    options: ResearchRunOptions,
  ): Promise<ResearchRunResult> {
    const adapter = this.getAdapter(snapshot.runtimeId);
    const workingDirectory = path.resolve(snapshot.workingDirectory);
    const runner = new ResearchRunner({
      snapshot,
      geminiApiKey: () => this.geminiApiKey,
      geminiApiModel: () => this.geminiApiModel,
      runSubsession: async (request, parentToolCallId) =>
        await this.runSubsession(
          adapter,
          snapshot.modelId,
          workingDirectory,
          request,
          parentToolCallId,
          this.toolPolicy,
          snapshot.metadata,
        ),
    });
    return await runner.run(input, options);
  }

  private inspectMachine(): MachineProfile {
    const cpus = os.cpus();
    return {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      totalMemoryBytes: os.totalmem(),
      cpuModel: cpus[0]?.model,
      cpuCount: cpus.length,
      hostname: os.hostname(),
    };
  }

  private getAdapter(runtimeId: string): RuntimeAdapter {
    const adapter = this.adapters.get(runtimeId);
    if (!adapter) {
      throw new GemmaDesktopError("runtime_unavailable", `Unknown runtime adapter "${runtimeId}".`);
    }
    return adapter;
  }

  private async resolveSessionCapabilityContext(
    adapter: RuntimeAdapter,
    modelId: string,
  ): Promise<SessionSnapshot["capabilityContext"]> {
    const cacheKey = `${adapter.identity.id}:${modelId}`;
    const cached = this.capabilityContextCache.get(cacheKey);
    if (cached) {
      return await cached;
    }

    const lookup = (async () => {
      try {
        const inspection = await adapter.inspect();
        const model = inspection.models.find((candidate) => candidate.id === modelId);
        return {
          runtime: {
            id: inspection.runtime.id,
            displayName: inspection.runtime.displayName,
            family: inspection.runtime.family,
            kind: inspection.runtime.kind,
          },
          modelId,
          runtimeCapabilities: structuredClone(inspection.capabilities),
          modelCapabilities: structuredClone(model?.capabilities ?? []),
        };
      } catch {
        return {
          runtime: {
            id: adapter.identity.id,
            displayName: adapter.identity.displayName,
            family: adapter.identity.family,
            kind: adapter.identity.kind,
          },
          modelId,
          runtimeCapabilities: [],
          modelCapabilities: [],
        };
      }
    })();

    this.capabilityContextCache.set(cacheKey, lookup);
    return await lookup;
  }

  private async runSubsession(
    adapter: RuntimeAdapter,
    model: string,
    workingDirectory: string,
    request: ToolSubsessionRequest,
    parentToolCallId: string,
    toolPolicy?: ToolPermissionPolicy,
    parentMetadata?: Record<string, unknown>,
  ): Promise<ToolSubsessionResult> {
    const childSession = await this.createSession({
      runtime: adapter.identity.id,
      model,
      mode: request.mode ?? INTERNAL_WORKER_MODE,
      workingDirectory,
      systemInstructions: request.systemInstructions,
      metadata: {
        ...(parentMetadata ?? {}),
        ...(request.metadata ?? {}),
        parentToolCallId,
        delegated: true,
      },
      toolPolicy,
      maxSteps: request.maxSteps,
    });

    const streamed = await childSession.runStreamed(request.prompt, {
      responseFormat: request.responseFormat,
      maxSteps: request.maxSteps,
      signal: request.signal,
    });
    await request.onSessionStarted?.({
      sessionId: childSession.id,
      turnId: streamed.turnId,
    });

    const events: GemmaDesktopEvent[] = [];
    for await (const event of streamed.events) {
      events.push(event);
      await request.onEvent?.(event);
    }
    const completed = await streamed.completed;

    return {
      sessionId: childSession.id,
      turnId: completed.turnId,
      events,
      outputText: completed.text,
      structuredOutput: completed.structuredOutput,
      metadata: {
        warnings: completed.warnings,
      },
      snapshot: childSession.snapshot(),
    };
  }

  private async createSession(options: CreateSessionOptions): Promise<GemmaDesktopSession> {
    const adapter = this.getAdapter(options.runtime);
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workingDirectory);
    const capabilityContext = await this.resolveSessionCapabilityContext(
      adapter,
      options.model,
    );
    const toolNames = resolveModeToolNames(options.mode);
    const tools =
      toolNames.length === 0
        ? undefined
        : new ToolRuntime({
            registry: this.registry,
            toolNames,
            policy: options.toolPolicy ?? this.toolPolicy,
          });

    const engine = new SessionEngine({
      adapter,
      model: options.model,
      mode: options.mode,
      workingDirectory,
      capabilityContext,
      tools,
      systemInstructions: options.systemInstructions,
      metadata: options.metadata,
      maxSteps: options.maxSteps,
      buildPolicy: options.buildPolicy,
      geminiApiKey: () => options.geminiApiKey ?? this.geminiApiKey,
      geminiApiModel: () => options.geminiApiModel ?? this.geminiApiModel,
      runSubsession: async (request, parentToolCallId) =>
        await this.runSubsession(
          adapter,
          options.model,
          workingDirectory,
          request,
          parentToolCallId,
          options.toolPolicy ?? this.toolPolicy,
          options.metadata,
        ),
    });

    return new GemmaDesktopSession(
      engine,
      async (snapshot, input, researchOptions) =>
        await this.runResearchFromSnapshot(snapshot, input, researchOptions),
    );
  }

  private async resumeSession(options: ResumeSessionOptions): Promise<GemmaDesktopSession> {
    const snapshot = options.snapshot;
    const adapter = this.getAdapter(snapshot.runtimeId);
    const workingDirectory = path.resolve(snapshot.workingDirectory);
    const snapshotCapabilityContext =
      snapshot.capabilityContext
      && snapshot.capabilityContext.modelId === snapshot.modelId
      && snapshot.capabilityContext.runtime.id === snapshot.runtimeId
        ? snapshot.capabilityContext
        : undefined;
    const capabilityContext =
      snapshotCapabilityContext
      ?? await this.resolveSessionCapabilityContext(adapter, snapshot.modelId);
    const toolNames = resolveModeToolNames(snapshot.mode);
    const tools =
      toolNames.length === 0
        ? undefined
        : new ToolRuntime({
            registry: this.registry,
            toolNames,
            policy: options.toolPolicy ?? this.toolPolicy,
          });

    const engine = new SessionEngine({
      adapter,
      model: snapshot.modelId,
      mode: snapshot.mode,
      workingDirectory,
      capabilityContext,
      tools,
      systemInstructions: snapshot.systemInstructions,
      metadata: snapshot.metadata,
      maxSteps: snapshot.maxSteps,
      sessionId: snapshot.sessionId,
      history: snapshot.history,
      started: snapshot.started,
      compaction: snapshot.compaction,
      buildPolicy: snapshot.buildPolicy,
      geminiApiKey: () => this.geminiApiKey,
      geminiApiModel: () => this.geminiApiModel,
      runSubsession: async (request, parentToolCallId) =>
        await this.runSubsession(
          adapter,
          snapshot.modelId,
          workingDirectory,
          request,
          parentToolCallId,
          options.toolPolicy ?? this.toolPolicy,
          snapshot.metadata,
        ),
    });

    return new GemmaDesktopSession(
      engine,
      async (sessionSnapshot, input, researchOptions) =>
        await this.runResearchFromSnapshot(sessionSnapshot, input, researchOptions),
    );
  }
}

export async function createGemmaDesktop(options: CreateGemmaDesktopOptions = {}): Promise<GemmaDesktop> {
  return new GemmaDesktop(options);
}

export * from "./research.js";
