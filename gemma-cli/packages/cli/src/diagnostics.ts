import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentModelActivityEvent, AgentRunResult, ChatMessage, ToolCall, ToolResult } from '@gemma-sdk/agent';
import type { CliOptions } from './args.js';

const maxPromptHistoryMessages = 24;
const maxPromptMessageChars = 2_000;
const maxPromptToolOutputChars = 1_200;
const maxEventPromptPreviewChars = 1_200;
const modelActivityFlushIntervalMs = 250;
const maxBufferedModelActivityEvents = 256;
const sessionSaveQueues = new Map<string, Promise<void>>();

export interface DiagnosticEvent {
  type: string;
  timestamp: string;
  sessionId: string;
  runId?: string;
  data?: Record<string, unknown>;
}

export interface StoredSessionMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export interface StoredSession {
  version: 1;
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: CliOptions['provider'];
  model?: string;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  history: StoredSessionMessage[];
  runs: Array<{
    id: string;
    startedAt: string;
    completedAt?: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stats?: AgentRunResult['stats'];
    error?: string;
  }>;
}

export interface DiagnosticContext {
  root: string;
  logsDir: string;
  sessionsDir: string;
  session: StoredSession;
  sessionPath: string;
  eventLogPath: string;
}

export interface RunErrorEvidence {
  turns?: AgentRunResult['turns'];
  pendingToolCalls?: ToolCall[];
  modelOutputs?: RunModelOutputEvidence[];
}

export interface RunModelOutputEvidence {
  index: number;
  finalization: boolean;
  content?: string;
  contentChars: number;
  thinking?: string;
  thinkingChars: number;
  statuses?: string[];
  done?: boolean;
  doneReason?: string;
}

export interface RunCompletionEvidence {
  modelOutputs?: RunModelOutputEvidence[];
}

export async function createDiagnosticContext(options: CliOptions): Promise<DiagnosticContext> {
  const cwd = resolve(options.cwd);
  const root = diagnosticRoot(cwd);
  const logsDir = join(root, 'logs');
  const sessionsDir = join(root, 'sessions');
  await mkdir(logsDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  const resolved = options.resume ? await resolveSession(sessionsDir, cwd, options.resume) : undefined;
  if (options.resume && options.resume !== 'latest' && !resolved) {
    throw new Error(`Session not found for --resume ${options.resume}. Run gemma --list-sessions to see available sessions.`);
  }
  const session = resolved?.session ?? newSession(cwd, options);
  const recoveredRuns = resolved ? markInterruptedRuns(session, new Date().toISOString()) : 0;
  const sessionPath = resolved?.path ?? join(sessionsDir, `${session.id}.json`);
  const eventLogPath = join(logsDir, `${session.id}.jsonl`);
  await saveSession(sessionPath, session);
  await appendEvent(eventLogPath, {
    type: resolved ? 'session_resumed' : 'session_started',
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    data: {
      ...diagnosticOptions(options),
      ...(recoveredRuns > 0 ? { recoveredInterruptedRuns: recoveredRuns } : {})
    }
  });

  return { root, logsDir, sessionsDir, session, sessionPath, eventLogPath };
}

export async function listStoredSessions(cwd: string): Promise<StoredSession[]> {
  const sessionsDir = join(diagnosticRoot(cwd), 'sessions');
  try {
    const files = await readdir(sessionsDir);
    const sessions = await Promise.all(
      files.filter((file) => file.endsWith('.json')).map(async (file) => readSession(join(sessionsDir, file)))
    );
    return sessions
      .filter((session): session is StoredSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function diagnosticRoot(cwd: string): string {
  const override = process.env.GEMMA_CLI_DIAGNOSTICS_DIR?.trim();
  return override ? resolve(override) : join(resolve(cwd), '.gemmacli');
}

export async function recordRunStart(context: DiagnosticContext, prompt: string): Promise<string> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  context.session.updatedAt = startedAt;
  context.session.runs.push({ id: runId, startedAt, status: 'running' });
  context.session.history.push({ role: 'user', content: prompt, timestamp: startedAt });
  await saveSession(context.sessionPath, context.session);
  await appendEvent(context.eventLogPath, {
    type: 'run_started',
    timestamp: startedAt,
    sessionId: context.session.id,
    runId,
    data: {
      promptLength: prompt.length,
      promptPreview: truncateForPrompt(prompt, maxEventPromptPreviewChars)
    }
  });
  return runId;
}

export async function recordRunResult(context: DiagnosticContext, runId: string, result: AgentRunResult, evidence: RunCompletionEvidence = {}): Promise<void> {
  const timestamp = new Date().toISOString();
  context.session.updatedAt = timestamp;
  const run = context.session.runs.find((item) => item.id === runId);
  if (run) {
    run.status = 'completed';
    run.completedAt = timestamp;
    run.stats = result.stats;
  }
  for (const turn of result.turns) {
    context.session.history.push({
      role: turn.kind === 'tool' ? 'tool' : 'assistant',
      content: turn.content,
      timestamp,
      toolCall: turn.toolCall,
      toolResult: turn.toolResult
    });
  }
  await saveSession(context.sessionPath, context.session);
  await appendEvent(context.eventLogPath, {
    type: 'run_completed',
    timestamp,
    sessionId: context.session.id,
    runId,
    data: {
      stats: result.stats,
      completionStatus: result.completionStatus,
      completionReason: result.completionReason,
      answer: result.answer,
      answerLength: result.answer.length,
      turns: result.turns,
      ...modelOutputEventData(evidence.modelOutputs)
    }
  });
}

export async function recordRunError(
  context: DiagnosticContext,
  runId: string,
  error: unknown,
  status: 'failed' | 'cancelled' = 'failed',
  evidence: RunErrorEvidence = {}
): Promise<void> {
  const timestamp = new Date().toISOString();
  const formatted = formatError(error);
  context.session.updatedAt = timestamp;
  const run = context.session.runs.find((item) => item.id === runId);
  if (run) {
    run.status = status;
    run.completedAt = timestamp;
    run.error = typeof formatted.message === 'string' ? formatted.message : String(formatted.message);
  }
  appendRunEvidence(context.session.history, evidence, timestamp);
  context.session.history.push({ role: 'assistant', content: `${status}: ${formatted.message}`, timestamp });
  await saveSession(context.sessionPath, context.session);
  await appendEvent(context.eventLogPath, {
    type: status === 'cancelled' ? 'run_cancelled' : 'run_failed',
    timestamp,
    sessionId: context.session.id,
    runId,
    data: {
      ...formatted,
      ...(evidence.turns?.length ? { turns: evidence.turns } : {}),
      ...(evidence.turns?.length ? { partialTurnCount: evidence.turns.length } : {}),
      ...(evidence.pendingToolCalls?.length ? { pendingToolCalls: evidence.pendingToolCalls } : {}),
      ...(evidence.pendingToolCalls?.length ? { pendingToolCallCount: evidence.pendingToolCalls.length } : {}),
      ...modelOutputEventData(evidence.modelOutputs)
    }
  });
}

export async function recordSessionModelSelection(context: DiagnosticContext, provider: CliOptions['provider'], model: string): Promise<void> {
  const timestamp = new Date().toISOString();
  context.session.updatedAt = timestamp;
  context.session.provider = provider;
  context.session.model = model;
  await saveSession(context.sessionPath, context.session);
  await appendEvent(context.eventLogPath, {
    type: 'model_selected',
    timestamp,
    sessionId: context.session.id,
    data: { provider, model }
  });
}

export async function appendEvent(logPath: string, event: DiagnosticEvent): Promise<void> {
  await writeFile(logPath, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

async function appendEvents(logPath: string, events: DiagnosticEvent[]): Promise<void> {
  if (events.length === 0) return;
  await writeFile(logPath, events.map((event) => `${JSON.stringify(event)}\n`).join(''), { flag: 'a' });
}

export function createRunModelActivityRecorder(context?: DiagnosticContext, runId?: string): {
  record(event: AgentModelActivityEvent): Promise<void>;
  flush(): Promise<void>;
  snapshots(): RunModelOutputEvidence[];
} {
  const outputs = new Map<string, RunModelOutputEvidence>();
  const pendingEvents: DiagnosticEvent[] = [];
  let sequence = 0;
  let scheduledFlush: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<void> | undefined;
  let flushError: unknown;

  const flushPendingEvents = async (): Promise<void> => {
    if (!context || !runId) return;
    if (scheduledFlush) {
      clearTimeout(scheduledFlush);
      scheduledFlush = undefined;
    }
    if (activeFlush) {
      await activeFlush;
    }
    if (flushError) {
      throw flushError;
    }
    while (pendingEvents.length > 0) {
      const batch = pendingEvents.splice(0);
      activeFlush = appendEvents(context.eventLogPath, batch);
      try {
        await activeFlush;
      } catch (error) {
        flushError = error;
        throw error;
      } finally {
        activeFlush = undefined;
      }
    }
  };

  const scheduleFlush = (): void => {
    if (!context || !runId || scheduledFlush) return;
    scheduledFlush = setTimeout(() => {
      scheduledFlush = undefined;
      void flushPendingEvents().catch((error: unknown) => {
        flushError = error;
      });
    }, modelActivityFlushIntervalMs);
    scheduledFlush.unref?.();
  };

  const requestFlush = (): void => {
    void flushPendingEvents().catch((error: unknown) => {
      flushError = error;
    });
  };

  return {
    async record(event) {
      if (flushError) {
        throw flushError;
      }
      const key = `${event.finalization === true ? 'final' : 'turn'}:${event.index}`;
      const output = outputs.get(key) ?? {
        index: event.index,
        finalization: event.finalization === true,
        contentChars: 0,
        thinkingChars: 0
      };
      const { chunk } = event;
      if (chunk.content) {
        output.content = `${output.content ?? ''}${chunk.content}`;
        output.contentChars += chunk.content.length;
      }
      if (chunk.thinking) {
        output.thinking = `${output.thinking ?? ''}${chunk.thinking}`;
        output.thinkingChars += chunk.thinking.length;
      }
      if (chunk.status) {
        output.statuses = [...(output.statuses ?? []), chunk.status];
      }
      if (chunk.done === true) {
        output.done = true;
      }
      if (chunk.doneReason) {
        output.doneReason = chunk.doneReason;
      }
      outputs.set(key, output);
      if (context && runId) {
        pendingEvents.push({
          type: 'model_activity',
          timestamp: new Date().toISOString(),
          sessionId: context.session.id,
          runId,
          data: {
            sequence: sequence++,
            index: event.index,
            finalization: event.finalization === true,
            chunk
          }
        });
        if (pendingEvents.length >= maxBufferedModelActivityEvents) {
          requestFlush();
        } else {
          scheduleFlush();
        }
      }
    },
    async flush() {
      await flushPendingEvents();
    },
    snapshots() {
      return [...outputs.values()]
        .filter((output) => output.contentChars > 0 || output.thinkingChars > 0 || Boolean(output.statuses?.length) || output.done === true || Boolean(output.doneReason))
        .sort((a, b) => Number(a.finalization) - Number(b.finalization) || a.index - b.index);
    }
  };
}

export function sessionMessages(session: StoredSession): ChatMessage[] {
  return compactStoredHistoryForPrompt(session.history).map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: message.role === 'tool'
      ? formatStoredToolMessageForPrompt(message)
      : truncateForPrompt(message.content, maxPromptMessageChars)
  }));
}

function formatStoredToolMessageForPrompt(message: StoredSessionMessage): string {
  const toolName = message.toolCall?.tool ?? 'tool';
  const output = truncateForPrompt(message.toolResult?.output ?? message.content, maxPromptToolOutputChars);
  return [
    `Previous tool result for ${toolName}:`,
    JSON.stringify({
      ok: message.toolResult?.ok ?? true,
      output
    })
  ].join('\n');
}

function compactStoredHistoryForPrompt(history: StoredSessionMessage[]): StoredSessionMessage[] {
  if (history.length <= maxPromptHistoryMessages) {
    return history;
  }
  const firstUser = history.find((message) => message.role === 'user');
  const recent = history.slice(-maxPromptHistoryMessages);
  if (!firstUser || recent.includes(firstUser)) {
    return recent;
  }
  return [firstUser, ...recent.slice(1)];
}

function truncateForPrompt(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n... [truncated ${content.length - maxChars} chars; inspect files/tools again if needed]`;
}

function markInterruptedRuns(session: StoredSession, timestamp: string): number {
  const message = 'Run interrupted before Gemma CLI recorded completion. The previous process likely exited or crashed.';
  let count = 0;
  for (const run of session.runs) {
    if (run.status !== 'running') {
      continue;
    }
    run.status = 'failed';
    run.completedAt = timestamp;
    run.error = message;
    count += 1;
  }
  if (count > 0) {
    session.updatedAt = timestamp;
    session.history.push({ role: 'assistant', content: `failed: ${message}`, timestamp });
  }
  return count;
}

function appendRunEvidence(history: StoredSessionMessage[], evidence: RunErrorEvidence, timestamp: string): void {
  const turns = evidence.turns ?? [];
  for (const turn of turns) {
    history.push({
      role: turn.kind === 'tool' ? 'tool' : 'assistant',
      content: turn.content,
      timestamp,
      toolCall: turn.toolCall,
      toolResult: turn.toolResult
    });
  }

  for (const toolCall of evidence.pendingToolCalls ?? []) {
    history.push({
      role: 'tool',
      content: 'Tool started before the run stopped; no final result was recorded.',
      timestamp,
      toolCall,
      toolResult: {
        ok: false,
        output: 'Tool started before the run stopped; no final result was recorded.',
        meta: { presentation: 'notice' }
      }
    });
  }
}

function modelOutputEventData(modelOutputs: RunModelOutputEvidence[] | undefined): Record<string, unknown> {
  if (!modelOutputs?.length) {
    return {};
  }
  return {
    modelOutputCount: modelOutputs.length,
    modelOutputs
  };
}

function newSession(cwd: string, options: CliOptions): StoredSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: shortId(),
    cwd,
    title: relative(process.cwd(), cwd) || cwd,
    createdAt: now,
    updatedAt: now,
    provider: options.provider,
    model: options.model,
    ollamaUrl: options.ollamaUrl,
    lmStudioUrl: options.lmStudioUrl,
    history: [],
    runs: []
  };
}

async function resolveSession(sessionsDir: string, cwd: string, id: string): Promise<{ path: string; session: StoredSession } | undefined> {
  const sessions = await listStoredSessions(cwd);
  const session = id === 'latest' ? sessions[0] : sessions.find((item) => item.id === id || item.id.startsWith(id));
  if (!session) {
    return undefined;
  }
  return { path: join(sessionsDir, `${session.id}.json`), session };
}

async function readSession(path: string): Promise<StoredSession | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as StoredSession;
    if (parsed.version === 1 && typeof parsed.id === 'string' && Array.isArray(parsed.history)) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function saveSession(path: string, session: StoredSession): Promise<void> {
  const snapshot = `${JSON.stringify(session, null, 2)}\n`;
  const previous = sessionSaveQueues.get(path) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeSessionSnapshot(path, snapshot));

  sessionSaveQueues.set(path, current);
  try {
    await current;
  } finally {
    if (sessionSaveQueues.get(path) === current) {
      sessionSaveQueues.delete(path);
    }
  }
}

async function writeSessionSnapshot(path: string, snapshot: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, snapshot);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function diagnosticOptions(options: CliOptions): Record<string, unknown> {
  return {
    cwd: resolve(options.cwd),
    provider: options.provider,
    model: options.model,
    ollamaUrl: options.ollamaUrl,
    lmStudioUrl: options.lmStudioUrl,
    maxTurns: options.maxTurns,
    maxTokens: options.maxTokens,
    reasoningMode: options.reasoningMode,
    yolo: options.yolo,
    tui: options.tui,
    acp: options.acp,
    json: options.json,
    jsonStream: options.jsonStream,
    node: process.version,
    platform: process.platform,
    pid: process.pid
  };
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack } : error.cause
    };
  }
  return { message: String(error) };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
