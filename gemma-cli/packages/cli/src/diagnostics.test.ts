import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDiagnosticContext,
  createRunModelActivityRecorder,
  listStoredSessions,
  recordRunError,
  recordRunResult,
  recordRunStart,
  sessionMessages,
  sessionMessagesWithMetadata
} from './diagnostics.js';
import type { CliOptions } from './args.js';

const tempDirs: string[] = [];
const originalDiagnosticsDir = process.env.GEMMA_CLI_DIAGNOSTICS_DIR;

afterEach(async () => {
  if (originalDiagnosticsDir === undefined) {
    delete process.env.GEMMA_CLI_DIAGNOSTICS_DIR;
  } else {
    process.env.GEMMA_CLI_DIAGNOSTICS_DIR = originalDiagnosticsDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('diagnostics', () => {
  it('creates .gemmacli session and event logs for a successful run', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(context, 'hello');
    await recordRunResult(context, runId, {
      answer: 'hi',
      turns: [{ kind: 'final', content: 'hi' }],
      stats: { durationMs: 5, turns: 1, toolCalls: 0 }
    });

    const sessionFile = JSON.parse(await readFile(context.sessionPath, 'utf8')) as { id: string; history: unknown[]; runs: Array<{ status: string }> };
    const events = await readFile(context.eventLogPath, 'utf8');
    expect(context.root).toBe(join(cwd, '.gemmacli'));
    expect(sessionFile.id).toBe(context.session.id);
    expect(sessionFile.history).toHaveLength(2);
    expect(sessionFile.runs[0]?.status).toBe('completed');
    expect(events).toContain('"type":"session_started"');
    expect(events).toContain('"type":"run_completed"');
  });

  it('can store diagnostics outside the workspace with an environment override', async () => {
    const cwd = await tempWorkspace();
    const diagnosticsDir = await tempWorkspace();
    process.env.GEMMA_CLI_DIAGNOSTICS_DIR = diagnosticsDir;

    const context = await createDiagnosticContext(options(cwd));
    const sessions = await listStoredSessions(cwd);

    expect(context.root).toBe(diagnosticsDir);
    expect(context.sessionPath.startsWith(join(diagnosticsDir, 'sessions'))).toBe(true);
    expect(context.eventLogPath.startsWith(join(diagnosticsDir, 'logs'))).toBe(true);
    expect(sessions.map((session) => session.id)).toContain(context.session.id);
    await expect(readFile(join(cwd, '.gemmacli', 'sessions', `${context.session.id}.json`), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('lists and resumes sessions by id prefix', async () => {
    const cwd = await tempWorkspace();
    const first = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(first, 'remember me');
    await recordRunResult(first, runId, {
      answer: 'remembered',
      turns: [{ kind: 'final', content: 'remembered' }],
      stats: { durationMs: 1, turns: 1, toolCalls: 0 }
    });

    const sessions = await listStoredSessions(cwd);
    const resumed = await createDiagnosticContext({ ...options(cwd), resume: sessions[0]?.id.slice(0, 4) });

    expect(resumed.session.id).toBe(first.session.id);
    expect(sessionMessages(resumed.session)).toEqual([
      { role: 'user', content: 'remember me' },
      { role: 'assistant', content: 'remembered' }
    ]);
  });

  it('converts stored tool turns to safe prompt history when resuming', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(context, 'build app');
    await recordRunResult(context, runId, {
      answer: 'done',
      turns: [
        {
          kind: 'tool',
          content: 'wrote app/index.html',
          toolCall: { tool: 'write_file', args: { path: 'app/index.html' } },
          toolResult: { ok: true, output: 'wrote app/index.html' }
        },
        { kind: 'final', content: 'done' }
      ],
      stats: { durationMs: 1, turns: 2, toolCalls: 1 }
    });

    expect(sessionMessages(context.session)).toEqual([
      { role: 'user', content: 'build app' },
      {
        role: 'user',
        content: 'Previous tool result for write_file:\n{"ok":true,"output":"wrote app/index.html"}'
      },
      { role: 'assistant', content: 'done' }
    ]);
  });

  it('reports prompt history compaction metadata for long resumed sessions', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const timestamp = new Date().toISOString();
    context.session.history.push(
      { role: 'user', content: 'original build request', timestamp },
      ...Array.from({ length: 58 }, (_, index) => ({
        role: 'assistant' as const,
        content: `older turn ${index}`,
        timestamp
      }))
    );

    const prepared = sessionMessagesWithMetadata(context.session);
    const runId = await recordRunStart(context, 'continue', prepared.metadata);

    expect(prepared.metadata).toEqual({
      storedMessages: 59,
      promptMessages: 2,
      maxPromptMessages: 24,
      compacted: true,
      omittedMessages: 58,
      firstUserPreserved: true,
      storedToolMessages: 0,
      promptToolMessages: 0,
      omittedToolMessages: 0,
      compactionNoticeInserted: true,
      storedMalformedAssistantMessages: 0,
      promptMalformedAssistantMessages: 0,
      omittedMalformedAssistantMessages: 0
    });
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0]).toEqual({ role: 'user', content: 'original build request' });
    expect(prepared.messages[1]?.content).toContain('Gemma CLI compacted the earlier resumed session history');
    expect(prepared.messages[1]?.content).toContain('Inspect current files or rerun validation before claiming current artifact state or changes.');
    expect(prepared.messages.map((message) => message.role)).toEqual(['user', 'user']);

    const events = await readFile(context.eventLogPath, 'utf8');
    const runStarted = events
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; runId?: string; data?: { promptHistory?: unknown } })
      .find((event) => event.type === 'run_started' && event.runId === runId);
    expect(runStarted?.data?.promptHistory).toEqual(prepared.metadata);
  });

  it('compacts resumed history around intent instead of successful tool noise', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const timestamp = new Date().toISOString();
    context.session.history.push(
      { role: 'user', content: 'build the web racing game and keep iterating', timestamp },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'tool' as const,
        content: `large file read ${index}`,
        timestamp,
        toolCall: { tool: 'read_file', args: { path: `game-${index}.js` } },
        toolResult: { ok: true, output: `file contents ${index}` }
      })),
      { role: 'assistant', content: 'created the first playable game', timestamp },
      { role: 'user', content: 'iteration 2: fix the broken road', timestamp },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: 'tool' as const,
        content: `validation output ${index}`,
        timestamp,
        toolCall: { tool: 'exec_command', args: { command: 'node validate.js' } },
        toolResult: { ok: true, output: `ok ${index}` }
      })),
      { role: 'assistant', content: 'fixed the road and validation passed', timestamp },
      { role: 'user', content: 'iteration 3: keep the intent after compression', timestamp },
      { role: 'assistant', content: 'continued the game after compression', timestamp }
    );

    const prepared = sessionMessagesWithMetadata(context.session);

    expect(prepared.metadata).toMatchObject({
      storedMessages: 56,
      promptMessages: 4,
      maxPromptMessages: 24,
      compacted: true,
      omittedMessages: 53,
      firstUserPreserved: true,
      storedToolMessages: 50,
      promptToolMessages: 0,
      omittedToolMessages: 50,
      compactionNoticeInserted: true,
      storedMalformedAssistantMessages: 0,
      promptMalformedAssistantMessages: 0,
      omittedMalformedAssistantMessages: 0
    });
    expect(prepared.messages).toEqual([
      { role: 'user', content: 'build the web racing game and keep iterating' },
      {
        role: 'user',
        content: [
          'Gemma CLI compacted the earlier resumed session history before this turn.',
          'The original user request and recent user instructions are preserved. Assistant summaries and tool output were omitted as non-authoritative history.',
          'Omitted stored messages: 53; omitted tool result messages: 50.',
          'Treat omitted tool output as unavailable evidence. Inspect current files or rerun validation before claiming current artifact state or changes.'
        ].join('\n')
      },
      { role: 'user', content: 'iteration 2: fix the broken road' },
      { role: 'user', content: 'iteration 3: keep the intent after compression' }
    ]);
  });

  it('drops malformed assistant tool-call text from compacted resume intent', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const timestamp = new Date().toISOString();
    context.session.history.push(
      { role: 'user', content: 'build the web racing game', timestamp },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'tool' as const,
        content: `tool output ${index}`,
        timestamp,
        toolCall: { tool: 'read_file', args: { path: 'game.js' } },
        toolResult: { ok: true, output: `output ${index}` }
      })),
      { role: 'assistant', content: '{“tool”:“search_text”,“args”:{“query”:“center dashes”,“path”:“game.js”}}', timestamp },
      { role: 'user', content: 'continue after malformed tool text', timestamp },
      { role: 'assistant', content: 'recovered and continued', timestamp }
    );

    const prepared = sessionMessagesWithMetadata(context.session);

    expect(prepared.metadata).toMatchObject({
      compacted: true,
      storedMalformedAssistantMessages: 1,
      promptMalformedAssistantMessages: 0,
      omittedMalformedAssistantMessages: 1
    });
    expect(prepared.messages.map((message) => message.content)).not.toContain('{“tool”:“search_text”,“args”:{“query”:“center dashes”,“path”:“game.js”}}');
    expect(prepared.messages).toContainEqual({ role: 'user', content: 'continue after malformed tool text' });
    expect(prepared.messages).not.toContainEqual({ role: 'assistant', content: 'recovered and continued' });
  });

  it('records failed runs with error details', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(context, 'fail');
    await recordRunError(context, runId, new Error('ollama down'));

    const sessionFile = JSON.parse(await readFile(context.sessionPath, 'utf8')) as { runs: Array<{ status: string; error: string }> };
    const events = await readFile(context.eventLogPath, 'utf8');
    expect(sessionFile.runs[0]).toMatchObject({ status: 'failed', error: 'ollama down' });
    expect(events).toContain('"type":"run_failed"');
    expect(events).toContain('ollama down');
  });

  it('preserves partial tool evidence when a run is cancelled', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(context, 'build app');
    const toolCall = { tool: 'write_file', args: { path: 'app/index.html', content: '<!doctype html>' } };

    await recordRunError(context, runId, new Error('user cancelled'), 'cancelled', {
      turns: [{
        kind: 'tool',
        content: 'wrote app/index.html',
        toolCall,
        toolResult: { ok: true, output: 'wrote app/index.html' }
      }],
      pendingToolCalls: [{ tool: 'exec_command', args: { command: 'npm test' } }]
    });

    const sessionFile = JSON.parse(await readFile(context.sessionPath, 'utf8')) as {
      history: Array<{ role: string; content: string; toolCall?: { tool: string }; toolResult?: { ok: boolean } }>;
      runs: Array<{ status: string }>;
    };
    const events = await readFile(context.eventLogPath, 'utf8');

    expect(sessionFile.runs[0]?.status).toBe('cancelled');
    expect(sessionFile.history.map((message) => message.content)).toEqual([
      'build app',
      'wrote app/index.html',
      'Tool started before the run stopped; no final result was recorded.',
      'cancelled: user cancelled'
    ]);
    expect(sessionFile.history[1]).toMatchObject({ role: 'tool', toolCall: { tool: 'write_file' }, toolResult: { ok: true } });
    expect(sessionFile.history[2]).toMatchObject({ role: 'tool', toolCall: { tool: 'exec_command' }, toolResult: { ok: false } });
    expect(events).toContain('"type":"run_cancelled"');
    expect(events).toContain('"partialTurnCount":1');
    expect(events).toContain('"pendingToolCallCount":1');
  });

  it('records full model activity in diagnostics without adding it to chat history', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const runId = await recordRunStart(context, 'build app');
    const modelActivity = createRunModelActivityRecorder(context, runId);

    await modelActivity.record({
      index: 0,
      chunk: {
        thinking: 'inspect files',
        raw: { provider: 'test', delta: 'inspect files' }
      }
    });
    await modelActivity.record({
      index: 0,
      chunk: {
        content: '{"tool":"write_file"}',
        done: true,
        raw: { provider: 'test', delta: '{"tool":"write_file"}' }
      }
    });
    await modelActivity.flush();

    await recordRunError(context, runId, new Error('user cancelled'), 'cancelled', {
      modelOutputs: modelActivity.snapshots()
    });

    const sessionFile = JSON.parse(await readFile(context.sessionPath, 'utf8')) as {
      history: Array<{ role: string; content: string }>;
    };
    const events = (await readFile(context.eventLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as any);
    const activityEvents = events.filter((event) => event.type === 'model_activity');
    const cancelled = events.find((event) => event.type === 'run_cancelled');

    expect(sessionFile.history.map((message) => message.content)).toEqual([
      'build app',
      'cancelled: user cancelled'
    ]);
    expect(activityEvents).toHaveLength(2);
    expect(activityEvents[0].data.chunk).toMatchObject({
      thinking: 'inspect files',
      raw: { provider: 'test', delta: 'inspect files' }
    });
    expect(activityEvents[1].data.chunk).toMatchObject({
      content: '{"tool":"write_file"}',
      done: true,
      raw: { provider: 'test', delta: '{"tool":"write_file"}' }
    });
    expect(cancelled.data.modelOutputs[0]).toMatchObject({
      index: 0,
      thinking: 'inspect files',
      thinkingChars: 13,
      content: '{"tool":"write_file"}',
      contentChars: 21,
      done: true
    });
  });

  it('marks stale running runs as interrupted when a session is resumed', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    await recordRunStart(context, 'long prompt');

    const resumed = await createDiagnosticContext({ ...options(cwd), resume: context.session.id });

    expect(resumed.session.runs[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted')
    });
    expect(resumed.session.history.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('failed: Run interrupted')
    });
    const sessionFile = JSON.parse(await readFile(resumed.sessionPath, 'utf8')) as { runs: Array<{ status: string }> };
    expect(sessionFile.runs[0]?.status).toBe('failed');
  });

  it('stores run-start prompt previews in event logs instead of duplicating huge prompts', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const prompt = 'x'.repeat(5_000);

    await recordRunStart(context, prompt);

    const events = await readFile(context.eventLogPath, 'utf8');
    expect(events).toContain('"promptLength":5000');
    expect(events).toContain('"promptPreview"');
    expect(events).not.toContain(prompt);
  });

  it('serializes concurrent multiline run-start saves without temp-file collisions', async () => {
    const cwd = await tempWorkspace();
    const context = await createDiagnosticContext(options(cwd));
    const prompts = Array.from({ length: 32 }, (_, index) => `pasted prompt ${index}\nsecond line ${index}`);

    await Promise.all(prompts.map((prompt) => recordRunStart(context, prompt)));

    const sessionFile = JSON.parse(await readFile(context.sessionPath, 'utf8')) as { history: Array<{ content: string }>; runs: unknown[] };
    const events = await readFile(context.eventLogPath, 'utf8');
    expect(sessionFile.runs).toHaveLength(prompts.length);
    expect(sessionFile.history.map((message) => message.content)).toEqual(prompts);
    expect(events.match(/"type":"run_started"/g)).toHaveLength(prompts.length);
  });
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemma-cli-diagnostics-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function options(cwd: string): CliOptions {
  return {
    provider: 'ollama',
    cwd,
    skills: [],
    maxTurns: 8,
    contextTokens: 262_144,
    temperature: 1,
    topP: 0.95,
    topK: 64,
    reasoningMode: 'auto',
    ollamaAutoStart: true,
    yolo: false,
    tui: false,
    acp: false,
    json: false,
    jsonStream: false,
    listSessions: false,
    listModels: false,
    help: false,
    version: false
  };
}
