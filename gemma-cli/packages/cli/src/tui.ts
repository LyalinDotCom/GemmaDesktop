import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { ensureOllamaRunning, inferAttachmentCapabilities, listGeminiModelInfos, listInstalledSkills, listLmStudioModelInfos, listOllamaModelInfos, type AgentRunResult, type AgentToolStartEvent, type AgentTurn, type AgentTurnEvent, type ChatMessage, type GeminiModelInfo, type LmStudioModelInfo, type ModelProvider, type OllamaModelInfo, type Tool, type ToolCall, type ToolResult, type WorkspacePermissionRequest } from '@gemma-sdk/agent';
import type { CliOptions } from './args.js';
import { createDiagnosticContext, createRunModelActivityRecorder, listStoredSessions, recordRunError, recordRunResult, recordRunStart, recordSessionModelSelection, sessionMessages, type DiagnosticContext, type StoredSession, type StoredSessionMessage } from './diagnostics.js';
import { isLocalProvider, readModelPreference, writeModelPreference, type ModelPreference } from './modelPreferences.js';
import { createRuntime, formatRunResult, type Runtime, type RuntimeHostOptions } from './runtime.js';
import { parseShellInput, runShellTool } from './shell.js';
import { formatSettings, maxScrollOffset, renderTuiFrame, type TuiHistoryEntry } from './tuiRenderer.js';
import { formatDuration, runCompletionMessage } from './tui/duration.js';
import { createTokenRateState, recordTokenRateChunk, type TokenRateState } from './tui/tokenRate.js';

const streamRedrawIntervalMs = 120;
const maxRuntimeHistoryMessages = 32;
const maxRuntimeToolOutputChars = 1_200;
const maxVisiblePromptChars = 4_000;
const maxVisiblePromptLines = 80;

export interface TuiSession {
  runtime: Runtime;
  runtimeReady?: Promise<Runtime>;
  startupModelSelection?: StartupModelSelection;
  sessionStartedAt?: number;
  provider: CliOptions['provider'];
  ollamaUrl?: string;
  lmStudioUrl?: string;
  geminiApiKey?: string;
  geminiApiBaseUrl?: string;
  contextTokens?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningMode?: CliOptions['reasoningMode'];
  ollamaAutoStart?: boolean;
  yolo?: boolean;
  runtimeHostOptions?: RuntimeHostOptions;
  requestToolPermission?: (request: WorkspacePermissionRequest) => Promise<boolean>;
  history: TuiHistoryEntry[];
  historyRevision?: number;
  scrollOffset: number;
  autoFollow?: boolean;
  inputBuffer?: string;
  commandSuggestions?: TuiCommand[];
  flash?: string;
  lastStats?: string;
  liveTokenRate?: TokenRateState;
  modelStats?: Record<string, ModelRunStats>;
  lastShellCommand?: string;
  agentRunning?: boolean;
  diagnostics?: DiagnosticContext;
}

export interface ModelRunStats {
  runs: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  lastDurationMs: number;
  lastRunAt: string;
}

export interface TuiCommand {
  name: string;
  description: string;
  insertText?: string;
  usage?: string;
  parameters?: string;
  examples?: string[];
}

export interface ToolProgressState {
  pendingHistoryIndexes: Map<number, number>;
  seenTurnIndexes: Set<number>;
}

export type SessionModelInfo = OllamaModelInfo | LmStudioModelInfo | GeminiModelInfo;

export interface SessionModelSelection {
  provider: SessionModelInfo['provider'];
  model: string;
}

export interface StartupModelSelection {
  preferred: SessionModelSelection;
  source: 'explicit' | 'session' | 'preference' | 'default';
}

export const defaultStartupModelSelection: SessionModelSelection = {
  provider: 'ollama',
  model: 'gemma4:26b'
};

export const startupDisclaimerText = 'Gemma CLI is an experimental fan project. Use at your own risk.';

export function visibleHistoryWithStartupDisclaimer(history: TuiHistoryEntry[]): TuiHistoryEntry[] {
  if (history[0]?.kind === 'disclaimer' && history[0]?.text === startupDisclaimerText) {
    return history;
  }
  return [{ kind: 'disclaimer', text: startupDisclaimerText }, ...history];
}

export async function runTui(options: CliOptions, input = defaultInput, output = defaultOutput, diagnostics?: DiagnosticContext): Promise<void> {
  let session: TuiSession | undefined;
  const runtimeHostOptions: RuntimeHostOptions = {
    outsideWorkspacePermission: async (request) => session?.requestToolPermission ? await session.requestToolPermission(request) : false
  };
  const modelPreference = await readModelPreference(options.cwd);
  const startupModelSelection = startupModelSelectionFor(options, diagnostics?.session, modelPreference);
  const startupOptions = optionsWithModelSelection(options, startupModelSelection.preferred);
  const runtimeReady = input.isTTY ? undefined : createRuntime(startupOptions, runtimeHostOptions);
  session = {
    runtime: pendingRuntime(startupOptions),
    runtimeReady,
    startupModelSelection: input.isTTY ? startupModelSelection : undefined,
    sessionStartedAt: Date.now(),
    provider: startupOptions.provider,
    ollamaUrl: options.ollamaUrl,
    lmStudioUrl: options.lmStudioUrl,
    geminiApiKey: options.geminiApiKey,
    geminiApiBaseUrl: options.geminiApiBaseUrl,
    contextTokens: options.contextTokens,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    reasoningMode: options.reasoningMode,
    ollamaAutoStart: options.ollamaAutoStart,
    yolo: options.yolo,
    runtimeHostOptions,
    history: visibleHistoryWithStartupDisclaimer(diagnostics ? storedSessionHistoryToTuiEntries(diagnostics.session.history) : []),
    scrollOffset: 0,
    autoFollow: true,
    diagnostics,
    flash: input.isTTY ? 'select model to start' : 'starting runtime...'
  };

  if (!input.isTTY) {
    const rl = createInterface({ input, output, terminal: false });
    render(session, output);
    try {
      if (!session.runtimeReady) {
        throw new Error('Runtime startup was not initialized.');
      }
      session.runtime = await session.runtimeReady;
      session.runtimeReady = undefined;
      flash(session, 'runtime ready');
      render(session, output);
      for await (const line of rl) {
        const keepGoing = await handleTuiLine(session, line, output);
        if (!keepGoing) {
          return;
        }
      }
    } finally {
      rl.close();
    }
    return;
  }

  const { runInkTui } = await import('./tui/ink/index.js');
  await runInkTui(session, input, output);
}

function pendingRuntime(options: CliOptions): Runtime {
  const provider: ModelProvider = {
    name: options.provider,
    async generate() {
      throw new Error('Runtime is still starting.');
    }
  };
  const model = options.model ?? (options.provider === 'ollama' ? 'gemma4:26b' : 'gemma-3-27b-it');

  return {
    provider,
    model,
    selectedModel: model,
    cwd: options.cwd,
    maxTurns: options.maxTurns,
    contextTokens: options.contextTokens,
    attachmentCapabilities: inferAttachmentCapabilities({ provider: options.provider, model }),
    tools: [],
    skills: [],
    history: options.history ?? [],
    systemPrompt: undefined,
    async run() {
      throw new Error('Runtime is still starting.');
    },
    async *stream() {
      throw new Error('Runtime is still starting.');
    }
  };
}

export function startupModelSelectionFor(options: CliOptions, session?: StoredSession, preference?: ModelPreference): StartupModelSelection {
  const explicit = modelSelection(options.provider, options.model);
  if (explicit) {
    return { preferred: explicit, source: 'explicit' };
  }
  const sessionSelection = modelSelection(session?.provider, session?.model);
  if (sessionSelection) {
    return { preferred: sessionSelection, source: 'session' };
  }
  const preferenceSelection = modelSelection(preference?.provider, preference?.model);
  if (preferenceSelection) {
    return { preferred: preferenceSelection, source: 'preference' };
  }
  return { preferred: defaultStartupModelSelection, source: 'default' };
}

export function preferredModelIndex(models: SessionModelInfo[], preferred: SessionModelSelection): number {
  return models.findIndex((model) => model.provider === preferred.provider && model.name === preferred.model);
}

function modelSelection(provider: unknown, model: unknown): SessionModelSelection | undefined {
  return isLocalProvider(provider) && typeof model === 'string' && model.length > 0
    ? { provider, model }
    : undefined;
}

function optionsWithModelSelection(options: CliOptions, selection: SessionModelSelection): CliOptions {
  return {
    ...options,
    provider: selection.provider,
    model: selection.model
  };
}

function cliOptionsFromSession(session: TuiSession, overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: overrides.provider ?? session.provider,
    model: overrides.model ?? session.runtime.selectedModel ?? session.runtime.model,
    ollamaUrl: overrides.ollamaUrl ?? session.ollamaUrl,
    lmStudioUrl: overrides.lmStudioUrl ?? session.lmStudioUrl,
    geminiApiKey: overrides.geminiApiKey ?? session.geminiApiKey,
    geminiApiBaseUrl: overrides.geminiApiBaseUrl ?? session.geminiApiBaseUrl,
    prompt: undefined,
    scenario: undefined,
    skills: overrides.skills ?? session.runtime.skills.map((skill) => skill.name),
    cwd: overrides.cwd ?? session.runtime.cwd,
    maxTurns: overrides.maxTurns ?? session.runtime.maxTurns,
    maxTokens: overrides.maxTokens ?? session.maxTokens,
    contextTokens: overrides.contextTokens ?? session.contextTokens ?? 262_144,
    temperature: overrides.temperature ?? session.temperature ?? 1,
    topP: overrides.topP ?? session.topP ?? 0.95,
    topK: overrides.topK ?? session.topK ?? 64,
    reasoningMode: overrides.reasoningMode ?? session.reasoningMode ?? 'auto',
    ollamaAutoStart: overrides.ollamaAutoStart ?? session.ollamaAutoStart ?? true,
    yolo: overrides.yolo ?? session.yolo ?? false,
    tui: overrides.tui ?? true,
    acp: false,
    json: false,
    jsonStream: false,
    resume: overrides.resume,
    listSessions: false,
    listModels: false,
    history: overrides.history ?? session.runtime.history ?? [],
    help: false,
    version: false
  };
}

export async function handleTuiLine(session: TuiSession, line: string, output: NodeJS.WritableStream, rl?: Interface): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  if (session.agentRunning && trimmed.startsWith('/')) {
    blockSlashCommandWhileAgentRunning(session);
    render(session, output);
    return true;
  }

  if (trimmed === '/quit' || trimmed === '/exit') {
    writeLine(output, 'bye');
    return false;
  }

  if (trimmed === '/' || trimmed === '/?') {
    addHistory(session, 'command', commandList());
    flash(session, 'commands listed');
    render(session, output);
    return true;
  }

  if (trimmed === '/help') {
    addHistory(session, 'command', tuiHelp());
    flash(session, 'help opened');
    render(session, output);
    return true;
  }

  if (trimmed === '/commands') {
    addHistory(session, 'command', commandList());
    flash(session, 'commands listed');
    render(session, output);
    return true;
  }

  if (trimmed === '/stats') {
    addHistory(session, 'command', formatStats(session));
    flash(session, 'stats shown');
    render(session, output);
    return true;
  }

  if (trimmed === '/status') {
    addHistory(session, 'status', formatStatus(session));
    flash(session, 'status shown');
    render(session, output);
    return true;
  }

  if (trimmed === '/debug:prompt') {
    addHistory(session, 'status', session.runtime.systemPrompt ?? 'System prompt unavailable until runtime is ready.');
    flash(session, 'system prompt shown');
    render(session, output);
    return true;
  }

  if (trimmed === '/think' || trimmed.startsWith('/think ')) {
    await updateThinkMode(session, trimmed.slice('/think'.length).trim());
    render(session, output);
    return true;
  }

  if (trimmed === '/skills') {
    addHistory(session, 'command', formatSkills(session));
    flash(session, 'skills shown');
    render(session, output);
    return true;
  }

  if (trimmed === '/history') {
    addHistory(session, 'command', `${session.history.length} history entries, scrollOffset=${session.scrollOffset}`);
    flash(session, 'history state shown');
    render(session, output);
    return true;
  }

  if (trimmed === '/sessions') {
    await showSessions(session);
    render(session, output);
    return true;
  }

  if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
    await resumeStoredSession(session, trimmed.slice('/resume'.length).trim());
    render(session, output);
    return true;
  }

  if (trimmed === '/clear') {
    clearVisibleHistory(session);
    flash(session, 'history cleared');
    clearTerminal(output, { scrollback: true });
    render(session, output);
    return true;
  }

  if (trimmed === '/clear-input') {
    session.inputBuffer = '';
    session.commandSuggestions = undefined;
    flash(session, 'input cleared');
    render(session, output);
    return true;
  }

  if (trimmed === '/settings') {
    addHistory(session, 'settings', formatSettings(session));
    flash(session, 'settings opened');
    render(session, output);
    return true;
  }

  if (trimmed.startsWith('/settings ')) {
    await updateSetting(session, trimmed.slice('/settings '.length).trim());
    render(session, output);
    return true;
  }

  if (trimmed.startsWith('/scroll')) {
    updateScroll(session, trimmed.slice('/scroll'.length).trim());
    render(session, output);
    return true;
  }

  if (trimmed === '/model') {
    await showModels(session, output);
    return true;
  }

  if (trimmed.startsWith('/model ')) {
    await selectSessionModel(session, trimmed.slice('/model '.length).trim());
    render(session, output);
    return true;
  }

  if (trimmed.startsWith('/run ')) {
    const runCommand = session.runtime.tools.find((tool: Tool) => tool.name === 'exec_command');
    const result = await runCommand?.run({ command: trimmed.slice('/run '.length).trim() });
    addHistory(session, result?.ok ? 'command' : 'error', result ? `${result.ok ? 'ok' : 'failed'}\n${result.output}` : 'exec_command tool is unavailable.');
    flash(session, result?.ok ? 'command completed' : 'command failed');
    render(session, output);
    return true;
  }

  if (trimmed.startsWith('!')) {
    try {
      const shell = parseShellInput(trimmed, session.lastShellCommand);
      session.lastShellCommand = shell.command;
      if (shell.interactive) {
        addHistory(session, 'command', `Interactive shell is available in the TTY UI for: ${shell.command}`);
        flash(session, 'interactive shell requested');
        render(session, output);
        return true;
      }
      const result = await runShellTool(session.runtime.tools, shell.command);
      addHistory(session, result.ok ? 'command' : 'error', `${result.ok ? '$' : 'failed'} ${shell.command}\n${result.output}`);
      flash(session, result.ok ? 'shell command completed' : 'shell command needs attention');
      render(session, output);
    } catch (error) {
      addHistory(session, 'error', error instanceof Error ? error.message : String(error));
      flash(session, 'shell command failed');
      render(session, output);
    }
    return true;
  }

  if (trimmed.startsWith('/')) {
    addHistory(session, 'error', `Unknown command: ${trimmed}\n\n${matchingCommandList(trimmed)}`);
    flash(session, 'unknown command');
    render(session, output);
    return true;
  }

  if (rl) {
    rl.pause();
  }
  addHistory(session, 'user', formatUserPromptForHistory(trimmed));
  await streamPrompt(session, trimmed, output);
  if (rl) {
    rl.resume();
  }
  return true;
}

export function render(session: TuiSession, output: NodeJS.WritableStream): void {
  if ('isTTY' in output && output.isTTY) {
    clearTerminal(output);
    writeLine(output, renderTuiFrame(session));
    return;
  }
  writeLine(output, plainSnapshot(session));
}

export function clearTerminal(output: NodeJS.WritableStream, options: { scrollback?: boolean } = {}): void {
  if ('isTTY' in output && output.isTTY) {
    output.write(options.scrollback
      ? '\x1b[2J\x1b[3J\x1b[H'
      : '\x1b[2J\x1b[H');
  }
}

function tuiHelp(): string {
  return `Type a prompt to run Gemma. Type /commands for the command palette.`;
}

function commandList(): string {
  return commands()
    .map((command) => commandSummary(command))
    .join('\n');
}

function matchingCommandList(input: string): string {
  const matches = matchingCommands(input);
  const list = matches.length > 0 ? matches : commands();
  return list.map((command) => commandSummary(command)).join('\n');
}

export function slashSuggestions(input: string): TuiCommand[] | undefined {
  if (!input.startsWith('/')) {
    return undefined;
  }
  const matches = matchingCommands(input);
  return (matches.length > 0 ? matches : commands()).slice(0, 8);
}

export function completeSlashInput(input: string, selectedIndex = 0): string {
  if (!input.startsWith('/')) {
    return input;
  }
  const normalized = normalizeCommandInput(input);
  const token = normalized.split(/\s+/, 1)[0] ?? normalized;
  const matches = matchingCommands(input);
  if (matches.length === 0) {
    return input;
  }
  const grouped = new Map<string, TuiCommand[]>();
  for (const command of matches) {
    const key = commandToken(command);
    grouped.set(key, [...(grouped.get(key) ?? []), command]);
  }
  const uniqueTokens = [...grouped.keys()];
  if (uniqueTokens.length === 1) {
    const tokenMatch = uniqueTokens[0] ?? '';
    if (token !== tokenMatch) {
      return `${tokenMatch} `;
    }
    const parameterized = grouped.get(tokenMatch)?.find((command) => command.insertText && command.insertText !== `${tokenMatch} `);
    return parameterized?.insertText ?? `${tokenMatch} `;
  }
  const selected = matches[selectedIndex % matches.length];
  return selected?.insertText ?? `${commandToken(selected)} `;
}

export function commands(): TuiCommand[] {
  return [
    { name: '/help', description: 'Show the compact TUI help hint.', usage: '/help' },
    { name: '/commands', description: 'Show this command palette.', usage: '/commands' },
    { name: '/model', description: 'Open the local model picker and switch models.', insertText: '/model ', usage: '/model' },
    { name: '/settings', description: 'Show runtime and TUI settings.', usage: '/settings [key value]' },
    { name: '/settings maxTurns <n|unlimited>', description: 'Update or clear the agent turn limit.', insertText: '/settings maxTurns ', usage: '/settings maxTurns <n|unlimited>', parameters: 'n: positive integer turn limit, or unlimited to clear it' },
    { name: '/think', description: 'Show or change reasoning mode.', usage: '/think [auto|on|off]' },
    { name: '/think on', description: 'Force provider-level reasoning when supported.', insertText: '/think on', usage: '/think on' },
    { name: '/think off', description: 'Disable provider-level reasoning and Gemma thinking prompt.', insertText: '/think off', usage: '/think off' },
    { name: '/think auto', description: 'Use model-aware reasoning defaults.', insertText: '/think auto', usage: '/think auto' },
    { name: '/stats', description: 'Show stats from the last model run.', usage: '/stats' },
    { name: '/status', description: 'Show current provider, model, generation, and exact context estimates.', usage: '/status' },
    { name: '/debug:prompt', description: 'Show the exact full agent system prompt in visible history only.', usage: '/debug:prompt' },
    { name: '/sessions', description: 'List resumable diagnostic sessions for this workspace.', usage: '/sessions' },
    { name: '/resume', description: 'Resume the most recent prior session.', usage: '/resume [number|session-id]' },
    { name: '/resume <number|session-id>', description: 'Resume a session from /sessions by number or ID prefix.', insertText: '/resume ', usage: '/resume <number|session-id>', parameters: 'number from /sessions, full session id, or id prefix' },
    { name: '/skills', description: 'Show loaded local skills.', usage: '/skills' },
    { name: '/run <command>', description: 'Run one command through exec_command.', insertText: '/run ', usage: '/run <command>', parameters: 'command: shell command executed in the current workspace' },
    { name: '! <command>', description: 'Run one shell command through exec_command.', insertText: '! ', usage: '! <command>', parameters: 'command: shell command executed in the current workspace' },
    { name: '! -i <command>', description: 'Attach your terminal to an interactive shell command.', insertText: '! -i ', usage: '! -i <command>', parameters: 'command: interactive command such as npm run dev' },
    { name: '!!', description: 'Repeat the last shell command interactively.', usage: '!!' },
    { name: '/scroll up', description: 'Move history viewport toward older entries.', insertText: '/scroll up', usage: '/scroll up' },
    { name: '/scroll down', description: 'Move history viewport toward newer entries.', insertText: '/scroll down', usage: '/scroll down' },
    { name: '/scroll top', description: 'Jump to the oldest retained history.', insertText: '/scroll top', usage: '/scroll top' },
    { name: '/scroll bottom', description: 'Jump to the newest history.', insertText: '/scroll bottom', usage: '/scroll bottom' },
    { name: '/history', description: 'Show history count and scroll offset.', usage: '/history' },
    { name: '/clear', description: 'Clear TUI history.', usage: '/clear' },
    { name: '/clear-input', description: 'Clear the current input buffer.', usage: '/clear-input' },
    { name: '/quit', description: 'Exit the TUI.', usage: '/quit' }
  ];
}

function commandToken(command: TuiCommand | undefined): string {
  return command?.name.split(/\s+/, 1)[0] ?? '';
}

function matchingCommands(input: string): TuiCommand[] {
  const normalized = normalizeCommandInput(input);
  return commands().filter((command) => commandSearchText(command).startsWith(normalized));
}

function normalizeCommandInput(input: string): string {
  return input.trimStart().replace(/\s+/g, ' ').toLowerCase();
}

function commandSearchText(command: TuiCommand): string {
  return command.name.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trimEnd().toLowerCase();
}

function commandSummary(command: TuiCommand): string {
  const usage = command.usage ?? command.name;
  const params = command.parameters ? `  params: ${command.parameters}` : '';
  return `${usage.padEnd(28)} ${command.description}${params}`;
}

export async function listSessionModels(session: TuiSession): Promise<string[]> {
  return (await listSessionModelInfos(session)).map((model) => model.name);
}

export async function listSessionModelInfos(session: TuiSession): Promise<SessionModelInfo[]> {
  const providers: Array<Promise<SessionModelInfo[]>> = [
    listOllamaModelInfosWithAutostart(session),
    listLmStudioModelInfos(session.lmStudioUrl),
    listGeminiModelInfos(session.geminiApiKey, session.geminiApiBaseUrl)
  ];
  const results = await Promise.allSettled(providers);
  const models = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (models.length > 0) {
    return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  throw new Error(errors.join('\n') || 'No model providers are available.');
}

async function listOllamaModelInfosWithAutostart(session: TuiSession): Promise<OllamaModelInfo[]> {
  try {
    return await listOllamaModelInfos(session.ollamaUrl);
  } catch (error) {
    const shouldAutostart = session.ollamaAutoStart !== false
      && (session.startupModelSelection?.preferred.provider === 'ollama' || session.provider === 'ollama');
    if (!shouldAutostart) {
      throw error;
    }
    await ensureOllamaRunning({
      baseUrl: session.ollamaUrl,
      autoStart: session.ollamaAutoStart
    });
    return await listOllamaModelInfos(session.ollamaUrl);
  }
}

export async function selectSessionModel(session: TuiSession, model: string, provider: CliOptions['provider'] = session.provider): Promise<void> {
  if (!model) {
    throw new Error('Model name is required.');
  }
  session.runtime = await createRuntime({
    provider,
    model,
    ollamaUrl: session.ollamaUrl,
    lmStudioUrl: session.lmStudioUrl,
    geminiApiKey: session.geminiApiKey,
    geminiApiBaseUrl: session.geminiApiBaseUrl,
    prompt: undefined,
    scenario: undefined,
    skills: session.runtime.skills.map((skill) => skill.name),
    cwd: session.runtime.cwd,
    maxTurns: session.runtime.maxTurns,
    maxTokens: session.maxTokens,
    contextTokens: session.contextTokens ?? 262_144,
    temperature: session.temperature ?? 1,
    topP: session.topP ?? 0.95,
    topK: session.topK ?? 64,
    reasoningMode: session.reasoningMode ?? 'auto',
    ollamaAutoStart: session.ollamaAutoStart ?? true,
    yolo: session.yolo ?? false,
    tui: true,
    acp: false,
    json: false,
    jsonStream: false,
    listSessions: false,
    listModels: false,
    history: session.runtime.history ?? [],
    help: false,
    version: false
  }, session.runtimeHostOptions);
  session.provider = provider;
  try {
    if (isLocalProvider(provider)) {
      await writeModelPreference(session.runtime.cwd, provider, model);
    }
    if (session.diagnostics) {
      await recordSessionModelSelection(session.diagnostics, provider, model);
    }
  } catch (error) {
    addHistory(session, 'notice', `Model selected, but the preference could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  flash(session, `model set to ${session.runtime.selectedModel ?? session.runtime.model}`);
  addHistory(session, 'command', modelSelectionStatus(session));
}

async function showModels(session: TuiSession, output: NodeJS.WritableStream): Promise<void> {
  let models: SessionModelInfo[];
  try {
    models = await listSessionModelInfos(session);
  } catch (error) {
    addHistory(session, 'error', error instanceof Error ? error.message : String(error));
    flash(session, 'model listing unavailable');
    render(session, output);
    return;
  }
  addHistory(session, 'command', formatModelList(session.runtime.selectedModel ?? session.runtime.model, models, session.runtime.model));
  flash(session, 'models listed');
  render(session, output);
}

async function showSessions(session: TuiSession): Promise<void> {
  const sessions = resumableSessions(await listStoredSessions(session.runtime.cwd), session);
  addHistory(session, 'command', formatSessionList(sessions));
  flash(session, sessions.length > 0 ? 'sessions listed' : 'no prior sessions');
}

async function resumeStoredSession(session: TuiSession, selector: string): Promise<void> {
  const sessions = await listStoredSessions(session.runtime.cwd);
  const resolved = resolveResumeSelector(sessions, session, selector);
  if (!resolved) {
    addHistory(session, 'error', resumeNotFoundMessage(selector, sessions, session));
    flash(session, 'session not found');
    return;
  }

  const options = cliOptionsFromSession(session, {
    provider: resolved.provider,
    model: resolved.model,
    resume: resolved.id
  });
  const diagnostics = await createDiagnosticContext(options);
  const runtimeOptions = cliOptionsFromSession(session, {
    provider: diagnostics.session.provider,
    model: diagnostics.session.model,
    ollamaUrl: diagnostics.session.ollamaUrl ?? session.ollamaUrl,
    lmStudioUrl: diagnostics.session.lmStudioUrl ?? session.lmStudioUrl,
    geminiApiBaseUrl: diagnostics.session.geminiApiBaseUrl ?? session.geminiApiBaseUrl,
    geminiApiKey: session.geminiApiKey,
    history: sessionMessages(diagnostics.session)
  });
  const runtime = await createRuntime(runtimeOptions, session.runtimeHostOptions);

  session.diagnostics = diagnostics;
  session.runtime = runtime;
  session.provider = runtimeOptions.provider;
  session.ollamaUrl = runtimeOptions.ollamaUrl;
  session.lmStudioUrl = runtimeOptions.lmStudioUrl;
  session.geminiApiKey = runtimeOptions.geminiApiKey;
  session.geminiApiBaseUrl = runtimeOptions.geminiApiBaseUrl;
  session.history = storedSessionHistoryToTuiEntries(diagnostics.session.history);
  session.scrollOffset = 0;
  session.autoFollow = true;
  session.startupModelSelection = undefined;
  session.historyRevision = (session.historyRevision ?? 0) + 1;
  addHistory(session, 'command', `resumed session ${diagnostics.session.id}`);
  flash(session, `resumed ${diagnostics.session.id}`);
}

function formatSessionList(sessions: StoredSession[]): string {
  if (sessions.length === 0) {
    return 'Sessions\n(no prior sessions found)';
  }
  return [
    'Sessions',
    'resume: /resume <number|session-id>',
    '',
    ...sessions.map((item, index) => `${String(index + 1).padStart(2, ' ')}. ${item.id}  ${item.updatedAt}  ${item.provider}/${item.model ?? 'default'}  runs=${item.runs.length}  messages=${item.history.length}`)
  ].join('\n');
}

function resolveResumeSelector(sessions: StoredSession[], session: TuiSession, selector: string): StoredSession | undefined {
  const trimmed = selector.trim();
  if (!trimmed || trimmed === 'latest') {
    return resumableSessions(sessions, session)[0];
  }
  if (/^\d+$/.test(trimmed)) {
    return resumableSessions(sessions, session)[Number(trimmed) - 1];
  }
  return sessions.find((item) => item.id === trimmed || item.id.startsWith(trimmed));
}

function resumableSessions(sessions: StoredSession[], session: TuiSession): StoredSession[] {
  const currentId = session.diagnostics?.session.id;
  return currentId ? sessions.filter((item) => item.id !== currentId) : sessions;
}

function resumeNotFoundMessage(selector: string, sessions: StoredSession[], session: TuiSession): string {
  const value = selector.trim() || 'latest prior session';
  const list = formatSessionList(resumableSessions(sessions, session));
  return `Session not found for ${value}.\n\n${list}`;
}

function formatModelList(currentModel: string, models: SessionModelInfo[], runtimeModel = currentModel): string {
  if (models.length === 0) {
    return 'Models\n(no local models found)';
  }
  return [
    'Models',
    `current: ${currentModel}`,
    runtimeModel !== currentModel ? `runtime: ${runtimeModel}` : undefined,
    'select: /model',
    '',
    ...models.map((model) => `${model.name === currentModel ? '*' : ' '} ${model.name}  ${model.provider}${model.provider === 'ollama' && model.sizeBytes ? `  ${formatBytes(model.sizeBytes)}` : ''}${model.provider === 'lmstudio' ? `  reasoning=${reasoningSupportValue(model.supportsReasoning)}` : ''}${model.supportsImage ? '  image' : ''}${model.supportsAudio ? '  audio' : ''}`)
  ].filter(Boolean).join('\n');
}

function modelSelectionStatus(session: TuiSession): string {
  const selected = session.runtime.selectedModel ?? session.runtime.model;
  if (session.runtime.model === selected) {
    return `model set to ${selected} (${session.provider})`;
  }
  return `model set to ${selected} (${session.provider}); runtime model ${session.runtime.model}`;
}

function reasoningSupportValue(value: boolean | undefined): string {
  if (value === true) return 'on';
  if (value === false) return 'unsupported';
  return 'unknown';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function statsLine(session: TuiSession, stats: { durationMs: number; turns: number; toolCalls: number }, status = 'completed', elapsedMs = stats.durationMs): string {
  return `stats: model=${session.runtime.model} status=${status} turns=${stats.turns} tools=${stats.toolCalls} duration=${formatDuration(stats.durationMs)} elapsed=${formatDuration(elapsedMs)}`;
}

export function addHistory(session: TuiSession, kind: TuiHistoryEntry['kind'], text: string): void {
  session.history.push({ kind, text });
  followHistoryBottom(session);
}

export function clearVisibleHistory(session: TuiSession): void {
  session.history = [];
  session.scrollOffset = 0;
  session.autoFollow = true;
  session.historyRevision = (session.historyRevision ?? 0) + 1;
}

export function formatUserPromptForHistory(prompt: string): string {
  const lines = prompt.split(/\r?\n/);
  let visible = lines.length > maxVisiblePromptLines
    ? lines.slice(0, maxVisiblePromptLines).join('\n')
    : prompt;

  if (visible.length > maxVisiblePromptChars) {
    visible = visible.slice(0, maxVisiblePromptChars);
  }

  if (visible.length === prompt.length) {
    return prompt;
  }

  const omittedChars = Math.max(prompt.length - visible.length, 0);
  const omittedLines = Math.max(lines.length - visible.split(/\r?\n/).length, 0);
  const lineNote = omittedLines > 0 ? `, ${omittedLines} lines` : '';
  return `${visible.trimEnd()}\n... [display truncated ${omittedChars} chars${lineNote}; model received full prompt; full prompt saved in diagnostics]`;
}

export function createToolProgressState(): ToolProgressState {
  return {
    pendingHistoryIndexes: new Map(),
    seenTurnIndexes: new Set()
  };
}

export function recordToolStartHistory(session: TuiSession, progress: ToolProgressState, event: AgentToolStartEvent): void {
  const entryIndex = session.history.length;
  session.history.push({ kind: 'tool', text: formatToolStart(event.toolCall), meta: { pending: true } });
  followHistoryBottom(session);
  progress.pendingHistoryIndexes.set(event.index, entryIndex);
}

export function recordToolTurnHistory(session: TuiSession, progress: ToolProgressState, event: AgentTurnEvent): void {
  if (event.turn.kind !== 'tool') {
    return;
  }
  const fileChange = event.turn.toolResult?.meta?.fileChange;
  const entry: TuiHistoryEntry = {
    kind: toolHistoryKind(event.turn.toolResult),
    text: formatToolTurn(event.turn),
    ...(fileChange ? { meta: { fileChange } } : {})
  };
  const pendingIndex = progress.pendingHistoryIndexes.get(event.index);
  if (pendingIndex !== undefined && session.history[pendingIndex]) {
    session.history[pendingIndex] = entry;
  } else {
    session.history.push(entry);
  }
  followHistoryBottom(session);
  progress.seenTurnIndexes.add(event.index);
}

export function appendRunTurnsToHistory(session: TuiSession, result: AgentRunResult, progress = createToolProgressState()): void {
  let appendedFinal = false;
  for (const [index, turn] of result.turns.entries()) {
    if (turn.kind === 'tool') {
      if (!progress.seenTurnIndexes.has(index)) {
        recordToolTurnHistory(session, progress, { index, turn });
      }
      continue;
    }
    appendedFinal = true;
    addHistory(session, 'assistant', turn.content || '(empty response)');
  }
  if (!appendedFinal && result.answer.trim()) {
    addHistory(session, result.completionStatus === 'incomplete' ? 'error' : 'assistant', result.answer);
  }
}

export async function streamPrompt(session: TuiSession, prompt: string, output: NodeJS.WritableStream): Promise<void> {
  const startedAt = Date.now();
  const runId = session.diagnostics ? await recordRunStart(session.diagnostics, prompt) : undefined;
  const progress = createToolProgressState();
  const partialTurns: AgentTurn[] = [];
  const pendingToolCalls = new Map<number, ToolCall>();
  const modelActivity = createRunModelActivityRecorder(session.diagnostics, runId);
  let lastRenderAt = 0;

  session.agentRunning = true;
  session.liveTokenRate = createTokenRateState(startedAt);
  flash(session, 'thinking...');
  if (isTtyOutput(output)) {
    render(session, output);
  }

  try {
    let thinkingChars = 0;
    let contentChars = 0;
    const result = await session.runtime.run(prompt, {
      onModelStart(event) {
        flash(session, event.finalization ? 'waiting for final summary pass' : `waiting for model turn ${event.index + 1}`);
        if (isTtyOutput(output) && shouldRedraw(lastRenderAt)) {
          lastRenderAt = Date.now();
          render(session, output);
        }
      },
      async onModelActivity(event) {
        await modelActivity.record(event);
        if (session.liveTokenRate) {
          recordTokenRateChunk(session.liveTokenRate, event.chunk);
        }
        if (event.chunk.thinking) {
          thinkingChars += event.chunk.thinking.length;
          flash(session, `${reasoningActivityLabel(session)} ${thinkingChars} chars`);
        } else if (event.chunk.content) {
          contentChars += event.chunk.content.length;
          flash(session, `receiving ${contentChars} chars`);
        } else if (event.chunk.status) {
          flash(session, event.chunk.status);
        } else if (event.chunk.done) {
          flash(session, 'model response complete');
        }
        if (isTtyOutput(output) && shouldRedraw(lastRenderAt)) {
          lastRenderAt = Date.now();
          render(session, output);
        }
      },
      onToolStart(event) {
        pendingToolCalls.set(event.index, event.toolCall);
        recordToolStartHistory(session, progress, event);
        flash(session, `running ${event.toolCall.tool}`);
        if (isTtyOutput(output) && shouldRedraw(lastRenderAt)) {
          lastRenderAt = Date.now();
          render(session, output);
        }
      },
      onTurn(event) {
        partialTurns[event.index] = event.turn;
        pendingToolCalls.delete(event.index);
        if (event.turn.kind === 'tool') {
          recordToolTurnHistory(session, progress, event);
          const status = toolResultStatusLabel(event.turn.toolResult);
          flash(session, `${event.turn.toolCall?.tool ?? 'tool'} ${status === 'ok' ? 'completed' : status}`);
          if (isTtyOutput(output) && shouldRedraw(lastRenderAt)) {
            lastRenderAt = Date.now();
            render(session, output);
          }
        }
      }
    });
    appendRunTurnsToHistory(session, result, progress);
    const elapsedMs = Date.now() - startedAt;
    session.lastStats = statsLine(session, result.stats, result.completionStatus, elapsedMs);
    recordModelRunStats(session, result.stats);
    appendRunToRuntimeHistory(session, prompt, result);
    if (runId && session.diagnostics) {
      await modelActivity.flush();
      await recordRunResult(session.diagnostics, runId, result, {
        modelOutputs: modelActivity.snapshots()
      });
    }
    flash(session, runCompletionMessage(result.completionStatus, elapsedMs));
    session.agentRunning = false;
    render(session, output);
  } catch (error) {
    appendInterruptedRunToRuntimeHistory(
      session,
      prompt,
      partialTurns.filter(Boolean),
      'failed',
      error instanceof Error ? error.message : String(error)
    );
    if (runId && session.diagnostics) {
      await modelActivity.flush();
      await recordRunError(session.diagnostics, runId, error, 'failed', {
        turns: partialTurns.filter(Boolean),
        pendingToolCalls: [...pendingToolCalls.values()],
        modelOutputs: modelActivity.snapshots()
      });
    }
    addHistory(session, 'error', error instanceof Error ? error.message : String(error));
    flash(session, 'run failed');
    session.agentRunning = false;
    render(session, output);
  }
}

function formatToolStart(toolCall: ToolCall): string {
  return compactLines([
    toolTitle(toolCall),
    'running',
    summarizeArgs(toolCall)
  ]).join('\n');
}

export function recordModelRunStats(session: TuiSession, stats: AgentRunResult['stats']): void {
  session.modelStats ??= {};
  const existing = session.modelStats[session.runtime.model] ?? {
    runs: 0,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    lastDurationMs: 0,
    lastRunAt: ''
  };
  session.modelStats[session.runtime.model] = {
    runs: existing.runs + 1,
    turns: existing.turns + stats.turns,
    toolCalls: existing.toolCalls + stats.toolCalls,
    durationMs: existing.durationMs + stats.durationMs,
    lastDurationMs: stats.durationMs,
    lastRunAt: new Date().toISOString()
  };
}

function formatSkills(session: TuiSession): string {
  const loaded = session.runtime.skills.length > 0
    ? session.runtime.skills.map((skill) => `- ${skill.name}${skill.source === 'user' ? ' (user)' : ''}`)
    : ['No skills loaded explicitly.'];
  const installed = listInstalledSkills({ cwd: session.runtime.cwd }).map((skill) => `- ${skill.name}: ${skill.description ?? 'installed skill'}`);
  return [
    'Skills',
    'Loaded',
    ...loaded,
    '',
    'Installed',
    ...(installed.length > 0 ? installed : ['No installed skills found in ~/.gemmacli/skills or .gemma/skills.'])
  ].join('\n');
}

function formatStats(session: TuiSession): string {
  const modelStats = Object.entries(session.modelStats ?? {});
  return [
    'Stats',
    `model: ${session.runtime.model}`,
    `provider: ${session.provider}`,
    `context: ${contextStatsLabel(session)}`,
    `maxTurns: ${formatMaxTurns(session.runtime.maxTurns)}`,
    `skills: ${session.runtime.skills.length}`,
    `lastRun: ${session.lastStats ? session.lastStats.replace(/^stats:\s*/, '') : 'none'}`,
    modelStats.length > 0 ? 'perModel:' : 'perModel: none',
    ...modelStats.map(([model, stats]) => `${model}: runs=${stats.runs} turns=${stats.turns} tools=${stats.toolCalls} totalMs=${stats.durationMs} lastMs=${stats.lastDurationMs}`)
  ].join('\n');
}

function formatStatus(session: TuiSession): string {
  const context = contextUsage(session);
  const attachments = session.runtime.attachmentCapabilities;
  const toolNames = session.runtime.tools.map((tool) => tool.name);
  const modelStats = Object.entries(session.modelStats ?? {});
  return [
    'Status',
    'Runtime',
    `  provider: ${session.provider}`,
    `  selectedModel: ${session.runtime.selectedModel ?? session.runtime.model}`,
    `  model: ${session.runtime.model}`,
    `  directory: ${session.runtime.cwd}`,
    `  ollamaUrl: ${session.ollamaUrl ?? 'http://127.0.0.1:11434'}`,
    `  lmStudioUrl: ${session.lmStudioUrl ?? 'http://127.0.0.1:1234'}`,
    `  geminiApiBaseUrl: ${session.geminiApiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}`,
    '',
    'Generation',
    `  maxTurns: ${formatMaxTurns(session.runtime.maxTurns)}`,
    `  thinking: ${thinkingStatus(session)}`,
    `  temperature: ${session.temperature ?? 'provider default'}`,
    `  topP: ${session.topP ?? 'provider default'}`,
    `  topK: ${session.topK ?? 'provider default'}`,
    `  maxTokens: ${session.maxTokens ?? 'provider default'}`,
    '',
    'Context',
    `  contextTokens: ${session.runtime.contextTokens ?? 'n/a'}`,
    `  contextRequestedTokens: ${session.runtime.requestedContextTokens ?? 'n/a'}`,
    `  contextLoadedTokens: ${session.runtime.loadedContextTokens ?? 'unknown'}`,
    `  contextUsedTokens: ${context.usedTokens}`,
    `  contextUsedBytes: ${context.usedBytes}`,
    `  systemPromptTokens: ${context.systemTokens}`,
    `  runtimeHistoryBytes: ${context.historyBytes}`,
    `  visibleChatBytes: ${context.visibleHistoryBytes}`,
    '',
    'Tools And Media',
    `  toolsLoaded: ${toolNames.length}`,
    `  tools: ${toolNames.join(', ') || 'none'}`,
    `  skillsLoaded: ${session.runtime.skills.length}`,
    `  skills: ${session.runtime.skills.map((skill) => skill.name).join(', ') || 'none'}`,
    `  attachments: image=${supportLabel(attachments?.image)} audio=${supportLabel(attachments?.audio)} video=${supportLabel(attachments?.video)} pdf=${supportLabel(attachments?.pdf)}`,
    `  attachmentSource: ${attachments?.source ?? 'unknown'}`,
    '',
    'Run Stats',
    `  lastRun: ${session.lastStats ? session.lastStats.replace(/^stats:\s*/, '') : 'none'}`,
    modelStats.length > 0 ? '  perModel:' : '  perModel: none',
    ...modelStats.map(([model, stats]) => `    ${model}: runs=${stats.runs} turns=${stats.turns} tools=${stats.toolCalls} totalMs=${stats.durationMs} lastMs=${stats.lastDurationMs}`)
  ].join('\n');
}

function supportLabel(value: boolean | undefined): string {
  return value ? 'supported' : 'unsupported';
}

function thinkingStatus(session: TuiSession): string {
  const mode = session.reasoningMode ?? 'auto';
  if (mode === 'off') {
    return 'off';
  }
  if (session.provider === 'lmstudio') {
    if (session.runtime.providerReasoning !== true) {
      const support = session.runtime.providerReasoning === false ? 'unsupported' : 'unknown';
      return /gemma[-_]?4/i.test(session.runtime.model)
        ? `LM Studio reasoning control ${support}; Gemma 4 thinking prompt still active`
        : `LM Studio reasoning control ${support}`;
    }
    if (mode === 'on') {
      return 'on (LM Studio reasoning control enabled)';
    }
    return /gemma[-_]?4/i.test(session.runtime.model)
      ? 'enabled (LM Studio reasoning control, Gemma 4 <|think|> prompt)'
      : 'off (LM Studio reasoning control available; use /think on to force it)';
  }
  if (mode === 'on') {
    return session.provider === 'ollama'
      ? 'on (Ollama reasoning_effort=high forced)'
      : 'on (requested when provider supports reasoning control)';
  }
  if (session.provider === 'ollama') {
    return /gemma4/i.test(session.runtime.model)
      ? 'enabled (Ollama reasoning_effort=high, Gemma 4 <|think|> prompt)'
      : 'off by default (Ollama reasoning_effort=none for non-Gemma models)';
  }
  return 'provider dependent';
}

function reasoningActivityLabel(session: TuiSession): string {
  return reasoningOffRequested(session)
    ? 'reasoning received despite think off'
    : 'reasoning';
}

function reasoningOffRequested(session: TuiSession): boolean {
  const mode = session.reasoningMode ?? 'auto';
  if (mode === 'off') return true;
  return session.provider === 'ollama' && mode === 'auto' && !/gemma4/i.test(session.runtime.model);
}

function contextStatsLabel(session: TuiSession): string {
  const total = session.runtime.contextTokens;
  if (!total) {
    return 'n/a';
  }
  const { systemTokens, usedTokens } = contextUsage(session);
  const percent = Math.max(1, Math.ceil((usedTokens / total) * 100));
  const loaded = session.runtime.loadedContextTokens;
  const source = loaded ? `loaded ${loaded}` : `target ${total}`;
  return `${source}, ~${percent}% used (${usedTokens}/${total} estimated tokens)`;
}

function contextUsage(session: TuiSession): { systemTokens: number; historyBytes: number; visibleHistoryBytes: number; usedBytes: number; usedTokens: number } {
  const systemTokens = session.runtime.systemPromptTokens ?? 0;
  const runtimeHistoryText = (session.runtime.history ?? []).map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.type === 'text' ? part.text : `[${part.type}:${part.url}]`).join('\n')).join('\n');
  const visibleHistoryText = session.history.map((entry) => entry.text).join('\n');
  const historyBytes = Buffer.byteLength(runtimeHistoryText, 'utf8');
  const visibleHistoryBytes = Buffer.byteLength(visibleHistoryText, 'utf8');
  const usedBytes = Math.max(historyBytes, visibleHistoryBytes);
  return {
    systemTokens,
    historyBytes,
    visibleHistoryBytes,
    usedBytes,
    usedTokens: systemTokens + Math.ceil(usedBytes / 4)
  };
}

function formatToolTurn(turn: AgentTurn): string {
  const status = toolResultStatusLabel(turn.toolResult);
  return compactLines([
    turn.toolCall ? toolTitle(turn.toolCall) : 'tool',
    status,
    turn.toolCall ? summarizeArgs(turn.toolCall) : '',
    turn.content.trimEnd() || '(no output)'
  ]).join('\n');
}

function toolTitle(toolCall: ToolCall): string {
  return compactLines([toolCall.tool, toolTarget(toolCall)]).join(' ');
}

function toolTarget(toolCall: ToolCall): string {
  if (toolCall.tool === 'exec_command') {
    return clipOneLine(firstArgString(toolCall.args, ['command', 'name']) ?? '', 120);
  }
  return clipOneLine(firstArgString(toolCall.args, ['path', 'file', 'target', 'name']) ?? '', 120);
}

function summarizeArgs(toolCall: ToolCall): string {
  if (toolCall.tool === 'write_file') {
    const content = typeof toolCall.args.content === 'string' ? toolCall.args.content : undefined;
    return content ? `content: ${content.length} chars` : '';
  }
  if (toolCall.tool === 'edit_file') {
    return firstArgString(toolCall.args, ['oldText']) ? 'exact replacement' : '';
  }
  const timeoutMs = toolCall.args.timeoutMs;
  if (toolCall.tool === 'exec_command' && typeof timeoutMs === 'number') {
    return `timeoutMs: ${timeoutMs}`;
  }
  return '';
}

function firstArgString(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function compactLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function clipOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(maxLength - 3, 0))}...`;
}

export function appendRunToRuntimeHistory(session: TuiSession, prompt: string, result: AgentRunResult): void {
  session.runtime.history ??= [];
  session.runtime.history.push({ role: 'user', content: session.runtime.lastUserContent ?? prompt });
  session.runtime.lastUserContent = undefined;
  for (const turn of result.turns) {
    session.runtime.history.push(runtimeHistoryMessageForTurn(turn));
  }
  session.runtime.history = compactRuntimeHistory(session.runtime.history);
}

export function appendInterruptedRunToRuntimeHistory(
  session: TuiSession,
  prompt: string,
  turns: AgentTurn[],
  status: 'failed' | 'cancelled',
  message?: string
): void {
  session.runtime.history ??= [];
  session.runtime.history.push({ role: 'user', content: session.runtime.lastUserContent ?? prompt });
  session.runtime.lastUserContent = undefined;
  for (const turn of turns) {
    session.runtime.history.push(runtimeHistoryMessageForTurn(turn));
  }
  session.runtime.history.push({
    role: 'assistant',
    content: `${status}: ${message?.trim() || 'run interrupted before completion'}`
  });
  session.runtime.history = compactRuntimeHistory(session.runtime.history);
}

export function storedSessionHistoryToTuiEntries(messages: StoredSessionMessage[]): TuiHistoryEntry[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { kind: 'user', text: formatUserPromptForHistory(message.content) };
    }
    if (message.role === 'tool') {
      return { kind: toolHistoryKind(message.toolResult), text: formatStoredToolHistory(message) };
    }
    return {
      kind: message.content.startsWith('failed:') || message.content.startsWith('cancelled:') ? 'error' : 'assistant',
      text: message.content
    };
  });
}

function runtimeHistoryMessageForTurn(turn: AgentTurn): { role: 'assistant' | 'user'; content: string } {
  if (turn.kind !== 'tool') {
    return { role: 'assistant', content: turn.content };
  }
  return {
    role: 'user',
    content: [
      `Tool result for ${turn.toolCall?.tool ?? 'tool'}:`,
      JSON.stringify({
        ok: turn.toolResult?.ok ?? true,
        output: truncateRuntimeToolOutput(turn.toolResult?.output ?? turn.content)
      })
    ].join('\n')
  };
}

function compactRuntimeHistory(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= maxRuntimeHistoryMessages) {
    return history;
  }
  const firstUser = history.find((message) => message.role === 'user');
  const recent = history.slice(-maxRuntimeHistoryMessages);
  if (!firstUser || recent.includes(firstUser)) {
    return recent;
  }
  return [firstUser, ...recent.slice(1)];
}

function truncateRuntimeToolOutput(output: string): string {
  if (output.length <= maxRuntimeToolOutputChars) {
    return output;
  }
  return `${output.slice(0, maxRuntimeToolOutputChars)}\n... [truncated ${output.length - maxRuntimeToolOutputChars} chars; inspect files/tools again if needed]`;
}

function formatStoredToolHistory(message: StoredSessionMessage): string {
  if (!message.toolCall) {
    return `tool\n${message.content}`;
  }
  return compactLines([
    toolTitle(message.toolCall),
    toolResultStatusLabel(message.toolResult),
    summarizeArgs(message.toolCall),
    message.toolResult?.output ?? message.content
  ]).join('\n');
}

export function toolResultStatusLabel(result: ToolResult | undefined): 'ok' | 'failed' | 'notice' | 'running' {
  if (result?.meta?.runningCommand?.status === 'running') {
    return 'running';
  }
  if (result?.meta?.presentation === 'notice') {
    return 'notice';
  }
  return result?.ok === false ? 'failed' : 'ok';
}

function toolHistoryKind(result: ToolResult | undefined): TuiHistoryEntry['kind'] {
  const status = toolResultStatusLabel(result);
  if (status === 'notice') {
    return 'notice';
  }
  return status === 'failed' ? 'error' : 'tool';
}

export function flash(session: TuiSession, message: string): void {
  session.flash = message;
}

export function blockSlashCommandWhileAgentRunning(session: TuiSession): void {
  addHistory(session, 'notice', 'Slash commands are disabled while the agent is running. Press Esc to cancel in the TTY UI, or wait for the run to finish.');
  flash(session, 'slash command blocked during run');
}

function updateScroll(session: TuiSession, arg: string): void {
  if (!scrollHistory(session, arg || 'down')) {
    addHistory(session, 'error', 'Usage: /scroll up|down|top|bottom');
    flash(session, 'scroll command failed');
  }
}

export function scrollHistory(session: TuiSession, direction: string, rows = 3): boolean {
  direction = direction || 'down';
  const maxOffset = maxScrollOffset(session);
  if (direction === 'up') {
    session.autoFollow = false;
    session.scrollOffset = Math.min(session.scrollOffset + rows, maxOffset);
    flash(session, scrollPausedMessage(session));
    return true;
  } else if (direction === 'down') {
    session.scrollOffset = Math.max(session.scrollOffset - rows, 0);
    session.autoFollow = session.scrollOffset === 0;
    flash(session, session.autoFollow ? 'following live output' : scrollPausedMessage(session));
    return true;
  } else if (direction === 'top') {
    session.autoFollow = false;
    session.scrollOffset = maxOffset;
    flash(session, scrollPausedMessage(session));
    return true;
  } else if (direction === 'bottom') {
    resumeHistoryAutoFollow(session);
    return true;
  }
  return false;
}

export function resumeHistoryAutoFollow(session: TuiSession): void {
  session.autoFollow = true;
  session.scrollOffset = 0;
  flash(session, 'following live output');
}

function followHistoryBottom(session: TuiSession): void {
  if (session.autoFollow !== false) {
    session.scrollOffset = 0;
  }
}

function scrollPausedMessage(session: TuiSession): string {
  const suffix = session.agentRunning ? ' · End to follow live' : '';
  return `scrollback paused offset=${session.scrollOffset}${suffix}`;
}

async function updateSetting(session: TuiSession, arg: string): Promise<void> {
  const [name, value] = arg.split(/\s+/, 2);
  if (name !== 'maxTurns' || !value) {
    addHistory(session, 'error', 'Usage: /settings maxTurns <positive integer|unlimited>');
    flash(session, 'settings update failed');
    return;
  }

  if (/^(?:unlimited|uncapped|none|off)$/i.test(value)) {
    session.runtime = await createRuntime(runtimeOptionsForSession(session, { maxTurns: undefined }), session.runtimeHostOptions);
    addHistory(session, 'settings', 'maxTurns set to unlimited');
    flash(session, 'maxTurns=unlimited');
    return;
  }

  const maxTurns = Number(value);
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    addHistory(session, 'error', 'maxTurns must be a positive integer, or unlimited.');
    flash(session, 'settings update failed');
    return;
  }

  session.runtime = await createRuntime(runtimeOptionsForSession(session, { maxTurns }), session.runtimeHostOptions);
  addHistory(session, 'settings', `maxTurns set to ${maxTurns}`);
  flash(session, `maxTurns=${maxTurns}`);
}

async function updateThinkMode(session: TuiSession, arg: string): Promise<void> {
  const mode = arg.trim();
  if (!mode) {
    addHistory(session, 'settings', [
      'Think',
      `mode: ${session.reasoningMode ?? 'auto'}`,
      `status: ${thinkingStatus(session)}`,
      'usage: /think on | /think off | /think auto'
    ].join('\n'));
    flash(session, 'think status shown');
    return;
  }
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
    addHistory(session, 'error', 'Usage: /think on | /think off | /think auto');
    flash(session, 'think update failed');
    return;
  }

  session.reasoningMode = mode;
  session.runtime = await createRuntime(runtimeOptionsForSession(session, { reasoningMode: mode }), session.runtimeHostOptions);
  addHistory(session, 'settings', [
    'Think',
    `mode set to ${mode}`,
    `status: ${thinkingStatus(session)}`
  ].join('\n'));
  flash(session, `think=${mode}`);
}

function runtimeOptionsForSession(session: TuiSession, overrides: Partial<Pick<CliOptions, 'maxTurns' | 'reasoningMode'>> = {}): CliOptions {
  const maxTurns = Object.prototype.hasOwnProperty.call(overrides, 'maxTurns')
    ? overrides.maxTurns
    : session.runtime.maxTurns;
  return {
    provider: session.provider,
    model: session.runtime.selectedModel ?? session.runtime.model,
    ollamaUrl: session.ollamaUrl,
    lmStudioUrl: session.lmStudioUrl,
    geminiApiKey: session.geminiApiKey,
    geminiApiBaseUrl: session.geminiApiBaseUrl,
    prompt: undefined,
    scenario: undefined,
    skills: session.runtime.skills.map((skill) => skill.name),
    cwd: session.runtime.cwd,
    maxTurns,
    maxTokens: session.maxTokens,
    contextTokens: session.contextTokens ?? 262_144,
    temperature: session.temperature ?? 1,
    topP: session.topP ?? 0.95,
    topK: session.topK ?? 64,
    reasoningMode: overrides.reasoningMode ?? session.reasoningMode ?? 'auto',
    ollamaAutoStart: session.ollamaAutoStart ?? true,
    yolo: session.yolo ?? false,
    tui: true,
    acp: false,
    json: false,
    jsonStream: false,
    listSessions: false,
    listModels: false,
    history: session.runtime.history ?? [],
    help: false,
    version: false
  };
}

function formatMaxTurns(maxTurns: number | undefined): string {
  return maxTurns === undefined ? 'unlimited' : String(maxTurns);
}

function plainSnapshot(session: TuiSession): string {
  const latest = session.history.at(-1);
  return [session.flash, latest ? `${latest.kind}: ${latest.text}` : undefined, session.lastStats].filter(Boolean).join('\n') || 'Ready.';
}

function writeLine(output: NodeJS.WritableStream, text: string): void {
  output.write(`${text}\n`);
}

function isTtyOutput(output: NodeJS.WritableStream): boolean {
  return Boolean('isTTY' in output && output.isTTY);
}

function shouldRedraw(lastRenderAt: number): boolean {
  return Date.now() - lastRenderAt >= streamRedrawIntervalMs;
}
