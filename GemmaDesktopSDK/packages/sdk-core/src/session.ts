import { GemmaDesktopError, toGemmaDesktopError } from "./errors.js";
import type { GemmaDesktopEvent} from "./events.js";
import { createEvent } from "./events.js";
import {
  FINALIZE_BUILD_TOOL_NAME,
  buildFailedBuildVerificationInstruction,
  buildMissingBuildFinalizationInstruction,
  buildMissingBuildVerificationInstruction,
  buildRejectedBuildFinalizationInstruction,
  buildRejectedBuildVerifierInstruction,
  createBuildTurnState,
  evaluateBuildCompletionHeuristically,
  looksLikeExplicitBuildBlocker,
  planBuildVerification,
  recordBuildToolResult,
  resolveBuildTurnPolicy,
  summarizeBuildFinalization,
  summarizeBuildTurn,
  summarizeBuildValidation,
  type BuildCompletionVerifier,
  type BuildCompletionVerifierResult,
  type BuildTurnPolicy,
  type BuildTurnPolicyInput,
  type BuildTurnSummary,
} from "./buildMode.js";
import {
  ATTACHMENT_CAPABILITY_IDS,
  contentPartToAttachmentKind,
  contentPartsToText,
  describeAttachmentKind,
  estimateTextTokens,
  isGemma4ModelId,
  makeId,
  normalizeInput,
  resolveCapabilityStatus,
  safeJsonParse,
  type CapabilityRecord,
  type RuntimeIdentity,
} from "./runtime.js";
import {
  resolvePromptProfileSections,
  renderSystemPromptSection,
  SYSTEM_PROMPT_ROOT_TAG,
  type ResolvedSystemInstructionSection,
} from "./systemPrompts.js";
import type {
  RuntimeAdapter,
  TokenUsage,
  ToolSubsessionRequest,
  ToolSubsessionResult,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelToolCall,
  ModeSelection,
  RuntimeDebugRecorder,
  SessionInput,
  SessionMessage,
  StructuredOutputSpec,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from "./runtime.js";

export interface SessionTurnOptions {
  signal?: AbortSignal;
  responseFormat?: StructuredOutputSpec;
  maxSteps?: number;
  buildPolicy?: BuildTurnPolicyInput;
  debug?: RuntimeDebugRecorder;
}

export interface SessionCompactionOptions {
  signal?: AbortSignal;
  debug?: RuntimeDebugRecorder;
  model?: string;
  keepLastMessages?: number;
  inputTokenLimit?: number;
  instructions?: string;
}

export interface SessionCompactionState {
  count: number;
  lastCompactedAt?: string;
}

export interface SessionEngineOptions {
  adapter: RuntimeAdapter;
  model: string;
  mode: ModeSelection;
  workingDirectory: string;
  capabilityContext?: SessionCapabilityContext;
  tools?: ToolExecutor;
  systemInstructions?: string;
  metadata?: Record<string, unknown>;
  maxSteps?: number;
  buildPolicy?: BuildTurnPolicyInput;
  buildCompletionVerifier?: BuildCompletionVerifier;
  sessionId?: string;
  history?: SessionMessage[];
  started?: boolean;
  compaction?: SessionCompactionState;
  runSubsession?: (request: ToolSubsessionRequest, parentToolCallId: string) => Promise<ToolSubsessionResult>;
  geminiApiKey?: string | (() => string | undefined);
  geminiApiModel?: string | (() => string | undefined);
}

export interface SessionSnapshot {
  schemaVersion: 1 | 2;
  sessionId: string;
  runtimeId: string;
  modelId: string;
  mode: ModeSelection;
  workingDirectory: string;
  capabilityContext?: SessionCapabilityContext;
  systemInstructions?: string;
  metadata?: Record<string, unknown>;
  maxSteps: number;
  buildPolicy?: BuildTurnPolicy;
  history: SessionMessage[];
  started: boolean;
  savedAt: string;
  compaction?: SessionCompactionState;
}

export interface TurnResult {
  sessionId: string;
  turnId: string;
  runtimeId: string;
  modelId: string;
  text: string;
  reasoning?: string;
  usage?: TokenUsage;
  warnings: string[];
  steps: number;
  toolResults: ToolResult[];
  events: GemmaDesktopEvent[];
  structuredOutput?: unknown;
  build?: BuildTurnSummary;
}

export interface StreamedTurnResult {
  turnId: string;
  events: AsyncGenerator<GemmaDesktopEvent>;
  completed: Promise<TurnResult>;
}

export interface SessionCompactionResult {
  sessionId: string;
  runtimeId: string;
  modelId: string;
  compactedAt: string;
  summary: string;
  previousHistoryCount: number;
  retainedMessageCount: number;
  historyCount: number;
}

export interface SessionCapabilityContext {
  runtime: Pick<RuntimeIdentity, "id" | "displayName" | "family" | "kind">;
  modelId: string;
  runtimeCapabilities: CapabilityRecord[];
  modelCapabilities: CapabilityRecord[];
}

class AsyncEventQueue {
  private readonly items: GemmaDesktopEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<GemmaDesktopEvent>) => void> = [];
  private closed = false;

  public push(item: GemmaDesktopEvent): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  public async *stream(): AsyncGenerator<GemmaDesktopEvent> {
    while (true) {
      if (this.items.length > 0) {
        const value = this.items.shift()!;
        yield value;
        continue;
      }

      if (this.closed) {
        break;
      }

      const next = await new Promise<IteratorResult<GemmaDesktopEvent>>((resolve) => {
        this.waiters.push(resolve);
      });

      if (next.done) {
        break;
      }

      yield next.value;
    }
  }
}

function resolveModeBase(mode: ModeSelection): string {
  return typeof mode === "string" ? mode : mode.base ?? "explore";
}

function resolveRequiredTools(mode: ModeSelection): string[] {
  return typeof mode === "string" ? [] : [...(mode.requiredTools ?? [])];
}

function renderPromptBullets(title: string, bullets: Array<string | undefined>): string | undefined {
  const filtered = bullets.filter(
    (bullet): bullet is string => Boolean(bullet && bullet.trim().length > 0),
  );
  if (filtered.length === 0) {
    return undefined;
  }

  return [
    `**${title}:**`,
    ...filtered.map((bullet) => `- ${bullet}`),
  ].join("\n");
}

function buildToolContextInstructions(
  availableTools: readonly string[] = [],
): string | undefined {
  const visibleTools = availableTools.length > 0
    ? `Available tools in this turn: ${availableTools.join(", ")}.`
    : undefined;
  const delegatedAgents = availableTools.filter((toolName) => toolName.endsWith("_agent"));
  const directTools = availableTools.filter((toolName) => !toolName.endsWith("_agent"));
  const hasBrowser = availableTools.includes("browser");
  const hasChromeDevtools = availableTools.includes("chrome_devtools");
  const hasWebToolRoutingSurface =
    availableTools.includes("search_web")
    || availableTools.includes("fetch_url")
    || hasBrowser
    || hasChromeDevtools
    || availableTools.includes("web_research_agent");
  const toolInventory = delegatedAgents.length > 0
    ? [
        `Direct tools in this turn: ${directTools.length > 0 ? directTools.join(", ") : "(none)"}.`,
        `Delegated agent tools in this turn: ${delegatedAgents.join(", ")}.`,
      ].join("\n")
    : undefined;
  const directVsAgentHint = renderPromptBullets("Tool Types", [
    delegatedAgents.length > 0
      ? "Direct tools perform one concrete action immediately. Use them for a single known read, search, fetch, edit, or command."
      : undefined,
    delegatedAgents.length > 0
      ? "Tools whose names end in _agent start a child model session with its own context and tools. Use them only for broader, multi-step, exploratory, or synthesis-heavy goals."
      : undefined,
  ]);
  const webResearchHint = hasWebToolRoutingSurface
    ? renderPromptBullets("Web & Browser Tools", [
        availableTools.includes("search_web")
          ? "Use search_web for discovery when you do not yet know the right source, URL, or site."
          : undefined,
        availableTools.includes("fetch_url")
          ? "Use fetch_url for one known public page, feed, or endpoint when the content is likely readable without page interaction."
          : undefined,
        hasBrowser
          ? "Use browser for one dynamic, interactive, or JavaScript-heavy page, especially site-native trackers, forms, dashboards, or pages that reveal real data only after interaction."
          : undefined,
        hasChromeDevtools
          ? "Use chrome_devtools only for advanced Chrome debugging such as console inspection, network inspection, page evaluation, or when the user explicitly asks for Chrome DevTools."
          : undefined,
        hasBrowser
          ? hasChromeDevtools
            ? "If the user explicitly asks for Chrome DevTools or dev tools and chrome_devtools is available, prefer chrome_devtools for deeper debugging. Use browser for normal site navigation and dynamic page reading."
            : "If the user explicitly says to use a website's own tracker, live status page, browser, or dev tools, prefer browser over repeating search_web."
          : undefined,
        hasBrowser
          ? "After one generic search attempt for a named site or tracker, stop broadening the search and switch to browser unless you still need to discover the exact URL."
          : undefined,
        availableTools.includes("web_research_agent")
          ? "Use web_research_agent only when the task needs several web steps, source comparison, or synthesis across multiple pages."
          : undefined,
      ])
    : undefined;
  const browserHint = hasBrowser
    ? renderPromptBullets("Browser Loop", [
        "Use browser for live sites, dynamic pages, logged-in flows, forms, dashboards, flight trackers, or any page where fetch_url only returns loaders, placeholders, or incomplete text.",
        hasChromeDevtools
          ? "If the user explicitly asks for Chrome DevTools or dev tools and chrome_devtools is available, prefer chrome_devtools for deeper debugging. Otherwise use browser as the fallback."
          : "If the user asks to use Chrome DevTools or dev tools on a real website, that usually means browser.",
        "If the user names a specific site's tracker or status page, go there with browser instead of doing more generic web searches unless you still need to discover the exact URL.",
        "If the user already named the site, stay inside that site flow until you either get the answer or hit a concrete blocker.",
        "If a specific page returns 404, Page Not Found, Unknown Flight, or another thin error shell, keep going inside that site by using its visible navigation, forms, or tracker UI before switching tools.",
        "Project Browser is separate and is only for local app verification on localhost-style URLs.",
        "Start with browser action=\"open\" for a specific site or browser action=\"tabs\" if you need current browser state first.",
        "After opening or navigating a JavaScript-heavy page, use browser action=\"wait\" with waitForLoadState=\"networkidle\" before the next snapshot.",
        "Use browser action=\"snapshot\" before clicking or filling. Snapshot refs go stale after navigation or significant page updates, so call browser action=\"snapshot\" again before the next ref-based step.",
        "When snapshot shows handles like [ref=@e15], pass them back as ref=\"@e15\" for browser click, fill, or targeted type actions.",
        "When the next browser action is obvious from the snapshot, do it now instead of ending the turn with narration like 'I'll check' or 'I'll head there.'",
        "A good dynamic-site loop is: open or navigate -> wait -> snapshot -> click or fill -> wait -> snapshot -> answer or continue.",
        "If a browser attempt fails because the site blocks automation, state that exact blocker plainly instead of falling back to unrelated search results.",
      ])
    : undefined;
  const chromeDevtoolsHint = hasChromeDevtools
    ? renderPromptBullets("Chrome DevTools", [
        "Use chrome_devtools for advanced debugging inside the user's live Chrome session, especially when you need console output, network activity, page evaluation, or tighter control over a Chrome tab.",
        "Prefer browser for ordinary site navigation, trackers, and content reading. Escalate to chrome_devtools when the user explicitly asks for DevTools or when browser is not enough.",
        "Chrome DevTools can open, navigate, snapshot, click, fill, type, press keys, inspect console and network state, and evaluate page scripts against a live Chrome tab.",
        "If chrome_devtools is available and you need deeper debugging on a real site, keep the browser flow grounded in Chrome instead of falling back to generic searches.",
      ])
    : undefined;
  const fileWindowHint =
    (availableTools.includes("read_file") || availableTools.includes("read_files"))
      ? availableTools.includes("search_text")
        ? "read_file and read_files return explicit windows, not magical full-file context. If a read says it was truncated or starts after offset=1, you do not have the whole file. Continue with offset or use search_text to target the relevant section in large text files."
        : "read_file and read_files return explicit windows, not magical full-file context. If a read says it was truncated or starts after offset=1, you do not have the whole file."
      : undefined;
  const smartFileExtractionHint =
    availableTools.includes("read_file")
      ? "For local PDFs, images, and audio files, read_file is the direct extraction path for inspection: it converts the file into cached text and returns a paginated text window. Use shell commands or package installation only after the direct file tools fail or are unavailable."
      : undefined;
  const workspaceHint = renderPromptBullets("Workspace & File Tools", [
    (availableTools.includes("workspace_inspector_agent")
    || availableTools.includes("workspace_search_agent"))
      ? "If the user already named a file or a direct read/search would answer the question, use the direct file tools first."
      : undefined,
    (availableTools.includes("workspace_inspector_agent")
    || availableTools.includes("workspace_search_agent"))
      ? "Use workspace_inspector_agent or workspace_search_agent only when the repository task is broader, exploratory, or spans multiple files."
      : undefined,
    availableTools.includes("list_tree")
      ? "Use list_tree for nearby folder-by-folder browsing. It is intentionally shallow and may collapse large directories, so deeper nested projects may need search_paths. If list_tree returns collapsed or truncated output, do not repeat the same call unchanged."
      : undefined,
    availableTools.includes("search_paths")
      ? "Use search_paths for recursive file or folder discovery by ranked query or deterministic glob when something may be nested deeper in the workspace."
      : undefined,
    availableTools.includes("search_text")
      ? "Use search_text for workspace content search. It defaults to literal matching, which is safer than regex unless you explicitly need regex behavior."
      : undefined,
    availableTools.includes("write_file")
      ? "Use write_file when creating or replacing a file with complete known content."
      : undefined,
    availableTools.includes("edit_file")
      ? "Use edit_file for precise edits to existing files after reading the relevant context."
      : undefined,
    availableTools.includes("materialize_content")
      ? "Use materialize_content when the user asks to extract, convert, OCR, transcribe, or save the full contents of a local source into a text/Markdown artifact."
      : undefined,
    availableTools.includes("materialize_content")
      ? "After materializing a large artifact, use search_content and read_content windows to inspect targeted sections instead of trying to load the whole artifact into context."
      : undefined,
    smartFileExtractionHint,
    fileWindowHint,
  ]);

  return [
    visibleTools,
    toolInventory,
    directVsAgentHint,
    webResearchHint,
    browserHint,
    chromeDevtoolsHint,
    workspaceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEnvironmentInstructions(options: {
  now?: Date;
  timeZone?: string;
}): string {
  const now = options.now ?? new Date();
  const timeZone =
    options.timeZone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateText = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone,
  }).format(now);

  return [
    `Current date: ${dateText}${timeZone ? ` (${timeZone})` : ""}.`,
    "Use this current date when interpreting relative dates such as today, tomorrow, and yesterday.",
  ].join("\n");
}

function buildGemma4ThinkingInstructions(modelId: string): string | undefined {
  if (!isGemma4ModelId(modelId)) {
    return undefined;
  }

  return [
    "<|think|>",
    "Thinking mode is enabled for this Gemma 4 conversation.",
    "Use the native thought channel to reason through tool choices, failures, and self-corrections before taking external actions.",
    "Do not paste raw thought tokens or scratch reasoning into normal assistant text; keep visible answers concise and outcome-focused.",
  ].join("\n");
}

function buildModeInstructions(
  mode: ModeSelection,
  workingDirectory: string,
  availableTools: readonly string[] = [],
): string | undefined {
  const base = resolveModeBase(mode);
  const toolSet = new Set(availableTools);
  const canReadFiles =
    toolSet.has("inspect_file")
    || toolSet.has("read_file")
    || toolSet.has("read_files")
    || toolSet.has("list_tree")
    || toolSet.has("search_paths")
    || toolSet.has("search_text")
    || toolSet.has("workspace_inspector_agent")
    || toolSet.has("workspace_search_agent");
  const canUseWeb =
    toolSet.has("search_web")
    || toolSet.has("fetch_url")
    || toolSet.has("web_research_agent");
  const canEditFiles =
    toolSet.has("write_file")
    || toolSet.has("edit_file")
    || toolSet.has("workspace_editor_agent");
  const canRunCommands =
    toolSet.has("exec_command")
    || toolSet.has("workspace_command_agent");

  switch (base) {
    case "assistant":
      return [
        "Assistant mode is active.",
        `Workspace: ${workingDirectory}`,
        "Help the user with quick, grounded answers, triage, research, and lightweight task execution.",
        canReadFiles
          ? toolSet.has("inspect_file")
            ? "Use inspect_file first when a file is unknown, binary-looking, or potentially large; use read_file to actually read or extract file contents."
            : "Use the available file-reading tools when workspace facts matter."
          : "If workspace facts matter but file-reading tools are unavailable, say so plainly.",
        canUseWeb
          ? "Use the available web tools when current or external facts need checking."
          : "If current or external facts need checking but web tools are unavailable, say so plainly.",
        "Before a meaningful tool call or tool batch, briefly say what you are about to inspect or look up.",
        "If the work takes longer, send one short progress update.",
        "Do not end on a promise like 'I'll check' or 'I'll try' when a relevant next tool call is still available.",
        "Do not claim edits, commands, or verification that this turn cannot perform.",
      ]
        .filter(Boolean)
        .join("\n");
    case "explore":
    case "cowork":
      return [
        "Explore mode is active.",
        `Workspace: ${workingDirectory}`,
        "Help the user think, research, inspect files, look up data, and draft useful text safely.",
        canReadFiles
          ? toolSet.has("inspect_file")
            ? "Use inspect_file first when a file is unknown, binary-looking, or potentially large; use read_file to actually read or extract file contents."
            : "Use the available file-reading tools when workspace facts matter."
          : "If workspace facts matter but file-reading tools are unavailable, say so plainly.",
        canUseWeb
          ? "Use the available web tools when current or external facts need checking."
          : "If current or external facts need checking but web tools are unavailable, say so plainly.",
        "Before a meaningful tool call or tool batch, briefly say what you are about to inspect or look up.",
        "If the work takes longer, send one short progress update.",
        "Do not end on a promise like 'I'll check' or 'I'll try' when a relevant next tool call is still available.",
        "Do not claim edits, commands, or verification that this turn cannot perform.",
      ]
        .filter(Boolean)
        .join("\n");
    case "planner":
    case "plan":
      return [
        "Plan mode is active.",
        `Workspace: ${workingDirectory}`,
        "Act like a detailed implementation planner.",
        "Explore first, gather grounded context, and produce a concrete, decision-complete plan before execution.",
        "Stay read-only in planner mode. Do not claim file edits, shell commands, or verification runs in this turn.",
        canReadFiles
          ? toolSet.has("inspect_file")
            ? "Use inspect_file when you need to understand an unfamiliar file first, then use read_file to read or extract the actual contents."
            : "Use the available read and search tools to ground the plan in the actual workspace."
          : "If the plan depends on workspace facts but read tools are unavailable, say so plainly.",
        "If a dedicated planning question or handoff tool is available, use it instead of asking for plan approval in plain text.",
        "If a planning handoff tool accepts both summary and detail fields, keep the summary short and put the actual approved plan in the detail field.",
        "Before a meaningful tool call or tool batch, briefly say what you are about to inspect.",
        "If the work takes longer, send one short progress update.",
        "If you are blocked by a missing decision, ask directly or use an available planning tool.",
      ]
        .filter(Boolean)
        .join("\n");
    case "build":
      return [
        "Act mode is active.",
        `Workspace: ${workingDirectory}`,
        renderPromptBullets("Execution & File Mutation Rules", [
          "Act like a builder and complete the task end-to-end when feasible.",
          "If the conversation already contains an approved plan or planning handoff, treat it as the current execution spec and start implementing instead of re-planning unless a missing requirement blocks work.",
          "Use the tools available in this turn to inspect, edit, run commands, and verify work when those capabilities are present.",
          canEditFiles || canRunCommands
            ? "Before creating, initializing, or scaffolding a project in a user-named directory, perform one read-only orientation step: inspect the target path if it exists, otherwise inspect its parent directory. Do not start broad writes, dependency installation, or scaffolding until you know whether the target is missing, empty, or already contains project files."
            : undefined,
          canEditFiles
            ? "If the user asks you to create a named file or path, create it on disk instead of only drafting it in the reply unless they explicitly asked for inline content."
            : "This turn does not include file-writing tools. If the user asks you to create a named file or path, say plainly that you cannot create it in the workspace from this turn.",
          canEditFiles || canRunCommands
            ? "Printing file contents, markdown code fences, shell snippets, or commands such as cat > file is not file creation. To create files, call write_file, edit_file, workspace_editor_agent, or execute the command with exec_command."
            : undefined,
          canEditFiles
            ? "When the user asks to work in the current working directory or workspace root, put the project files there. Do not create an extra wrapper directory unless the user asks for one or the existing workspace structure clearly requires it."
            : undefined,
          canEditFiles
            ? "Read before editing existing files. Use exact edits for partial changes and full writes for new files or complete rewrites."
            : "This turn does not include file-writing tools. If edits are needed, say so plainly instead of implying they happened.",
        ]),
        renderPromptBullets("Validation & Dependencies", [
          canRunCommands
            ? "Use command tools for execution and verification when they materially help."
            : "This turn does not include command tools. If command execution is needed, say so plainly instead of implying it ran.",
          canRunCommands
            ? "When you create or change files, prefer the strongest validation the workspace already provides. Use project-level build, check, typecheck, lint, or test commands when they cover the change instead of doing file-by-file manual review in text."
            : "When you create or change files, use the strongest validation available in this turn and say plainly when you cannot run the workspace checks yourself.",
          canRunCommands
            ? "For Node or web app work, create package.json scripts and use npm commands by default unless the existing workspace clearly uses another package manager."
            : undefined,
          "Do not add project dependencies unless the implementation actually imports or runs them. For simple static apps, prefer dependency-free npm scripts.",
          "For project initialization or scaffolding, prefer non-interactive commands and flags. If a setup command is cancelled, hangs, or waits for input, do not repeat it unchanged.",
          "Do not treat dependency installation, a partial scaffold, or one file write as a finished setup. Before you stop, make sure declared scripts, referenced entry files, and basic verification actually work.",
          "For generated artifacts such as SVG, HTML, JSON, XML, or config files, validate the artifact with a real parser, renderer, or focused script instead of relying on visual inspection of the text.",
          "After you change files, do not stop until you have run a meaningful verification command or explained the concrete blocker.",
          "A failing or timed-out verification command means the task is not complete yet.",
        ]),
        renderPromptBullets("Communication Workflow", [
          canEditFiles || canRunCommands
            ? "When file creation or workspace mutation is the task, give at most one short present/future-tense status sentence if helpful, then immediately call the tool. Do not claim completion before tool results."
            : undefined,
          canEditFiles || canRunCommands
            ? "Summarize only after files exist and verification has run."
            : undefined,
          "Before each new tool call or tightly related tool batch, briefly tell the user what you are doing and why. Use present/future tense for planned work; reserve past-tense completion claims for after the relevant tool result.",
          "If the work takes longer, send one short progress update.",
          "Do not stop at promises or next steps when the task is actionable and tools are available.",
          "Before destructive commands or unrequested overwrites, confirm intent and prefer safe alternatives.",
        ]),
      ]
        .filter(Boolean)
        .join("\n");
    case "tool-worker":
      return [
        "This is a delegated internal worker session.",
        "Use the fewest safe tool calls needed for the delegated objective.",
        "Keep context use low, avoid retry loops, and skip extra narration.",
        "Return only the compact result the parent session needs next.",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return undefined;
  }
}

function resolveLatestUserMessage(history: readonly SessionMessage[]): SessionMessage | undefined {
  return [...history].reverse().find((message) => message.role === "user");
}

function messageIncludesAttachmentKind(
  message: SessionMessage | undefined,
  kind: "image" | "audio",
): boolean {
  return Boolean(message?.content.some((part) => contentPartToAttachmentKind(part) === kind));
}

function buildAttachmentCapabilityInstructionBlock(input: {
  kind: "image" | "audio";
  status: "supported" | "unsupported";
  modelId: string;
}): string {
  if (input.kind === "image") {
    if (input.status === "supported") {
      return [
        `Capability snapshot: model "${input.modelId}" supports image input.`,
        "Attached images are already part of the conversation context for this turn.",
        "Inspect attached images directly when they are present.",
        "Do not say you need a separate tool just to look at an attached image.",
      ].join("\n");
    }

    return [
      `Capability snapshot: model "${input.modelId}" is not marked as vision-capable.`,
      "If the user supplied images, be explicit that you cannot inspect them in this session.",
      "Do not imply that a missing tool is the reason.",
    ].join("\n");
  }

  if (input.status === "supported") {
    return [
      `Capability snapshot: model "${input.modelId}" supports audio input.`,
      "Attached audio is already part of the conversation context for this turn.",
      "Transcribe, translate, summarize, or analyze attached audio directly when it is present.",
      "Do not say you need a separate tool just to listen to an attached audio file.",
    ].join("\n");
  }

  return [
    `Capability snapshot: model "${input.modelId}" is not marked as supporting audio input.`,
    "If the user supplied audio files, be explicit that you cannot inspect them in this session.",
    "Do not imply that a missing tool is the reason.",
  ].join("\n");
}

function buildCapabilityInstructions(options: {
  history: SessionMessage[];
  capabilityContext?: SessionCapabilityContext;
}): string | undefined {
  const latestUserMessage = resolveLatestUserMessage(options.history);
  const attachmentKinds = (["image", "audio"] as const).filter((kind) =>
    messageIncludesAttachmentKind(latestUserMessage, kind),
  );
  if (attachmentKinds.length === 0) {
    return undefined;
  }

  const modelId = options.capabilityContext?.modelId ?? "current-model";
  const blocks = attachmentKinds
    .map((kind) => {
      const status = resolveCapabilityStatus(
        options.capabilityContext?.modelCapabilities ?? [],
        ATTACHMENT_CAPABILITY_IDS[kind],
      );
      if (status !== "supported" && status !== "unsupported") {
        return undefined;
      }

      return buildAttachmentCapabilityInstructionBlock({
        kind,
        status,
        modelId,
      });
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function assertInputCapabilitySupport(
  input: readonly ContentPart[],
  capabilityContext: SessionCapabilityContext | undefined,
  modelId: string,
): void {
  const seenKinds = new Set(
    input
      .map((part) => contentPartToAttachmentKind(part))
      .filter((kind): kind is NonNullable<typeof kind> => kind != null),
  );

  for (const kind of seenKinds) {
    const status = resolveCapabilityStatus(
      capabilityContext?.modelCapabilities ?? [],
      ATTACHMENT_CAPABILITY_IDS[kind],
    );
    if (status !== "unsupported") {
      continue;
    }

    throw new GemmaDesktopError(
      "capability_unsupported",
      `Model "${modelId}" is not marked as supporting ${describeAttachmentKind(kind)}, so it cannot inspect those attachments in this session. Switch to a compatible model or provide the content in plain text.`,
      {
        details: {
          capability: ATTACHMENT_CAPABILITY_IDS[kind][0],
          modelId,
          runtimeId: capabilityContext?.runtime.id,
          attachmentKind: kind,
        },
      },
    );
  }
}

const CONTINUE_INCOMPLETE_TOOL_WORK_INSTRUCTION = [
  "Continue the current task now.",
  "Do not stop at intent or next steps.",
  "If tool use or file changes are still needed, emit the next tool call now.",
  "Only finish when the work is complete or truly blocked on missing user input.",
].join("\n");

const CONTINUE_DRAFTED_FILE_CREATION_INSTRUCTION = [
  "This act turn is not complete yet.",
  "You drafted file contents or shell commands in the assistant text, but that did not create files in the workspace.",
  "Create the actual files now by calling write_file, edit_file, workspace_editor_agent, or exec_command.",
  "Do not repeat the file contents in markdown. Emit the next tool call now.",
].join("\n");

const CONTINUE_AFTER_TOOL_USE_INSTRUCTION = [
  "You already used tools in this turn.",
  "Do not stop at intent, promises, or next steps.",
  "If another materially different tool call is still needed, emit it now.",
  "Otherwise answer the user now or state the exact blocker plainly.",
  "Do not end with text like 'I'll try' or 'I'll check again.'",
].join("\n");

const RETRY_EMPTY_RESPONSE_INSTRUCTION = [
  "Your previous reply was empty.",
  "Respond to the current user request now.",
  "If tool use or file changes are needed, emit the next tool call now.",
  "Do not end the turn with an empty reply.",
].join("\n");

const COMPLETE_WITH_USER_FACING_SUMMARY_INSTRUCTION = [
  "You already used tools in this turn.",
  "Now send a short user-facing completion message.",
  "Summarize the concrete result, mention verification status if relevant, and call out any remaining blocker plainly.",
  "Do not end with tool calls only, reasoning only, or an empty reply.",
  "Only call another tool if it is still required to finish or verify the work.",
].join("\n");

const COMPLETE_WITH_GROUNDED_RESULT_OR_BLOCKER_INSTRUCTION = [
  "One or more tool attempts in this turn already failed or came back incomplete.",
  "Do not promise another attempt or say that you will keep looking.",
  "Using only the evidence gathered so far, either answer the user now or state the exact blocker plainly.",
  "Be specific about what was confirmed, what could not be confirmed, and what prevented further confirmation.",
  "Do not emit another tool call unless it is materially different from the failed attempt and still required to finish.",
].join("\n");

const FINALIZE_AFTER_MAX_STEPS_WITHOUT_TOOLS_INSTRUCTION = [
  "The previous step used tools and the turn has reached its tool-step budget.",
  "You no longer have tool access for this finalization pass. Do not call any more tools.",
  "Using only the user request, conversation context, and tool results already visible in the session, send the best user-facing final answer now.",
  "Be specific about what was confirmed, what could not be confirmed, and any lookup or verification that was blocked.",
  "Do not promise to keep checking or say you will try another tool.",
].join("\n");

const MAX_STEP_FINALIZATION_WARNING =
  "Turn reached the step budget after tool use. Running one no-tools finalization pass so the assistant can summarize the available evidence.";
const REPEATED_TOOL_FAILURE_THRESHOLD = 3;
const REPEATED_TOOL_CALL_THRESHOLD = 3;

const TOOL_SURFACE_REGISTRATION_ERROR_PATTERN =
  /^Tool "([^"]+)" is not registered in the active tool surface\.$/;

function buildRequiredToolContinuationInstruction(requiredTools: readonly string[]): string {
  return [
    "This turn is not complete yet.",
    `Before you end the turn, call at least one of these tools: ${requiredTools.join(", ")}.`,
    "Do not end with a plan or plain-text clarification when a required tool can do the work.",
    "Emit the required tool call now.",
  ].join("\n");
}

function buildToolFailureContinuationInstruction(failedTools: readonly string[]): string {
  const toolLabel = failedTools.length === 1
    ? failedTools[0]
    : failedTools.join(", ");

  return [
    "One or more tool calls in your previous step failed.",
    `Failed tool${failedTools.length === 1 ? "" : "s"}: ${toolLabel}.`,
    "Read the tool result error carefully before you continue.",
    "If you can recover, emit a corrected tool call now.",
    "If recovery is not possible, explain the blocker plainly instead of claiming success.",
  ].join("\n");
}

function buildRepeatedToolFailureContinuationInstruction(input: {
  toolName: string;
  failurePreview: string;
  count: number;
}): string {
  return [
    "A tool call has repeatedly failed with the same failure pattern.",
    `Tool: ${input.toolName}.`,
    `Repeated failure count: ${input.count}.`,
    `Failure pattern: ${input.failurePreview}.`,
    "Tool access is disabled for this recovery step.",
    "Do not retry the same command, tool call, or a trivial variation.",
    "Using only the evidence already visible in the session, state the concrete blocker or describe a materially different recovery path in the final answer.",
  ].join("\n");
}

function buildRepeatedToolCallContinuationInstruction(input: {
  toolName: string;
  inputPreview: string;
  count: number;
}): string {
  return [
    "A tool call has repeated unchanged in this turn.",
    `Tool: ${input.toolName}.`,
    `Repeated call count: ${input.count}.`,
    `Repeated input: ${input.inputPreview}.`,
    "Tool access is disabled for this recovery step.",
    "Do not retry the same tool call or a trivial variation.",
    "Using only the evidence already visible in the session, state the concrete blocker or describe a materially different recovery path in the final answer.",
  ].join("\n");
}

const DEFAULT_COMPACTION_KEEP_LAST_MESSAGES = 6;
const DEFAULT_COMPACTION_INPUT_TOKEN_LIMIT = 12_000;
const COMPACTION_SUMMARY_TITLE = "Compacted Session Summary";
const NOISY_TOOL_OUTPUT_NAMES = new Set([
  "inspect_file",
  "read_file",
  "read_files",
  "fetch_url",
  "search_web",
  "search_text",
  "search_paths",
  "list_tree",
  "workspace_inspector_agent",
  "workspace_search_agent",
  "workspace_editor_agent",
  "workspace_command_agent",
  "web_research_agent",
]);

const COMPACTION_SYSTEM_PROMPT = [
  "You are compacting a prior Gemma Desktop session so future turns can continue the work with less context.",
  "Summarize concrete facts, completed work, decisions, unresolved risks, remaining TODOs, and important paths or artifacts.",
  "Ignore duplicate phrasing, chain-of-thought style filler, and verbose tool I/O.",
  "Do not address the user directly and do not explain that you are summarizing.",
  "Return concise markdown with these exact sections:",
  "## Project Context",
  "## Work Completed",
  "## Key Decisions",
  "## Outstanding TODOs",
  "## Important Artifacts",
].join("\n");

function normalizeRequestReasoningMode(
  value: unknown,
): "auto" | "on" | undefined {
  return value === "auto" || value === "on"
    ? value
    : undefined;
}

function normalizeRequestNumericOptions(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === "number" && Number.isFinite(entry)
  );
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

function buildRequestSettings(
  mode: unknown,
  metadata: Record<string, unknown> | undefined,
  modelId?: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    mode,
    sessionMetadata: metadata,
  };
  const preferencesValue = metadata?.requestPreferences;
  const preferences =
    preferencesValue && typeof preferencesValue === "object" && !Array.isArray(preferencesValue)
      ? preferencesValue as Record<string, unknown>
      : undefined;
  const reasoningMode = modelId && isGemma4ModelId(modelId)
    ? "on"
    : normalizeRequestReasoningMode(preferences?.reasoningMode);
  if (reasoningMode) {
    settings.reasoningMode = reasoningMode;
  }
  const ollamaOptions = normalizeRequestNumericOptions(preferences?.ollamaOptions);
  if (ollamaOptions) {
    settings.ollamaOptions = ollamaOptions;
  }
  if (typeof preferences?.ollamaKeepAlive === "string" && preferences.ollamaKeepAlive.trim().length > 0) {
    settings.ollamaKeepAlive = preferences.ollamaKeepAlive.trim();
  }
  const lmstudioOptions = normalizeRequestNumericOptions(preferences?.lmstudioOptions);
  if (lmstudioOptions) {
    settings.lmstudioOptions = lmstudioOptions;
  }
  return settings;
}

function looksLikeIncompleteActionText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }

  const startsWithPromise = /^(?:now\s+|next\s+|then\s+)?(?:i(?:'ll| will)|let me)\b/i.test(trimmed);
  const containsIntentPhrase = /\b(?:i(?:'ll| will)|let me)\s+(?:try(?:\s+to)?|look(?:\s+it)?\s+up|find|confirm|verify|create|write|build|generate|update|edit|implement|make|add|set up|inspect|check|fetch|research|open|run)\b/i.test(trimmed);
  const containsPromiseClause = /(?:^|[.!?]\s+)(?:i(?:'ll| will)|let me)\s+(?:try(?:\s+to)?|look(?:\s+it)?\s+up|find|confirm|verify|check|fetch|research|open|run)\b/i.test(trimmed);
  const startsWithPastProgressAction = /^(?:now\s+|next\s+|then\s+)?i\s+(?:clicked|opened|navigated|went|selected|expanded|filled|typed|entered|submitted|loaded|visited|searched|pulled\s+up|switched)\b/i.test(trimmed);
  const containsPastProgressPurpose = /\bto\s+(?:find|look\s+for|check|see\s+if|see\s+whether|locate|inspect|get\s+to|navigate\s+to|open)\b/i.test(trimmed);
  const containsNextStepLeadIn = /\b(?:files?\s+to\s+create|next\s+steps?|i\s+need\s+to|i\s+should)\b/i.test(trimmed);
  const endsWithLeadIn = /[:,-]\s*$/.test(trimmed);
  const hasCompletionMarker = /\b(created|updated|wrote|saved|generated|finished|done|completed|implemented|replaced|added|here(?:'s| is)|i(?:'ve| have))\b/i.test(trimmed);
  const asksForInput = /\?\s*$/.test(trimmed);
  const pastProgressNarration = startsWithPastProgressAction && containsPastProgressPurpose;

  return (
    !asksForInput
    && !hasCompletionMarker
    && (
      startsWithPromise
      || containsIntentPhrase
      || containsPromiseClause
      || pastProgressNarration
      || containsNextStepLeadIn
      || endsWithLeadIn
    )
  );
}

function looksLikeDraftedFileCreationText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const mentionsRedirectedFileCreation =
    /(?:^|\n)\s*(?:cat|tee)\b[^\n]*(?:>|<<|EOF)[^\n]*\b[\w./-]+\.(?:cjs|css|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|ya?ml)\b/i.test(trimmed)
    || /(?:>|>>)\s*(?:"[^"]+\.(?:cjs|css|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|ya?ml)"|'[^']+\.(?:cjs|css|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|ya?ml)'|[^\s;&|]+\.(?:cjs|css|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|ya?ml))/i.test(trimmed);
  const containsFileCodeFence =
    /```(?:bash|sh|zsh|shell)\s+[\s\S]*(?:cat|tee)\b[\s\S]*(?:>|<<|EOF)/i.test(trimmed)
    || /```(?:html|xml|svg|json|javascript|js|typescript|ts|css)\s+[\s\S]*```/i.test(trimmed);
  const containsStandaloneArtifactMarkup =
    /<svg\b[\s\S]*<\/svg>/i.test(trimmed)
    || /<!doctype\s+html\b[\s\S]*<\/html>/i.test(trimmed);
  const claimsCreatedArtifact =
    /\b(?:i(?:'ve| have)|created|generated|wrote|saved|populated)\b[\s\S]{0,500}\b[\w./-]+\.(?:cjs|css|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|ya?ml)\b/i.test(trimmed)
    || /\b(?:created|generated|wrote|saved|populated)\b[\s\S]{0,240}\b(?:folder|directory)\b/i.test(trimmed);

  return (
    mentionsRedirectedFileCreation
    || containsFileCodeFence
    || containsStandaloneArtifactMarkup
    || claimsCreatedArtifact
  );
}

function hasVisibleAssistantOutcome(response: ChatResponse): boolean {
  return (
    response.toolCalls.length > 0
    || response.text.trim().length > 0
    || (response.reasoning?.trim().length ?? 0) > 0
  );
}

function hasFailedToolResult(toolResults: readonly ToolResult[]): boolean {
  return toolResults.some((toolResult) => {
    const metadata =
      toolResult.metadata && typeof toolResult.metadata === "object"
        ? toolResult.metadata as Record<string, unknown>
        : undefined;
    if (metadata?.toolError === true) {
      return true;
    }

    const structured =
      toolResult.structuredOutput && typeof toolResult.structuredOutput === "object"
        ? toolResult.structuredOutput as Record<string, unknown>
        : undefined;
    return structured?.ok === false || typeof structured?.error === "string";
  });
}

function isFailedToolResult(toolResult: ToolResult): boolean {
  return hasFailedToolResult([toolResult]);
}

function normalizeToolFailureLine(value: string): string {
  return value
    .replace(/\/[^\s]+/g, "<path>")
    .replace(/\b\d{4}[-_]\d{2}[-_]\d{2}[Tt_\-:.0-9Zz]*\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildToolFailureSignature(
  toolCall: ModelToolCall,
  toolResult: ToolResult,
): { key: string; preview: string } {
  const structured =
    toolResult.structuredOutput && typeof toolResult.structuredOutput === "object"
      ? toolResult.structuredOutput as Record<string, unknown>
      : undefined;
  const text = [
    typeof structured?.error === "string" ? structured.error : undefined,
    toolResult.output,
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n");
  const meaningfulLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) =>
        !/\bcomplete log\b/i.test(line)
        && !/^command (?:failed with exit code|timed out)\b/i.test(line)
      )
    ?? text.trim()
    ?? "unknown failure";
  const normalizedLine = normalizeToolFailureLine(meaningfulLine).slice(0, 320);
  const metadata =
    toolResult.metadata && typeof toolResult.metadata === "object"
      ? toolResult.metadata as Record<string, unknown>
      : undefined;
  const structuredExitCode =
    typeof structured?.exitCode === "number" || structured?.exitCode === null
      ? String(structured.exitCode)
      : undefined;
  const metadataExitCode =
    typeof metadata?.exitCode === "number" || metadata?.exitCode === null
      ? String(metadata.exitCode)
      : undefined;
  const exitCode = structuredExitCode ?? metadataExitCode ?? "";

  return {
    key: [
      toolCall.name,
      normalizedLine,
      exitCode,
      structured?.timedOut === true || metadata?.timedOut === true ? "timed_out" : "",
    ].join("|"),
    preview: meaningfulLine.slice(0, 220),
  };
}

function stableSerializeToolInput(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeToolInput).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerializeToolInput(entryValue)}`)
    .join(",")}}`;
}

function buildToolCallSignature(toolCall: ModelToolCall): { key: string; preview: string } {
  const serializedInput = stableSerializeToolInput(toolCall.input);
  return {
    key: `${toolCall.name}|${serializedInput}`,
    preview: serializedInput.length > 220
      ? `${serializedInput.slice(0, 217)}...`
      : serializedInput,
  };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GemmaDesktopError("cancellation", "Turn cancelled.");
  }
}

function extractLikelyPaths(text: string): string[] {
  const matches = text.match(/(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return [...new Set(matches.filter((candidate) => {
    if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) {
      return true;
    }

    const slashCount = (candidate.match(/\//g) ?? []).length;
    const lastSegment = candidate.split("/").at(-1) ?? "";
    return slashCount >= 2 || lastSegment.includes(".");
  }))];
}

function pushUniquePaths(target: string[], paths: readonly string[]): void {
  for (const path of paths) {
    const trimmed = path.trim();
    if (trimmed.length === 0 || target.includes(trimmed)) {
      continue;
    }

    target.push(trimmed);
  }
}

function hasCompactionSummaryMetadata(message: SessionMessage): boolean {
  const compaction = message.metadata?.compaction;
  return Boolean(
    compaction
      && typeof compaction === "object"
      && (compaction as Record<string, unknown>).kind === "summary",
  );
}

function stripToolCallDetails(message: SessionMessage): SessionMessage {
  if (message.role !== "assistant") {
    return structuredClone(message);
  }

  return {
    ...structuredClone(message),
    toolCalls: undefined,
  };
}

function truncateForCompaction(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 24)).trimEnd()} … (${value.length} chars total)`;
}

function sanitizeCompactionValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateForCompaction(value, depth === 0 ? 240 : 120);
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, 8).map((entry) => sanitizeCompactionValue(entry, depth + 1));
    return value.length > 8 ? [...limited, `… (${value.length - 8} more item(s))`] : limited;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(record).slice(0, 12);
    for (const [key, entry] of entries) {
      if (typeof entry === "string" && ["content", "text", "body", "prompt", "diff"].includes(key)) {
        sanitized[key] = `[omitted ${entry.length} chars]`;
        continue;
      }
      sanitized[key] = sanitizeCompactionValue(entry, depth + 1);
    }
    if (Object.keys(record).length > entries.length) {
      sanitized._omittedKeys = Object.keys(record).length - entries.length;
    }
    return sanitized;
  }

  return value;
}

function renderSanitizedToolCallInput(input: unknown): string | undefined {
  if (input == null) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(sanitizeCompactionValue(input));
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function renderSanitizedToolOutput(toolName: string | undefined, output: string): string {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return "completed with no textual output";
  }

  if (toolName && NOISY_TOOL_OUTPUT_NAMES.has(toolName)) {
    return `completed with large output omitted (${trimmed.length} chars)`;
  }

  return truncateForCompaction(trimmed, 220);
}

function buildCompactionTranscriptBlocks(history: SessionMessage[]): string[] {
  const blocks: string[] = [];

  for (const message of history) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      const text = contentPartsToText(message.content).trim();
      if (text.length > 0) {
        blocks.push(`User\n${truncateForCompaction(text, 800)}`);
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = contentPartsToText(message.content).trim();
      if (hasCompactionSummaryMetadata(message) && text.length > 0) {
        blocks.push(`Prior compact summary\n${truncateForCompaction(text, 1_200)}`);
        continue;
      }

      const toolLines = (message.toolCalls ?? []).map((toolCall) => {
        const sanitizedInput = renderSanitizedToolCallInput(toolCall.input);
        return sanitizedInput
          ? `Tool requested: ${toolCall.name} ${sanitizedInput}`
          : `Tool requested: ${toolCall.name}`;
      });

      if (text.length > 0 || toolLines.length > 0) {
        blocks.push(
          [
            text.length > 0 ? `Assistant\n${truncateForCompaction(text, 1_000)}` : undefined,
            ...toolLines,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      continue;
    }

    if (message.role === "tool") {
      const output = renderSanitizedToolOutput(
        message.name,
        contentPartsToText(message.content),
      );
      blocks.push(`Tool result${message.name ? ` (${message.name})` : ""}\n${output}`);
    }
  }

  return blocks;
}

function capCompactionTranscript(blocks: string[], tokenLimit: number): string {
  if (blocks.length === 0) {
    return "No prior session history.";
  }

  const totalTokens = estimateTextTokens(blocks.join("\n\n"));
  if (totalTokens <= tokenLimit) {
    return blocks.join("\n\n");
  }

  const firstBlock = blocks[0]!;
  const keptBlocks: string[] = [firstBlock];
  let usedTokens = estimateTextTokens(firstBlock);
  let omittedCount = Math.max(0, blocks.length - 1);

  for (let index = blocks.length - 1; index >= 1; index -= 1) {
    const block = blocks[index]!;
    const nextTokens = estimateTextTokens(block);
    const omissionNote = omittedCount > 0 ? `[${omittedCount} earlier block(s) omitted to fit compaction budget.]` : "";
    const projectedTokens =
      usedTokens
      + nextTokens
      + (omissionNote ? estimateTextTokens(omissionNote) : 0);

    if (projectedTokens > tokenLimit) {
      continue;
    }

    keptBlocks.splice(1, 0, block);
    usedTokens += nextTokens;
    omittedCount -= 1;
  }

  if (omittedCount > 0) {
    keptBlocks.splice(
      1,
      0,
      `[${omittedCount} earlier block(s) omitted to fit compaction budget.]`,
    );
  }

  return keptBlocks.join("\n\n");
}

function buildRetainedTailMessages(
  history: SessionMessage[],
  keepLastMessages: number,
): SessionMessage[] {
  const keep = Math.max(0, keepLastMessages);
  if (keep === 0) {
    return [];
  }

  const candidates = history.filter((message) => {
    if (message.role === "tool" || message.role === "system" || hasCompactionSummaryMetadata(message)) {
      return false;
    }

    if (message.role === "assistant") {
      return contentPartsToText(message.content).trim().length > 0;
    }

    return contentPartsToText(message.content).trim().length > 0;
  });

  return candidates.slice(-keep).map(stripToolCallDetails);
}

function extractExactUserPathsFromRecentHistory(history: SessionMessage[]): string[] {
  const paths: string[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || message.role !== "user") {
      continue;
    }

    pushUniquePaths(paths, extractLikelyPaths(contentPartsToText(message.content)));
  }

  return paths;
}

function extractPreservedExactUserPaths(history: SessionMessage[]): string[] {
  const paths: string[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || !hasCompactionSummaryMetadata(message)) {
      continue;
    }

    const compaction = message.metadata?.compaction;
    const preserved = compaction && typeof compaction === "object"
      ? (compaction as Record<string, unknown>).exactUserPaths
      : undefined;

    if (!Array.isArray(preserved)) {
      continue;
    }

    pushUniquePaths(
      paths,
      preserved.filter((value): value is string => typeof value === "string"),
    );
  }

  return paths;
}

function extractFallbackPathsFromCompactionSummaries(history: SessionMessage[]): string[] {
  const paths: string[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || !hasCompactionSummaryMetadata(message)) {
      continue;
    }

    pushUniquePaths(paths, extractLikelyPaths(contentPartsToText(message.content)));
  }

  return paths;
}

function collectExactUserPaths(history: SessionMessage[]): string[] {
  const paths: string[] = [];
  pushUniquePaths(paths, extractExactUserPathsFromRecentHistory(history));
  pushUniquePaths(paths, extractPreservedExactUserPaths(history));
  if (paths.length === 0) {
    pushUniquePaths(paths, extractFallbackPathsFromCompactionSummaries(history));
  }
  return paths.slice(0, 12);
}

function buildExactPathInstructions(history: SessionMessage[]): string | undefined {
  const paths = collectExactUserPaths(history);
  if (paths.length === 0) {
    return undefined;
  }

  return [
    `Exact path strings mentioned earlier by the user in this session: ${paths.join(", ")}`,
    "Treat them as authoritative.",
    "Prefer these exact paths over relative guesses when choosing files.",
    "Do not normalize, rename, or silently fix them.",
  ].join("\n");
}

export function composeSystemPrompt(
  sections: readonly ResolvedSystemInstructionSection[],
  continuationInstruction?: string,
): string | undefined {
  const promptSections: ResolvedSystemInstructionSection[] = [
    ...sections
      .map((section) => ({
        ...section,
        text: section.text.trim(),
      }))
      .filter((section) => section.text.length > 0),
  ];

  const continuationText = continuationInstruction?.trim();
  if (continuationText) {
    promptSections.push({
      source: "continuation",
      id: "runtime-continuation",
      text: continuationText,
    });
  }

  if (promptSections.length === 0) {
    return undefined;
  }

  if (
    promptSections.length === 1
    && promptSections[0]?.source === "custom"
    && !continuationText
  ) {
    return promptSections[0].text;
  }

  return [
    `<${SYSTEM_PROMPT_ROOT_TAG}>`,
    promptSections.map(renderSystemPromptSection).join("\n\n"),
    `</${SYSTEM_PROMPT_ROOT_TAG}>`,
  ].join("\n");
}

export function resolveSessionSystemInstructions(options: {
  modelId: string;
  mode: ModeSelection;
  workingDirectory: string;
  capabilityContext?: SessionCapabilityContext;
  systemInstructions?: string;
  history?: SessionMessage[];
  availableTools?: readonly string[];
  now?: Date;
  timeZone?: string;
}): ResolvedSystemInstructionSection[] {
  const sections: ResolvedSystemInstructionSection[] = [];
  const base = resolveModeBase(options.mode);
  if (base !== "minimal") {
    sections.push(...resolvePromptProfileSections(options.modelId));
    const gemma4ThinkingInstructions = buildGemma4ThinkingInstructions(options.modelId);
    if (gemma4ThinkingInstructions) {
      sections.push({
        source: "model",
        id: "gemma4-thinking",
        text: gemma4ThinkingInstructions,
      });
    }
    sections.push({
      source: "environment",
      text: buildEnvironmentInstructions({
        now: options.now,
        timeZone: options.timeZone,
      }),
    });

    const toolContextInstructions = buildToolContextInstructions(
      options.availableTools ?? [],
    );
    if (toolContextInstructions) {
      sections.push({
        source: "tool_context",
        text: toolContextInstructions,
      });
    }
  }

  const modeInstructions = buildModeInstructions(
    options.mode,
    options.workingDirectory,
    options.availableTools ?? [],
  );
  if (modeInstructions) {
    sections.push({
      source: "mode",
      text: modeInstructions,
    });
  }

  const exactPathInstructions = buildExactPathInstructions(options.history ?? []);
  if (exactPathInstructions) {
    sections.push({
      source: "exact_paths",
      text: exactPathInstructions,
    });
  }

  const capabilityInstructions = buildCapabilityInstructions({
    history: options.history ?? [],
    capabilityContext: options.capabilityContext,
  });
  if (capabilityInstructions) {
    sections.push({
      source: "capabilities",
      text: capabilityInstructions,
    });
  }

  if (options.systemInstructions) {
    sections.push({
      source: "custom",
      text: options.systemInstructions,
    });
  }

  return sections;
}

export class SessionEngine {
  public readonly sessionId: string;

  private readonly adapter: RuntimeAdapter;
  private readonly model: string;
  private readonly mode: ModeSelection;
  private readonly workingDirectory: string;
  private readonly capabilityContext?: SessionCapabilityContext;
  private readonly tools?: ToolExecutor;
  private readonly availableTools: ToolDefinition[];
  private readonly systemInstructions?: string;
  private readonly metadata?: Record<string, unknown>;
  private readonly maxSteps: number;
  private readonly buildPolicy?: BuildTurnPolicy;
  private readonly buildCompletionVerifier?: BuildCompletionVerifier;
  private readonly runSubsession?: (request: ToolSubsessionRequest, parentToolCallId: string) => Promise<ToolSubsessionResult>;
  private readonly resolveGeminiApiKey: () => string | undefined;
  private readonly resolveGeminiApiModel: () => string | undefined;
  private readonly history: SessionMessage[] = [];
  private compaction: SessionCompactionState;
  private started = false;

  public constructor(options: SessionEngineOptions) {
    this.sessionId = options.sessionId ?? makeId("session");
    this.adapter = options.adapter;
    this.model = options.model;
    this.mode = options.mode;
    this.workingDirectory = options.workingDirectory;
    this.capabilityContext = options.capabilityContext
      ? structuredClone(options.capabilityContext)
      : undefined;
    this.tools = options.tools;
    this.availableTools = options.tools?.listTools() ?? [];
    this.systemInstructions = options.systemInstructions;
    this.metadata = options.metadata;
    this.buildPolicy =
      resolveModeBase(options.mode) === "build"
        ? resolveBuildTurnPolicy({
            ...options.buildPolicy,
            ...(options.maxSteps ? { samplingTurns: options.maxSteps } : {}),
          })
        : undefined;
    this.maxSteps = options.maxSteps ?? this.buildPolicy?.samplingTurns ?? 8;
    this.buildCompletionVerifier = options.buildCompletionVerifier;
    this.runSubsession = options.runSubsession;
    this.resolveGeminiApiKey =
      typeof options.geminiApiKey === "function"
        ? options.geminiApiKey
        : () => (options.geminiApiKey as string | undefined);
    this.resolveGeminiApiModel =
      typeof options.geminiApiModel === "function"
        ? options.geminiApiModel
        : () => (options.geminiApiModel as string | undefined);
    this.started = options.started ?? false;
    this.compaction = options.compaction
      ? structuredClone(options.compaction)
      : { count: 0 };
    this.history.push(...(options.history ? structuredClone(options.history) : []));
  }

  public snapshot(): SessionSnapshot {
    return {
      schemaVersion: 2,
      sessionId: this.sessionId,
      runtimeId: this.adapter.identity.id,
      modelId: this.model,
      mode: structuredClone(this.mode),
      workingDirectory: this.workingDirectory,
      capabilityContext: this.capabilityContext
        ? structuredClone(this.capabilityContext)
        : undefined,
      systemInstructions: this.systemInstructions,
      metadata: this.metadata ? structuredClone(this.metadata) : undefined,
      maxSteps: this.maxSteps,
      buildPolicy: this.buildPolicy ? structuredClone(this.buildPolicy) : undefined,
      history: structuredClone(this.history),
      started: this.started,
      savedAt: new Date().toISOString(),
      compaction:
        this.compaction.count > 0
          ? structuredClone(this.compaction)
          : undefined,
    };
  }

  public async compact(options: SessionCompactionOptions = {}): Promise<SessionCompactionResult> {
    const compactedAt = new Date().toISOString();
    const keepLastMessages = options.keepLastMessages ?? DEFAULT_COMPACTION_KEEP_LAST_MESSAGES;
    const previousHistoryCount = this.history.length;
    const retainedTail = buildRetainedTailMessages(this.history, keepLastMessages);
    const transcriptBlocks = buildCompactionTranscriptBlocks(this.history);
    const transcript = capCompactionTranscript(
      transcriptBlocks,
      options.inputTokenLimit ?? DEFAULT_COMPACTION_INPUT_TOKEN_LIMIT,
    );

    const messages: SessionMessage[] = [
      this.buildMessage("system", [
        {
          type: "text",
          text: [COMPACTION_SYSTEM_PROMPT, options.instructions].filter(Boolean).join("\n\n"),
        },
      ]),
      this.buildMessage("user", [
        {
          type: "text",
          text: [
            `Session id: ${this.sessionId}`,
            `Runtime: ${this.adapter.identity.id}`,
            `Model: ${options.model ?? this.model}`,
            `Mode: ${resolveModeBase(this.mode)}`,
            `Working directory: ${this.workingDirectory}`,
            "",
            "Compact the following sanitized prior transcript for future continuation:",
            "",
            transcript,
          ].join("\n"),
        },
      ]),
    ];

    const compactionModel = options.model ?? this.model;
    const request: ChatRequest = {
      model: compactionModel,
      messages,
      signal: options.signal,
      debug: options.debug,
      settings: buildRequestSettings("compact", this.metadata, compactionModel),
    };

    let response: ChatResponse | undefined;
    for await (const adapterEvent of this.adapter.stream(request)) {
      if (adapterEvent.type === "response.complete") {
        response = adapterEvent.response;
      }
    }

    if (!response || response.text.trim().length === 0) {
      throw new GemmaDesktopError("transport_error", "Compaction completed without a summary response.");
    }

    const exactUserPaths = collectExactUserPaths(this.history);
    const summaryMessage = this.buildMessage(
      "assistant",
      [
        {
          type: "text",
          text: `${COMPACTION_SUMMARY_TITLE}\n\n${response.text.trim()}`,
        },
      ],
      {
        metadata: {
          compaction: {
            kind: "summary",
            compactedAt,
            count: this.compaction.count + 1,
            exactUserPaths,
          },
        },
      },
    );

    this.history.splice(0, this.history.length, summaryMessage, ...retainedTail);
    this.compaction = {
      count: this.compaction.count + 1,
      lastCompactedAt: compactedAt,
    };

    return {
      sessionId: this.sessionId,
      runtimeId: this.adapter.identity.id,
      modelId: options.model ?? this.model,
      compactedAt,
      summary: response.text.trim(),
      previousHistoryCount,
      retainedMessageCount: retainedTail.length,
      historyCount: this.history.length,
    };
  }

  public async run(input: SessionInput, options: SessionTurnOptions = {}): Promise<TurnResult> {
    const streamed = await this.runStreamed(input, options);
    const events: GemmaDesktopEvent[] = [];
    for await (const event of streamed.events) {
      events.push(event);
    }
    const completed = await streamed.completed;
    return {
      ...completed,
      events,
    };
  }

  public async runStreamed(input: SessionInput, options: SessionTurnOptions = {}): Promise<StreamedTurnResult> {
    const queue = new AsyncEventQueue();
    const turnId = makeId("turn");
    const closeQueueOnAbort = () => {
      queue.close();
    };
    options.signal?.addEventListener("abort", closeQueueOnAbort, { once: true });
    const completed = this.executeTurn(turnId, input, queue, options).finally(() => {
      options.signal?.removeEventListener("abort", closeQueueOnAbort);
      queue.close();
    });

    return {
      turnId,
      events: queue.stream(),
      completed,
    };
  }

  private buildMessage(role: SessionMessage["role"], content: ContentPart[], extras: Partial<SessionMessage> = {}): SessionMessage {
    return {
      id: makeId("message"),
      role,
      content,
      createdAt: new Date().toISOString(),
      ...extras,
    };
  }

  private emit(
    queue: AsyncEventQueue,
    turnId: string,
    type: string,
    payload: Record<string, unknown>,
    raw?: unknown,
    parentToolCallId?: string,
  ): GemmaDesktopEvent {
    const event = createEvent(
      type,
      payload,
      {
        sessionId: this.sessionId,
        turnId,
        runtimeId: this.adapter.identity.id,
        modelId: this.model,
        parentToolCallId,
      },
      raw,
    );
    queue.push(event);
    return event;
  }

  private buildRequest(
    signal: AbortSignal | undefined,
    responseFormat: StructuredOutputSpec | undefined,
    debug: RuntimeDebugRecorder | undefined,
    continuationInstruction?: string,
    availableTools?: ToolDefinition[],
  ): ChatRequest {
    const effectiveTools = availableTools ?? this.availableTools;
    const systemPromptSections = resolveSessionSystemInstructions({
      modelId: this.model,
      mode: this.mode,
      workingDirectory: this.workingDirectory,
      capabilityContext: this.capabilityContext,
      systemInstructions: this.systemInstructions,
      history: this.history,
      availableTools: effectiveTools.map((tool) => tool.name),
    });
    const systemPrompt = composeSystemPrompt(
      systemPromptSections,
      continuationInstruction,
    );
    const systemMessages: SessionMessage[] = systemPrompt
      ? [
          this.buildMessage(
            "system",
            [{ type: "text", text: systemPrompt }],
            {
              metadata: {
                sources: [
                  ...systemPromptSections.map((section) =>
                    section.id ? `${section.source}:${section.id}` : section.source,
                  ),
                  ...(continuationInstruction ? ["continuation"] : []),
                ],
              },
            },
          ),
        ]
      : [];
    const messages = systemMessages.length > 0 ? [...systemMessages, ...this.history] : [...this.history];

    return {
      model: this.model,
      messages,
      tools: effectiveTools,
      responseFormat,
      signal,
      debug,
      settings: buildRequestSettings(this.mode, this.metadata, this.model),
    };
  }

  private appendAssistantResponse(response: ChatResponse): SessionMessage {
    const toolLoopReasoning =
      response.toolCalls.length > 0 && response.reasoning?.trim()
        ? response.reasoning
        : undefined;
    const message = this.buildMessage(
      "assistant",
      response.toolCalls.length > 0
        ? [{ type: "text", text: "" }]
        : response.content,
      {
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        reasoning: toolLoopReasoning,
      },
    );
    this.history.push(message);
    return message;
  }

  private discardAssistantResponse(message: SessionMessage): void {
    const index = this.history.findIndex((entry) => entry.id === message.id);
    if (index >= 0) {
      this.history.splice(index, 1);
    }
  }

  private appendToolResult(toolResult: ToolResult): void {
    this.history.push(
      this.buildMessage("tool", [{ type: "text", text: toolResult.output }], {
        name: toolResult.toolName,
        toolCallId: toolResult.callId,
      }),
    );
  }

  private isRecoverableToolFailure(error: GemmaDesktopError): boolean {
    if (TOOL_SURFACE_REGISTRATION_ERROR_PATTERN.test(error.message.trim())) {
      return false;
    }

    return error.kind === "tool_execution_failed" || error.kind === "invalid_tool_input";
  }

  private buildFailedToolResult(
    toolCall: ModelToolCall,
    error: GemmaDesktopError,
  ): ToolResult {
    const record = error.details as Record<string, unknown> | undefined;
    const causeMessage =
      typeof record?.causeMessage === "string" && record.causeMessage.trim().length > 0
        ? record.causeMessage.trim()
        : undefined;
    const output = [
      error.message.trim(),
      causeMessage && causeMessage !== error.message.trim()
        ? `Cause: ${causeMessage}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      callId: toolCall.id,
      toolName: toolCall.name,
      output,
      structuredOutput: {
        ok: false,
        error: error.message,
        errorKind: error.kind,
        ...(causeMessage ? { causeMessage } : {}),
      },
      metadata: {
        toolError: true,
        errorKind: error.kind,
      },
    };
  }

  private mergeUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
    if (!current) {
      return next;
    }
    if (!next) {
      return current;
    }

    return {
      inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
      outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
      totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
      reasoningTokens: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
      cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
      raw: [current.raw, next.raw],
    };
  }

  private async verifyBuildCompletion(
    input: Parameters<BuildCompletionVerifier>[0],
  ): Promise<BuildCompletionVerifierResult> {
    const heuristicResult = evaluateBuildCompletionHeuristically(input);
    if (!heuristicResult.ok) {
      return heuristicResult;
    }

    if (!this.buildCompletionVerifier) {
      return heuristicResult;
    }

    const verifierResult = await this.buildCompletionVerifier(input);
    if (!verifierResult.ok) {
      return verifierResult;
    }

    return verifierResult.issues.length > heuristicResult.issues.length
      ? verifierResult
      : heuristicResult;
  }

  private async executeTurn(
    turnId: string,
    input: SessionInput,
    queue: AsyncEventQueue,
    options: SessionTurnOptions,
  ): Promise<TurnResult> {
    throwIfCancelled(options.signal);

    const warnings: string[] = [];
    const toolResults: ToolResult[] = [];
    const turnBuildPolicy =
      resolveModeBase(this.mode) === "build"
        ? resolveBuildTurnPolicy({
            ...this.buildPolicy,
            ...options.buildPolicy,
            ...(options.maxSteps ? { samplingTurns: options.maxSteps } : {}),
          })
        : undefined;
    const maxSteps = options.maxSteps ?? turnBuildPolicy?.samplingTurns ?? this.maxSteps;
    const normalizedInput = normalizeInput(input);
    assertInputCapabilitySupport(
      normalizedInput,
      this.capabilityContext,
      this.model,
    );
    const userMessage = this.buildMessage("user", normalizedInput);
    this.history.push(userMessage);

    if (!this.started) {
      this.emit(queue, turnId, "session.started", {
        mode: this.mode,
        workingDirectory: this.workingDirectory,
        metadata: this.metadata ?? {},
      });
      this.started = true;
    }

    this.emit(queue, turnId, "turn.started", {
      input: contentPartsToText(userMessage.content),
      estimatedInputTokens: estimateTextTokens(contentPartsToText(userMessage.content)),
    });

    let finalResponse: ChatResponse | undefined;
    let totalUsage: TokenUsage | undefined;
    let executedSteps = 0;
    let continuationInstruction: string | undefined;
    let continuationAttempts = 0;
    let buildValidationContinuationAttempts = 0;
    let buildFinalizationContinuationAttempts = 0;
    let buildVerifierAttempts = 0;
    let latestBuildVerifierResult: BuildCompletionVerifierResult | undefined;
    let latestBuildSummary: BuildTurnSummary | undefined;
    let completedFromFinalizationToolResponse = false;
    let nextStepAvailableTools: ToolDefinition[] | undefined;
    const failedToolSignatureCounts = new Map<string, number>();
    const toolCallSignatureCounts = new Map<string, number>();
    const requiredTools = resolveRequiredTools(this.mode).filter((toolName) =>
      this.availableTools.some((tool) => tool.name === toolName),
    );
    let requiredToolSatisfied = requiredTools.length === 0;
    const availableToolNames = this.availableTools.map((tool) => tool.name);
    const buildTurnState = createBuildTurnState(
      this.mode,
      availableToolNames,
      contentPartsToText(userMessage.content),
    );

    for (let step = 1; step <= maxSteps; step += 1) {
      throwIfCancelled(options.signal);
      executedSteps = step;
      const stepAvailableTools = nextStepAvailableTools;
      const toolAccessDisabledForStep = stepAvailableTools?.length === 0;
      nextStepAvailableTools = undefined;
      this.emit(queue, turnId, "turn.step.started", { step });

      const request = this.buildRequest(
        options.signal,
        options.responseFormat,
        options.debug,
        continuationInstruction,
        stepAvailableTools,
      );
      continuationInstruction = undefined;
      let response: ChatResponse | undefined;

      for await (const adapterEvent of this.adapter.stream(request)) {
        switch (adapterEvent.type) {
          case "text.delta":
            this.emit(queue, turnId, "content.delta", {
              step,
              channel: "assistant",
              delta: adapterEvent.delta,
            });
            break;
          case "reasoning.delta":
            this.emit(queue, turnId, "content.delta", {
              step,
              channel: "reasoning",
              delta: adapterEvent.delta,
            });
            break;
          case "warning":
            warnings.push(adapterEvent.warning);
            this.emit(queue, turnId, "warning.raised", {
              step,
              warning: adapterEvent.warning,
            }, adapterEvent.raw);
            break;
          case "lifecycle":
            this.emit(queue, turnId, "runtime.lifecycle", {
              step,
              stage: adapterEvent.stage,
              progress: adapterEvent.progress,
            }, adapterEvent.raw);
            break;
          case "response.complete":
            response = adapterEvent.response;
            break;
        }
      }

      throwIfCancelled(options.signal);

      if (!response) {
        throw new GemmaDesktopError("transport_error", "Runtime stream ended without a final response.");
      }

      const assistantMessage = this.appendAssistantResponse(response);
      finalResponse = response;
      totalUsage = this.mergeUsage(totalUsage, response.usage);

      this.emit(queue, turnId, "content.completed", {
        step,
        text: response.text,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
      }, response.raw);

      if (response.toolCalls.length === 0) {
        const modeBase = resolveModeBase(this.mode);
        const isEmptyVisibleReply = !hasVisibleAssistantOutcome(response);

        if (
          buildTurnState?.enabled
          && buildTurnState.mutations.length > 0
          && buildTurnState.canRunCommands
          && turnBuildPolicy?.requireVerificationAfterMutation !== false
        ) {
          const changedPaths = buildTurnState.mutations.flatMap((mutation) => mutation.paths);
          const buildValidationStatus = summarizeBuildValidation(
            buildTurnState,
            await planBuildVerification(this.workingDirectory, changedPaths),
          );
          latestBuildSummary = summarizeBuildTurn({
            state: buildTurnState,
            policy: turnBuildPolicy ?? resolveBuildTurnPolicy(undefined),
            validationStatus: buildValidationStatus,
            verifier: latestBuildVerifierResult,
          });

          if (
            buildValidationStatus
            && !buildValidationStatus.attempted
            && buildValidationStatus.recommendedCommands.length > 0
            && buildValidationContinuationAttempts < (turnBuildPolicy?.verificationContinuationLimit ?? 2)
            && step < maxSteps
          ) {
            buildValidationContinuationAttempts += 1;
            continuationInstruction = buildMissingBuildVerificationInstruction(buildValidationStatus);
            this.emit(queue, turnId, "build.validation.required", {
              step,
              status: buildValidationStatus,
            });
            this.emit(queue, turnId, "warning.raised", {
              step,
              warning: "Assistant changed files in build mode without running verification. Continuing the turn automatically.",
            });
            this.discardAssistantResponse(assistantMessage);
            continue;
          }

          if (
            buildValidationStatus
            && !buildValidationStatus.attempted
            && buildValidationStatus.recommendedCommands.length > 0
          ) {
            throw new GemmaDesktopError(
              "build_budget_exhausted",
              "Build turn ended before required verification could run.",
              {
                details: {
                  build: latestBuildSummary,
                },
              },
            );
          }

          if (
            buildValidationStatus
            && buildValidationStatus.attempted
            && !buildValidationStatus.passed
            && !looksLikeExplicitBuildBlocker(response.text)
            && buildValidationContinuationAttempts < (turnBuildPolicy?.verificationContinuationLimit ?? 2)
            && step < maxSteps
          ) {
            buildValidationContinuationAttempts += 1;
            continuationInstruction = buildFailedBuildVerificationInstruction(buildValidationStatus);
            this.emit(queue, turnId, "build.validation.evaluated", {
              step,
              status: buildValidationStatus,
            });
            this.emit(queue, turnId, "warning.raised", {
              step,
              warning: "Assistant verification failed in build mode without a concrete blocker. Continuing the turn automatically.",
            });
            this.discardAssistantResponse(assistantMessage);
            continue;
          }

          if (
            buildValidationStatus
            && buildValidationStatus.attempted
            && !buildValidationStatus.passed
            && !looksLikeExplicitBuildBlocker(response.text)
          ) {
            throw new GemmaDesktopError(
              "build_completion_failed",
              "Build turn ended with failing verification and no concrete blocker.",
              {
                details: {
                  build: latestBuildSummary,
                },
              },
            );
          }

          if (
            buildValidationStatus?.passed
            && turnBuildPolicy?.requireFinalizationAfterMutation !== false
            && buildTurnState.canFinalize
          ) {
            const buildFinalizationStatus = summarizeBuildFinalization(
              buildTurnState,
              buildValidationStatus,
            );
            latestBuildSummary = summarizeBuildTurn({
              state: buildTurnState,
              policy: turnBuildPolicy ?? resolveBuildTurnPolicy(undefined),
              validationStatus: buildValidationStatus,
              finalizationStatus: buildFinalizationStatus,
              verifier: latestBuildVerifierResult,
            });

            if (
              buildFinalizationStatus
              && !buildFinalizationStatus.attempted
              && buildFinalizationContinuationAttempts < (turnBuildPolicy?.finalizationContinuationLimit ?? 2)
              && step < maxSteps
            ) {
              buildFinalizationContinuationAttempts += 1;
              continuationInstruction = buildMissingBuildFinalizationInstruction(buildValidationStatus);
              this.emit(queue, turnId, "build.finalization.required", {
                step,
                status: buildFinalizationStatus,
              });
              this.emit(queue, turnId, "warning.raised", {
                step,
                warning: "Assistant verified build changes but did not record finalize_build evidence. Continuing the turn automatically.",
              });
              this.discardAssistantResponse(assistantMessage);
              continue;
            }

            if (
              buildFinalizationStatus
              && buildFinalizationStatus.attempted
              && !buildFinalizationStatus.passed
              && buildFinalizationContinuationAttempts < (turnBuildPolicy?.finalizationContinuationLimit ?? 2)
              && step < maxSteps
            ) {
              buildFinalizationContinuationAttempts += 1;
              continuationInstruction = buildRejectedBuildFinalizationInstruction(buildFinalizationStatus);
              this.emit(queue, turnId, "build.finalization.recorded", {
                step,
                status: buildFinalizationStatus,
              });
              this.emit(queue, turnId, "warning.raised", {
                step,
                warning: "Assistant finalize_build evidence was incomplete. Continuing the turn automatically.",
              });
              this.discardAssistantResponse(assistantMessage);
              continue;
            }

            if (buildFinalizationStatus && !buildFinalizationStatus.passed) {
              throw new GemmaDesktopError(
                "build_completion_failed",
                "Build turn ended without valid finalize_build completion evidence.",
                {
                  details: {
                    build: latestBuildSummary,
                  },
                },
              );
            }

            if (
              buildFinalizationStatus?.latestFinalization
              && turnBuildPolicy?.completionVerifier !== "off"
            ) {
              this.emit(queue, turnId, "build.verifier.started", {
                step,
                attempt: buildVerifierAttempts + 1,
              });
              latestBuildVerifierResult = await this.verifyBuildCompletion({
                userGoal: buildTurnState.userGoal,
                workingDirectory: this.workingDirectory,
                changedPaths: buildValidationStatus.changedPaths,
                validationStatus: buildValidationStatus,
                finalization: buildFinalizationStatus.latestFinalization,
                browserEvidence: buildTurnState.browserEvidence,
              });
              latestBuildSummary = summarizeBuildTurn({
                state: buildTurnState,
                policy: turnBuildPolicy ?? resolveBuildTurnPolicy(undefined),
                validationStatus: buildValidationStatus,
                finalizationStatus: buildFinalizationStatus,
                verifier: latestBuildVerifierResult,
              });
              this.emit(queue, turnId, "build.verifier.completed", {
                step,
                result: latestBuildVerifierResult,
              });

              if (
                !latestBuildVerifierResult.ok
                && buildVerifierAttempts < (turnBuildPolicy?.verifierAttemptLimit ?? 1)
                && step < maxSteps
              ) {
                buildVerifierAttempts += 1;
                continuationInstruction = buildRejectedBuildVerifierInstruction(latestBuildVerifierResult);
                this.emit(queue, turnId, "warning.raised", {
                  step,
                  warning: "Build completion verifier rejected the result. Continuing the turn automatically.",
                });
                this.discardAssistantResponse(assistantMessage);
                continue;
              }

              if (!latestBuildVerifierResult.ok) {
                throw new GemmaDesktopError(
                  "build_completion_failed",
                  "Build completion verifier rejected the final result.",
                  {
                    details: {
                      build: latestBuildSummary,
                    },
                  },
                );
              }
            }
          }
        }

        const shouldContinueForRequiredTools =
          requiredTools.length > 0
          && !requiredToolSatisfied
          && step < maxSteps;

        if (shouldContinueForRequiredTools) {
          continuationInstruction = buildRequiredToolContinuationInstruction(requiredTools);
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: `Assistant response ended before calling a required tool. Continuing the turn automatically and requiring one of: ${requiredTools.join(", ")}.`,
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        const shouldRetryAfterEmptyReply =
          modeBase !== "minimal"
          && continuationAttempts < 1
          && step < maxSteps
          && isEmptyVisibleReply;

        if (shouldRetryAfterEmptyReply) {
          continuationAttempts += 1;
          continuationInstruction = RETRY_EMPTY_RESPONSE_INSTRUCTION;
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Assistant returned an empty reply. Retrying the turn automatically.",
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        const planningOnlyAfterToolFailure =
          modeBase !== "minimal"
          && hasFailedToolResult(toolResults)
          && response.text.trim().length > 0
          && looksLikeIncompleteActionText(response.text);

        if (
          planningOnlyAfterToolFailure
          && continuationAttempts < 2
          && step < maxSteps
        ) {
          continuationAttempts += 1;
          continuationInstruction = COMPLETE_WITH_GROUNDED_RESULT_OR_BLOCKER_INSTRUCTION;
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning:
              "Assistant ended on plan-only text after a tool failure. Continuing the turn automatically so it gives a grounded answer or states the blocker plainly.",
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        if (planningOnlyAfterToolFailure) {
          throw new GemmaDesktopError(
            "transport_error",
            "Turn ended on plan-only text after tool failures instead of a grounded answer or blocker.",
          );
        }

        const planningOnlyAfterToolUse =
          modeBase !== "minimal"
          && !hasFailedToolResult(toolResults)
          && toolResults.length > 0
          && response.text.trim().length > 0
          && looksLikeIncompleteActionText(response.text);

        if (
          planningOnlyAfterToolUse
          && continuationAttempts < 2
          && step < maxSteps
        ) {
          continuationAttempts += 1;
          continuationInstruction = CONTINUE_AFTER_TOOL_USE_INSTRUCTION;
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning:
              "Assistant ended on next-step text after tool use. Continuing the turn automatically so it either calls the next tool or gives a grounded answer.",
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        if (planningOnlyAfterToolUse) {
          throw new GemmaDesktopError(
            "transport_error",
            "Turn ended on plan-only text after tool use instead of continuing the work or giving a grounded answer.",
          );
        }

        const draftedFileCreationWithoutMutation =
          (buildTurnState?.mutations.length ?? 0) === 0
          && looksLikeDraftedFileCreationText(response.text);
        const shouldContinueAfterIncompleteReply =
          this.availableTools.length > 0
          && modeBase === "build"
          && continuationAttempts < 2
          && step < maxSteps
          && response.text.trim().length > 0
          && (
            looksLikeIncompleteActionText(response.text)
            || draftedFileCreationWithoutMutation
          );

        if (shouldContinueAfterIncompleteReply) {
          continuationAttempts += 1;
          const draftedFileCreation = draftedFileCreationWithoutMutation;
          continuationInstruction = draftedFileCreation
            ? CONTINUE_DRAFTED_FILE_CREATION_INSTRUCTION
            : CONTINUE_INCOMPLETE_TOOL_WORK_INSTRUCTION;
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: draftedFileCreation
              ? "Assistant drafted file creation in text instead of creating files. Continuing the turn automatically."
              : toolResults.length > 0
              ? "Assistant response looked incomplete after tool use. Continuing the turn automatically."
              : "Assistant response only announced the next act step without using tools. Continuing the turn automatically.",
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        const missingUserFacingSummaryAfterToolUse =
          modeBase !== "minimal"
          && toolResults.length > 0
          && response.text.trim().length === 0;

        if (
          missingUserFacingSummaryAfterToolUse
          && continuationAttempts < 2
          && step < maxSteps
        ) {
          continuationAttempts += 1;
          continuationInstruction = COMPLETE_WITH_USER_FACING_SUMMARY_INSTRUCTION;
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Assistant finished the tool work without a user-facing completion message. Continuing the turn automatically.",
          });
          this.discardAssistantResponse(assistantMessage);
          continue;
        }

        if (missingUserFacingSummaryAfterToolUse) {
          if (!hasFailedToolResult(toolResults)) {
            this.emit(queue, turnId, "warning.raised", {
              step,
              warning:
                "Assistant completed tool work but did not produce a final user-facing message after retry. Returning the completed tool work for the caller to render or summarize.",
            });
            break;
          }

          throw new GemmaDesktopError(
            "transport_error",
            "Turn used tools but finished without a user-facing completion message.",
          );
        }

        if (modeBase !== "minimal" && isEmptyVisibleReply) {
          throw new GemmaDesktopError(
            "capability_unsupported",
            "Model returned an empty reply without text, reasoning, or tool calls.",
          );
        }

        break;
      }

      if (toolAccessDisabledForStep) {
        this.discardAssistantResponse(assistantMessage);
        throw new GemmaDesktopError(
          "tool_execution_failed",
          "Model attempted another tool call after repeated tool activity disabled tool access for the recovery step.",
          {
            details: {
              toolCalls: response.toolCalls,
            },
          },
        );
      }

      continuationAttempts = 0;

      let repeatedToolCall:
        | { toolName: string; inputPreview: string; count: number }
        | undefined;
      for (const toolCall of response.toolCalls) {
        const signature = buildToolCallSignature(toolCall);
        const count = (toolCallSignatureCounts.get(signature.key) ?? 0) + 1;
        toolCallSignatureCounts.set(signature.key, count);
        if (count >= REPEATED_TOOL_CALL_THRESHOLD && !repeatedToolCall) {
          repeatedToolCall = {
            toolName: toolCall.name,
            inputPreview: signature.preview,
            count,
          };
        }
      }

      if (repeatedToolCall) {
        this.discardAssistantResponse(assistantMessage);

        if (step >= maxSteps) {
          throw new GemmaDesktopError(
            "tool_execution_failed",
            `Tool "${repeatedToolCall.toolName}" repeated the same input ${repeatedToolCall.count} times and no steps remain for recovery.`,
            {
              details: repeatedToolCall,
            },
          );
        }

        const warning =
          `Tool "${repeatedToolCall.toolName}" repeated the same input ${repeatedToolCall.count} times. `
          + "Disabling tools for one recovery step so the assistant must stop the loop and use the existing evidence.";
        warnings.push(warning);
        this.emit(queue, turnId, "warning.raised", {
          step,
          warning,
        });
        continuationInstruction = buildRepeatedToolCallContinuationInstruction(repeatedToolCall);
        nextStepAvailableTools = [];
        continue;
      }

      if (!this.tools || this.tools.listTools().length === 0) {
        throw new GemmaDesktopError(
          "capability_unsupported",
          `Model emitted tool calls, but no tools are available in mode "${typeof this.mode === "string" ? this.mode : this.mode.base ?? "custom"}".`,
          {
            details: {
              toolCalls: response.toolCalls,
            },
          },
        );
      }

      const failedToolNames = new Set<string>();
      let repeatedFailure:
        | { toolName: string; failurePreview: string; count: number }
        | undefined;

      for (const toolCall of response.toolCalls) {
        throwIfCancelled(options.signal);
        this.emit(queue, turnId, "tool.call", {
          step,
          callId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });

        try {
          const toolResult = await this.tools.execute(toolCall, {
            sessionId: this.sessionId,
            turnId,
            toolCallId: toolCall.id,
            mode: this.mode,
            sessionMetadata: this.metadata
              ? structuredClone(this.metadata)
              : undefined,
            workingDirectory: this.workingDirectory,
            signal: options.signal,
            emit: (event) => {
              queue.push(event);
            },
            emitProgress: (progress) => {
              this.emit(
                queue,
                turnId,
                "tool.progress",
                {
                  callId: toolCall.id,
                  toolName: toolCall.name,
                  id: progress.id,
                  label: progress.label,
                  tone: progress.tone,
                },
                undefined,
                toolCall.id,
              );
            },
            runSubsession: this.runSubsession
              ? (request) =>
                  this.runSubsession!(
                    {
                      ...request,
                      signal: request.signal ?? options.signal,
                    },
                    toolCall.id,
                  )
              : undefined,
            geminiApiKey: this.resolveGeminiApiKey(),
            geminiApiModel: this.resolveGeminiApiModel(),
          });

          throwIfCancelled(options.signal);
          const toolFailed = isFailedToolResult(toolResult);
          if (toolFailed) {
            failedToolNames.add(toolCall.name);
            const signature = buildToolFailureSignature(toolCall, toolResult);
            const count = (failedToolSignatureCounts.get(signature.key) ?? 0) + 1;
            failedToolSignatureCounts.set(signature.key, count);
            if (count >= REPEATED_TOOL_FAILURE_THRESHOLD && !repeatedFailure) {
              repeatedFailure = {
                toolName: toolCall.name,
                failurePreview: signature.preview,
                count,
              };
            }
          }
          toolResults.push(toolResult);
          recordBuildToolResult(buildTurnState, toolResult);
          if (requiredTools.includes(toolCall.name)) {
            requiredToolSatisfied = true;
          }
          this.appendToolResult(toolResult);
          this.emit(
            queue,
            turnId,
            "tool.result",
            {
              step,
              callId: toolCall.id,
              toolName: toolCall.name,
              output: toolResult.output,
              ...(toolFailed ? { error: toolResult.output } : {}),
              structuredOutput: toolResult.structuredOutput,
              metadata: toolResult.metadata ?? {},
            },
            undefined,
            toolCall.id,
          );
        } catch (error) {
          const gemmaDesktopError = toGemmaDesktopError(error, "tool_execution_failed");
          this.emit(
            queue,
            turnId,
            "error.raised",
            {
              step,
              kind: gemmaDesktopError.kind,
              message: gemmaDesktopError.message,
              details: gemmaDesktopError.details ?? {},
            },
            gemmaDesktopError.raw,
            toolCall.id,
          );

          if (!this.isRecoverableToolFailure(gemmaDesktopError)) {
            throw gemmaDesktopError;
          }

          const failedToolResult = this.buildFailedToolResult(toolCall, gemmaDesktopError);
          failedToolNames.add(toolCall.name);
          const signature = buildToolFailureSignature(toolCall, failedToolResult);
          const count = (failedToolSignatureCounts.get(signature.key) ?? 0) + 1;
          failedToolSignatureCounts.set(signature.key, count);
          if (count >= REPEATED_TOOL_FAILURE_THRESHOLD && !repeatedFailure) {
            repeatedFailure = {
              toolName: toolCall.name,
              failurePreview: signature.preview,
              count,
            };
          }
          toolResults.push(failedToolResult);
          recordBuildToolResult(buildTurnState, failedToolResult);
          this.appendToolResult(failedToolResult);
          this.emit(
            queue,
            turnId,
            "tool.result",
            {
              step,
              callId: toolCall.id,
              toolName: toolCall.name,
              error: failedToolResult.output,
              structuredOutput: failedToolResult.structuredOutput,
              metadata: failedToolResult.metadata ?? {},
            },
            gemmaDesktopError.raw,
            toolCall.id,
          );
        }
      }

      if (repeatedFailure) {
        if (step >= maxSteps) {
          throw new GemmaDesktopError(
            "tool_execution_failed",
            `Tool "${repeatedFailure.toolName}" failed with the same pattern ${repeatedFailure.count} times and no steps remain for recovery.`,
            {
              details: repeatedFailure,
            },
          );
        }

        const warning =
          `Tool "${repeatedFailure.toolName}" failed with the same pattern ${repeatedFailure.count} times. `
          + "Disabling tools for one recovery step so the assistant must state the blocker instead of retrying.";
        warnings.push(warning);
        this.emit(queue, turnId, "warning.raised", {
          step,
          warning,
        });
        continuationInstruction = buildRepeatedToolFailureContinuationInstruction(repeatedFailure);
        nextStepAvailableTools = [];
        continue;
      }

      if (failedToolNames.size > 0) {
        const failedTools = [...failedToolNames];

        if (step >= maxSteps) {
          throw new GemmaDesktopError(
            "tool_execution_failed",
            failedTools.length === 1
              ? `Tool "${failedTools[0]}" failed and no steps remain for recovery.`
              : `${failedTools.length} tool calls failed and no steps remain for recovery.`,
            {
              details: {
                failedTools,
              },
            },
          );
        }

        this.emit(queue, turnId, "warning.raised", {
          step,
          warning: failedTools.length === 1
            ? `Tool "${failedTools[0]}" failed. Continuing the turn so the assistant can recover.`
            : `${failedTools.length} tool calls failed. Continuing the turn so the assistant can recover.`,
        });
        continuationInstruction = buildToolFailureContinuationInstruction(failedTools);
        continue;
      }

      const currentResponseHasFinalUserSummary =
        response.text.trim().length > 0
        && !looksLikeIncompleteActionText(response.text)
        && !looksLikeDraftedFileCreationText(response.text);
      const currentResponseRecordedBuildFinalization =
        response.toolCalls.some((toolCall) => toolCall.name === FINALIZE_BUILD_TOOL_NAME);
      const activeBuildPolicy = turnBuildPolicy;

      if (
        currentResponseRecordedBuildFinalization
        && buildTurnState?.enabled
        && buildTurnState.mutations.length > 0
        && buildTurnState.canRunCommands
        && activeBuildPolicy
        && activeBuildPolicy.requireVerificationAfterMutation !== false
      ) {
        const changedPaths = buildTurnState.mutations.flatMap((mutation) => mutation.paths);
        const buildValidationStatus = summarizeBuildValidation(
          buildTurnState,
          await planBuildVerification(this.workingDirectory, changedPaths),
        );
        const buildFinalizationStatus =
          buildValidationStatus?.passed
          && activeBuildPolicy.requireFinalizationAfterMutation !== false
          && buildTurnState.canFinalize
            ? summarizeBuildFinalization(buildTurnState, buildValidationStatus)
            : undefined;

        latestBuildSummary = summarizeBuildTurn({
          state: buildTurnState,
          policy: activeBuildPolicy,
          validationStatus: buildValidationStatus,
          finalizationStatus: buildFinalizationStatus,
          verifier: latestBuildVerifierResult,
        });

        if (
          buildValidationStatus
          && !buildValidationStatus.attempted
          && buildValidationStatus.recommendedCommands.length > 0
          && buildValidationContinuationAttempts < activeBuildPolicy.verificationContinuationLimit
          && step < maxSteps
        ) {
          buildValidationContinuationAttempts += 1;
          continuationInstruction = buildMissingBuildVerificationInstruction(buildValidationStatus);
          this.emit(queue, turnId, "build.validation.required", {
            step,
            status: buildValidationStatus,
          });
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Assistant recorded build completion evidence before running verification. Continuing the turn automatically.",
          });
          continue;
        }

        if (
          buildValidationStatus
          && buildValidationStatus.attempted
          && !buildValidationStatus.passed
          && !looksLikeExplicitBuildBlocker(response.text)
          && buildValidationContinuationAttempts < activeBuildPolicy.verificationContinuationLimit
          && step < maxSteps
        ) {
          buildValidationContinuationAttempts += 1;
          continuationInstruction = buildFailedBuildVerificationInstruction(buildValidationStatus);
          this.emit(queue, turnId, "build.validation.evaluated", {
            step,
            status: buildValidationStatus,
          });
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Assistant recorded build completion evidence after failing verification. Continuing the turn automatically.",
          });
          continue;
        }

        if (
          buildFinalizationStatus
          && buildFinalizationStatus.attempted
          && !buildFinalizationStatus.passed
          && buildFinalizationContinuationAttempts < activeBuildPolicy.finalizationContinuationLimit
          && step < maxSteps
        ) {
          buildFinalizationContinuationAttempts += 1;
          continuationInstruction = buildRejectedBuildFinalizationInstruction(buildFinalizationStatus);
          this.emit(queue, turnId, "build.finalization.recorded", {
            step,
            status: buildFinalizationStatus,
          });
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Assistant finalize_build evidence was incomplete. Continuing the turn automatically.",
          });
          continue;
        }

        if (
          buildValidationStatus?.passed
          && buildFinalizationStatus?.passed
          && activeBuildPolicy.completionVerifier !== "off"
        ) {
          this.emit(queue, turnId, "build.verifier.started", {
            step,
            attempt: buildVerifierAttempts + 1,
          });
          latestBuildVerifierResult = await this.verifyBuildCompletion({
            userGoal: buildTurnState.userGoal,
            workingDirectory: this.workingDirectory,
            changedPaths: buildValidationStatus.changedPaths,
            validationStatus: buildValidationStatus,
            finalization: buildFinalizationStatus.latestFinalization,
            browserEvidence: buildTurnState.browserEvidence,
          });
          latestBuildSummary = summarizeBuildTurn({
            state: buildTurnState,
            policy: activeBuildPolicy,
            validationStatus: buildValidationStatus,
            finalizationStatus: buildFinalizationStatus,
            verifier: latestBuildVerifierResult,
          });
          this.emit(queue, turnId, "build.verifier.completed", {
            step,
            result: latestBuildVerifierResult,
          });
        }

        if (
          currentResponseHasFinalUserSummary
          && buildValidationStatus?.passed
          && buildFinalizationStatus?.passed
          && latestBuildVerifierResult
          && !latestBuildVerifierResult.ok
          && buildVerifierAttempts < activeBuildPolicy.verifierAttemptLimit
          && step < maxSteps
        ) {
          buildVerifierAttempts += 1;
          continuationInstruction = buildRejectedBuildVerifierInstruction(latestBuildVerifierResult);
          this.emit(queue, turnId, "warning.raised", {
            step,
            warning: "Build completion verifier rejected the result. Continuing the turn automatically.",
          });
          continue;
        }

        if (
          currentResponseHasFinalUserSummary
          && buildValidationStatus?.passed
          && buildFinalizationStatus?.passed
          && latestBuildVerifierResult
          && !latestBuildVerifierResult.ok
        ) {
          throw new GemmaDesktopError(
            "build_completion_failed",
            "Build completion verifier rejected the final result.",
            {
              details: {
                build: latestBuildSummary,
              },
            },
          );
        }

        if (
          currentResponseHasFinalUserSummary
          && buildValidationStatus?.passed
          && buildFinalizationStatus?.passed
          && (activeBuildPolicy.completionVerifier === "off" || latestBuildVerifierResult?.ok === true)
        ) {
          completedFromFinalizationToolResponse = true;
          break;
        }
      }
    }

    if (!finalResponse) {
      throw new GemmaDesktopError("transport_error", "Turn completed without a model response.");
    }

    if (finalResponse.toolCalls.length > 0 && !completedFromFinalizationToolResponse) {
      const finalizationStep = maxSteps + 1;
      warnings.push(MAX_STEP_FINALIZATION_WARNING);
      this.emit(queue, turnId, "warning.raised", {
        step: finalizationStep,
        warning: MAX_STEP_FINALIZATION_WARNING,
      });
      this.emit(queue, turnId, "turn.step.started", {
        step: finalizationStep,
        finalization: true,
        toolAccess: false,
      });

      const request = this.buildRequest(
        options.signal,
        options.responseFormat,
        options.debug,
        FINALIZE_AFTER_MAX_STEPS_WITHOUT_TOOLS_INSTRUCTION,
        [],
      );
      let response: ChatResponse | undefined;

      for await (const adapterEvent of this.adapter.stream(request)) {
        switch (adapterEvent.type) {
          case "text.delta":
            this.emit(queue, turnId, "content.delta", {
              step: finalizationStep,
              channel: "assistant",
              delta: adapterEvent.delta,
            });
            break;
          case "reasoning.delta":
            this.emit(queue, turnId, "content.delta", {
              step: finalizationStep,
              channel: "reasoning",
              delta: adapterEvent.delta,
            });
            break;
          case "warning":
            warnings.push(adapterEvent.warning);
            this.emit(queue, turnId, "warning.raised", {
              step: finalizationStep,
              warning: adapterEvent.warning,
            }, adapterEvent.raw);
            break;
          case "lifecycle":
            this.emit(queue, turnId, "runtime.lifecycle", {
              step: finalizationStep,
              stage: adapterEvent.stage,
              progress: adapterEvent.progress,
            }, adapterEvent.raw);
            break;
          case "response.complete":
            response = adapterEvent.response;
            break;
        }
      }

      throwIfCancelled(options.signal);

      if (!response) {
        throw new GemmaDesktopError("transport_error", "Runtime stream ended without a final response.");
      }

      this.emit(queue, turnId, "content.completed", {
        step: finalizationStep,
        text: response.text,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
      }, response.raw);

      if (response.toolCalls.length === 0 && hasVisibleAssistantOutcome(response)) {
        this.appendAssistantResponse(response);
        finalResponse = response;
        totalUsage = this.mergeUsage(totalUsage, response.usage);
        executedSteps = finalizationStep;
      }
    }

    if (finalResponse.toolCalls.length > 0 && !completedFromFinalizationToolResponse) {
      throw new GemmaDesktopError(
        "transport_error",
        "Turn reached the maximum step count immediately after tool use, before the assistant could verify the result or send a user-facing completion message.",
        {
          details: {
            build: latestBuildSummary,
          },
        },
      );
    }

    throwIfCancelled(options.signal);

    if (buildTurnState?.enabled && turnBuildPolicy) {
      latestBuildSummary ??= summarizeBuildTurn({
        state: buildTurnState,
        policy: turnBuildPolicy,
        verifier: latestBuildVerifierResult,
      });
    }

    const structuredOutput =
      finalResponse.structuredOutput ??
      (options.responseFormat ? safeJsonParse(finalResponse.text, undefined) : undefined);

    this.emit(queue, turnId, "turn.completed", {
      steps: executedSteps,
      warnings,
      usage: totalUsage ?? {},
      toolResultCount: toolResults.length,
      build: latestBuildSummary ?? {},
    });

    return {
      sessionId: this.sessionId,
      turnId,
      runtimeId: this.adapter.identity.id,
      modelId: this.model,
      text: finalResponse.text,
      reasoning: finalResponse.reasoning,
      usage: totalUsage,
      warnings,
      steps: executedSteps,
      toolResults,
      events: [],
      structuredOutput,
      build: latestBuildSummary,
    };
  }
}
