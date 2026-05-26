import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentTurn, ModelProvider } from '@gemma-sdk/agent';
import {
  appendInterruptedRunToRuntimeHistory,
  clearTerminal,
  commands,
  completeSlashInput,
  defaultStartupModelSelection,
  formatUserPromptForHistory,
  addHistory,
  handleTuiLine,
  preferredModelIndex,
  scrollHistory,
  slashSuggestions,
  startupDisclaimerText,
  startupModelSelectionFor,
  storedSessionHistoryToTuiEntries,
  visibleHistoryWithStartupDisclaimer,
  type TuiSession
} from './tui.js';
import { parseShellInput } from './shell.js';
import { createDiagnosticContext, recordRunResult, recordRunStart } from './diagnostics.js';
import type { CliOptions } from './args.js';
import type { Runtime } from './runtime.js';
import { renderTuiFrame, type TuiHistoryEntry } from './tuiRenderer.js';
import { cliVersion } from './version.js';

class BufferOutput extends Writable {
  data = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.data += chunk.toString();
    callback();
  }
}

function cliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: 'ollama',
    skills: [],
    cwd: '/repo',
    maxTurns: 8,
    contextTokens: 262_144,
    temperature: 1,
    topP: 0.95,
    topK: 64,
    reasoningMode: 'auto',
    ollamaAutoStart: true,
    yolo: false,
    tui: true,
    acp: false,
    json: false,
    jsonStream: false,
    listSessions: false,
    listModels: false,
    help: false,
    version: false,
    ...overrides
  };
}

describe('TUI commands', () => {
  const provider: ModelProvider = {
    name: 'test',
    async generate() {
      return '{"answer":"ok"}';
    }
  };
  const stream = async function* () {
    yield { content: 'ok', done: true };
  };

  it('defaults startup model selection to Ollama 26B on first launch', () => {
    expect(startupModelSelectionFor(cliOptions())).toEqual({
      preferred: defaultStartupModelSelection,
      source: 'default'
    });
  });

  it('prefers the last selected local model over the first-run default', () => {
    expect(startupModelSelectionFor(cliOptions(), undefined, {
      version: 1,
      provider: 'lmstudio',
      model: 'google/gemma-4-26b-a4b',
      updatedAt: '2026-05-03T00:00:00.000Z'
    })).toEqual({
      preferred: { provider: 'lmstudio', model: 'google/gemma-4-26b-a4b' },
      source: 'preference'
    });
  });

  it('uses an explicit local model request before stored preferences', () => {
    expect(startupModelSelectionFor(
      cliOptions({ provider: 'ollama', model: 'gemma4:31b' }),
      undefined,
      {
        version: 1,
        provider: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
        updatedAt: '2026-05-03T00:00:00.000Z'
      }
    )).toEqual({
      preferred: { provider: 'ollama', model: 'gemma4:31b' },
      source: 'explicit'
    });
  });

  it('adds the startup disclaimer as a visible history entry that clear can remove', () => {
    const history = visibleHistoryWithStartupDisclaimer([{ kind: 'assistant', text: 'prior answer' }]);

    expect(history).toEqual([
      { kind: 'disclaimer', text: startupDisclaimerText },
      { kind: 'assistant', text: 'prior answer' }
    ]);
  });

  it('finds the preferred startup model in discovered local models', () => {
    const models = [
      { name: 'google/gemma-4-26b-a4b', provider: 'lmstudio' as const },
      { name: 'gemma4:26b', provider: 'ollama' as const }
    ];

    expect(preferredModelIndex(models, defaultStartupModelSelection)).toBe(1);
    expect(preferredModelIndex(models, { provider: 'ollama', model: 'missing' })).toBe(-1);
  });

  it('prints stats when available', async () => {
    const output = new BufferOutput();
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0,
      lastStats: 'stats: model=gemma4:26b turns=1 tools=0 durationMs=10'
    };

    await expect(handleTuiLine(session, '/stats', output)).resolves.toBe(true);
    expect(output.data).toContain('stats shown');
    expect(output.data).toContain('turns=1');
  });

  it('blocks slash commands while an agent run is active', async () => {
    const output = new BufferOutput();
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0,
      agentRunning: true
    };

    await expect(handleTuiLine(session, '/status', output)).resolves.toBe(true);
    expect(session.history).toEqual([
      {
        kind: 'notice',
        text: expect.stringContaining('Slash commands are disabled while the agent is running')
      }
    ]);
    expect(session.flash).toBe('slash command blocked during run');
  });

  it('prints detailed runtime status with exact context byte estimates', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [{ name: 'test-skill', path: '/skills/test.md', content: 'skill' }],
        tools: [],
        cwd: '/repo',
        maxTurns: 8,
        model: 'gemma4:26b',
        contextTokens: 262144,
        systemPromptTokens: 2600,
        history: [{ role: 'user' as const, content: 'hello' }],
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{ kind: 'assistant' as const, text: 'visible' }],
      scrollOffset: 0,
      lastStats: 'stats: model=gemma4:26b turns=1 tools=0 durationMs=10'
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/status', output)).resolves.toBe(true);

    expect(output.data).toContain('status shown');
    expect(session.history.at(-1)?.kind).toBe('status');
    const status = session.history.at(-1)?.text ?? '';
    expect(status).toContain('Runtime');
    expect(status).toContain('  provider: ollama');
    expect(status).toContain('  model: gemma4:26b');
    expect(status).toContain('Generation');
    expect(status).toContain('thinking: enabled');
    expect(status).toContain('contextUsedBytes:');
    expect(status).toContain('systemPromptTokens: 2600');
  });

  it('shows the exact runtime system prompt without adding it to runtime chat history', async () => {
    const output = new BufferOutput();
    const systemPrompt = '<workspace_build_rules>\nTool: apply_patch\n</workspace_build_rules>';
    const runtimeHistory = [{ role: 'user' as const, content: 'hello' }];
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 8,
        model: 'gemma4:26b',
        systemPrompt,
        history: runtimeHistory,
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/debug:prompt', output)).resolves.toBe(true);

    expect(session.history).toEqual([{ kind: 'status', text: systemPrompt }]);
    expect(session.runtime.history).toBe(runtimeHistory);
    expect(output.data).toContain('system prompt shown');
    expect(output.data).toContain(systemPrompt);
  });

  it('clears all visible history entries without clearing runtime chat history', async () => {
    const output = new BufferOutput();
    const runtimeHistory = [{ role: 'user' as const, content: 'keep me' }];
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 8,
        model: 'gemma4:26b',
        history: runtimeHistory,
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [
        { kind: 'status' as const, text: 'Status\nold' },
        { kind: 'command' as const, text: 'History\nold' },
        { kind: 'tool' as const, text: 'exec_command\nok\nold' }
      ],
      historyRevision: 4,
      scrollOffset: 2
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/clear', output)).resolves.toBe(true);

    expect(session.history).toEqual([]);
    expect(session.scrollOffset).toBe(0);
    expect(session.historyRevision).toBe(5);
    expect(session.runtime.history).toBe(runtimeHistory);
    expect(output.data).toContain('history cleared');
    expect(output.data).not.toContain('Status\nold');
  });

  it('can clear terminal scrollback for explicit clear-screen actions', () => {
    const output = new BufferOutput() as BufferOutput & { isTTY: true };
    output.isTTY = true;

    clearTerminal(output);
    expect(output.data).toBe('\x1b[2J\x1b[H');

    const scrollbackOutput = new BufferOutput() as BufferOutput & { isTTY: true };
    scrollbackOutput.isTTY = true;
    clearTerminal(scrollbackOutput, { scrollback: true });
    expect(scrollbackOutput.data).toBe('\x1b[2J\x1b[3J\x1b[H');
  });

  it('runs allowlisted commands through the tool layer', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        },
        tools: [
          {
            name: 'exec_command',
            description: 'run',
            async run(args: Record<string, unknown>) {
              return { ok: true, output: String(args.command) };
            }
          }
        ]
      },
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/run pwd', output)).resolves.toBe(true);
    expect(output.data).toContain('pwd');
  });

  it('runs shell commands through exec_command', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        },
        tools: [
          {
            name: 'exec_command',
            description: 'shell',
            async run(args: Record<string, unknown>) {
              return { ok: true, output: `ran ${String(args.command)}` };
            }
          }
        ]
      },
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '! npm test', output)).resolves.toBe(true);
    expect((session as TuiSession).lastShellCommand).toBe('npm test');
    expect(output.data).toContain('ran npm test');
  });

  it('shows installed skills in the skills command', async () => {
    const output = new BufferOutput();
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-tui-skills-'));
    await mkdir(join(cwd, '.gemma', 'skills', 'react-app-builder'), { recursive: true });
    await writeFile(join(cwd, '.gemma', 'skills', 'react-app-builder', 'SKILL.md'), [
      '---',
      'name: React App Builder',
      'description: Build solid React apps.',
      '---',
      '',
      '# React App Builder',
      '',
      'Build solid React apps.',
      ''
    ].join('\n'), 'utf8');
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd,
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/skills', output)).resolves.toBe(true);

    expect(session.history.at(-1)?.text).toContain('React App Builder');
    expect(session.history.at(-1)?.text).toContain('Build solid React apps.');
  });

  it('renders banner, history, bordered input, and footer', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        contextTokens: 262144,
        systemPromptTokens: 2600,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{ kind: 'assistant', text: 'hello' }],
      scrollOffset: 0,
      flash: 'ready'
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 120, height: 14, color: false });

    expect(frame).toContain(`Gemma CLI v${cliVersion()}`);
    expect(frame).toContain('  hello');
    expect(frame).not.toMatch(/• gemma/);
    expect(frame).not.toMatch(/› you/);
    expect(frame).toContain('> Send a message');
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    expect(frame).toContain('gemma4:e4b');
    expect(frame).toContain('~1% used');
    expect(frame).not.toContain('Type your message');
    expect(frame).not.toContain('directory');
    expect(frame).not.toContain('▟█');
  });

  it('keeps the snapshot frame within terminal height when suggestions are visible', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: Array.from({ length: 12 }, (_, index) => ({ kind: 'assistant' as const, text: `line ${index + 1}` })),
      scrollOffset: 0,
      commandSuggestions: Array.from({ length: 8 }, (_, index) => ({
        name: `/command-${index + 1}`,
        description: 'suggestion'
      }))
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 80, height: 12, color: false });

    expect(frame.split('\n')).toHaveLength(12);
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
  });

  it('shows the full default model name in the banner', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        contextTokens: 262144,
        systemPromptTokens: 2600,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [],
      scrollOffset: 0
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 120, height: 14, color: false });

    expect(frame).toContain('Gemma 4 26B (gemma4:26b)');
    expect(frame).toContain('gemma4_profile  ·  gemma4:26b');
    expect(frame).toContain('gemma4:26b');
    expect(frame).toContain('~1% used');
  });

  it('formats markdown blocks inside assistant body', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{ kind: 'assistant', text: '# Plan\n- Build UI\n> keep it small\n```html\n<div>ok</div>\n```' }],
      scrollOffset: 0
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 80, height: 24, color: false });

    expect(frame).not.toMatch(/• gemma/);
    expect(frame).toContain('Plan');
    expect(frame).toContain('• Build UI');
    expect(frame).toContain('keep it small');
    expect(frame).toContain('┌─ html');
    expect(frame).toContain('<div>');
    expect(frame).toContain('└─');
  });

  it('summarizes a tool entry on a single header line with status', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{ kind: 'tool', text: 'write_file app/index.html\nok\nbytes: 11' }],
      scrollOffset: 0
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 80, height: 24, color: false });

    expect(frame).toContain('⏺ tool write_file app/index.html');
    expect(frame).toContain('· ok');
    expect(frame).toContain('bytes: 11');
  });

  it('formats tables, bold inline, and ansi colors end-to-end in the frame', () => {
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{
        kind: 'assistant',
        text: 'Pick **one**:\n\n| col | value |\n| --- | --- |\n| ts | great |\n| js | ok |\n\n```ts\nconst x = 1\n```'
      }],
      scrollOffset: 0
    } satisfies TuiSession;

    const plain = renderTuiFrame(session, { width: 80, height: 30, color: false });
    expect(plain).toContain('one');
    expect(plain).toMatch(/col\s+│\s+value/);
    expect(plain).toContain('────┼──');
    expect(plain).toMatch(/ts\s+│\s+great/);
    expect(plain).toContain('┌─ ts');
    expect(plain).toContain('const x = 1');

    const colored = renderTuiFrame(session, { width: 80, height: 30, color: true });
    expect(colored).toContain('\x1b[');
    expect(colored).toContain('\x1b[1m');
    expect(colored).toContain('one');
  });

  it('keeps long status bodies expanded but collapses long tool output', () => {
    const longStatus = ['Status', ...Array.from({ length: 20 }, (_, index) => `line ${index + 1}: value`)].join('\n');
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [{ kind: 'status' as const, text: longStatus }],
      scrollOffset: 0
    } satisfies TuiSession;

    const frame = renderTuiFrame(session, { width: 100, height: 40, color: false });

    expect(frame).toContain('◆ status');
    expect(frame).toContain('line 20: value');
    expect(frame).not.toContain('more line');

    const toolSession: TuiSession = {
      ...session,
      history: [{ kind: 'tool', text: ['exec_command npm test', 'ok', ...Array.from({ length: 20 }, (_, index) => `tool line ${index + 1}`)].join('\n') }]
    };
    const toolFrame = renderTuiFrame(toolSession, { width: 100, height: 40, color: false });
    expect(toolFrame).toContain('⏺ tool exec_command npm test');
    expect(toolFrame).toContain('· ok');
    expect(toolFrame).toContain('more line');
  });

  it('restores visual history entries from stored session messages', () => {
    const history = storedSessionHistoryToTuiEntries([
      { role: 'user', content: 'build app', timestamp: '2026-05-02T00:00:00.000Z' },
      {
        role: 'tool',
        content: 'wrote app/index.html',
        timestamp: '2026-05-02T00:00:01.000Z',
        toolCall: { tool: 'write_file', args: { path: 'app/index.html', content: '<!doctype html>' } },
        toolResult: { ok: true, output: 'wrote app/index.html' }
      },
      {
        role: 'tool',
        content: 'Run the command first.',
        timestamp: '2026-05-02T00:00:01.500Z',
        toolCall: { tool: 'finalize_build', args: { validation: [] } },
        toolResult: { ok: false, output: 'Run the command first.', meta: { presentation: 'notice' } }
      },
      { role: 'assistant', content: 'done', timestamp: '2026-05-02T00:00:02.000Z' },
      { role: 'assistant', content: 'failed: ollama down', timestamp: '2026-05-02T00:00:03.000Z' }
    ]);

    expect(history).toEqual([
      { kind: 'user', text: 'build app' },
      { kind: 'tool', text: expect.stringContaining('write_file app/index.html') },
      { kind: 'notice', text: expect.stringContaining('finalize_build') },
      { kind: 'assistant', text: 'done' },
      { kind: 'error', text: 'failed: ollama down' }
    ]);
  });

  it('collapses large pasted prompts in visual history but leaves a diagnostic hint', () => {
    const prompt = Array.from({ length: 120 }, (_, index) => `<div>${index}</div>`).join('\n');
    const text = formatUserPromptForHistory(prompt);

    expect(text.length).toBeLessThan(prompt.length);
    expect(text).toContain('display truncated');
    expect(text).toContain('model received full prompt');
    expect(text).toContain('full prompt saved in diagnostics');

    const history = storedSessionHistoryToTuiEntries([
      { role: 'user', content: prompt, timestamp: '2026-05-02T00:00:00.000Z' }
    ]);
    expect(history[0]?.text).toBe(text);
  });

  it('lists prior sessions and resumes one by number inside the TUI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-cli-tui-resume-'));
    try {
      const previous = await createDiagnosticContext(cliOptions({
        cwd,
        provider: 'lmstudio',
        model: 'previous-model'
      }));
      const runId = await recordRunStart(previous, 'remember this');
      await recordRunResult(previous, runId, {
        answer: 'remembered',
        turns: [{ kind: 'final' as const, content: 'remembered' }],
        stats: { durationMs: 1, turns: 1, toolCalls: 0 }
      });

      const current = await createDiagnosticContext(cliOptions({
        cwd,
        provider: 'lmstudio',
        model: 'current-model'
      }));
      const output = new BufferOutput();
      const session: TuiSession = {
        runtime: {
          provider,
          skills: [],
          tools: [],
          cwd,
          maxTurns: 8,
          model: 'current-model',
          stream,
          async run() {
            return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
          }
        } satisfies Runtime,
        provider: 'lmstudio' as const,
        diagnostics: current,
        history: [] as TuiHistoryEntry[],
        scrollOffset: 0,
        contextTokens: 262_144,
        temperature: 1,
        topP: 0.95,
        topK: 64,
        reasoningMode: 'auto' as const,
        ollamaAutoStart: true,
        yolo: false
      };

      await expect(handleTuiLine(session, '/sessions', output)).resolves.toBe(true);
      expect(session.history.at(-1)?.text).toContain(`1. ${previous.session.id}`);
      expect(session.history.at(-1)?.text).not.toContain(current.session.id);

      await expect(handleTuiLine(session, '/resume 1', output)).resolves.toBe(true);

      expect(session.diagnostics?.session.id).toBe(previous.session.id);
      expect(session.runtime.model).toBe('previous-model');
      expect(session.runtime.history).toEqual([
        { role: 'user', content: 'remember this' },
        { role: 'assistant', content: 'remembered' }
      ]);
      expect(session.history.map((entry) => entry.text).join('\n')).toContain('remembered');
      expect(session.history.at(-1)).toMatchObject({ kind: 'command', text: `resumed session ${previous.session.id}` });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records live tool progress as flat history entries', async () => {
    const output = new BufferOutput();
    const toolCall = {
      tool: 'write_file',
      args: { path: 'app/index.html', content: '<!doctype html>' }
    };
    const toolTurn = {
      kind: 'tool' as const,
      content: 'wrote app/index.html',
      toolCall,
      toolResult: { ok: true, output: 'wrote app/index.html' }
    };
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:e4b',
        stream,
        async run(_prompt: string, options) {
          await options?.onToolStart?.({ index: 0, toolCall });
          await options?.onTurn?.({ index: 0, turn: toolTurn });
          return {
            answer: 'done',
            turns: [toolTurn, { kind: 'final' as const, content: 'done' }],
            stats: { durationMs: 1, turns: 2, toolCalls: 1 }
          };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, 'build app', output)).resolves.toBe(true);

    const toolEntries = session.history.filter((entry) => entry.kind === 'tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.text).toContain('write_file app/index.html');
    expect(toolEntries[0]?.text).toContain('ok');
    expect(toolEntries[0]?.text).toContain('content: 15 chars');
    expect(toolEntries[0]?.text).toContain('wrote app/index.html');
    expect(session.history.at(-1)).toMatchObject({ kind: 'assistant', text: 'done' });
    expect((session as TuiSession).flash).toMatch(/^run complete \(\d+:\d{2}\)$/);
  });

  it('keeps a cancelled prompt in runtime context even without completed turns', () => {
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:31b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    };

    appendInterruptedRunToRuntimeHistory(
      session,
      'make me a side scroller game',
      [],
      'cancelled',
      'This operation was aborted'
    );

    expect(session.runtime.history).toEqual([
      { role: 'user', content: 'make me a side scroller game' },
      { role: 'assistant', content: 'cancelled: This operation was aborted' }
    ]);
  });

  it('keeps completed tool evidence from a cancelled run in runtime context', () => {
    const toolTurn: AgentTurn = {
      kind: 'tool',
      content: 'wrote test-projects/game04/index.html',
      toolCall: {
        tool: 'write_file',
        args: { path: 'test-projects/game04/index.html', content: '<!doctype html>' }
      },
      toolResult: { ok: true, output: 'wrote test-projects/game04/index.html' }
    };
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '/repo',
        maxTurns: 4,
        model: 'gemma4:31b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    };

    appendInterruptedRunToRuntimeHistory(
      session,
      'make the game in test-projects/game04',
      [toolTurn],
      'cancelled',
      'This operation was aborted'
    );

    expect(session.runtime.history?.[0]).toEqual({
      role: 'user',
      content: 'make the game in test-projects/game04'
    });
    expect(session.runtime.history?.[1]?.role).toBe('user');
    expect(session.runtime.history?.[1]?.content).toContain('Tool result for write_file:');
    expect(session.runtime.history?.[1]?.content).toContain('wrote test-projects/game04/index.html');
    expect(session.runtime.history?.[2]).toEqual({
      role: 'assistant',
      content: 'cancelled: This operation was aborted'
    });
  });

  it('updates maxTurns through settings command', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: process.cwd(),
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'lmstudio',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/settings maxTurns 3', output)).resolves.toBe(true);
    expect(session.runtime.maxTurns).toBe(3);
    expect(session.history[session.history.length - 1]?.text).toContain('maxTurns set to 3');

    await expect(handleTuiLine(session, '/settings maxTurns unlimited', output)).resolves.toBe(true);
    expect(session.runtime.maxTurns).toBeUndefined();
    expect(session.history[session.history.length - 1]?.text).toContain('maxTurns set to unlimited');
  });

  it('shows and updates thinking mode through slash command', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: process.cwd(),
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'lmstudio',
      reasoningMode: 'auto' as const,
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/think', output)).resolves.toBe(true);
    expect(session.history.at(-1)?.text).toContain('mode: auto');

    await expect(handleTuiLine(session, '/think off', output)).resolves.toBe(true);
    expect(session.reasoningMode).toBe('off');
    expect(session.history.at(-1)?.text).toContain('mode set to off');
  });

  it('shows and updates provider endpoints through slash command without editing config files', async () => {
    const output = new BufferOutput();
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-cli-tui-endpoint-'));
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd,
        maxTurns: 8,
        model: 'gemini-3.5-flash',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'gemini',
      reasoningMode: 'auto' as const,
      contextTokens: 262_144,
      temperature: 1,
      topP: 0.95,
      topK: 64,
      ollamaAutoStart: true,
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    };

    await expect(handleTuiLine(session, '/endpoint', output)).resolves.toBe(true);
    expect(session.history.at(-1)?.text).toContain('/endpoint ollama http://100.104.166.87:11434');

    await expect(handleTuiLine(session, '/endpoint generativelanguage.googleapis.com', output)).resolves.toBe(true);
    expect(session.geminiApiBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(session.history.at(-1)?.text).toContain('runtime reloaded');

    await expect(handleTuiLine(session, '/endpoint ollama 100.104.166.87:11434/v1/chat/completions', output)).resolves.toBe(true);
    expect(session.ollamaUrl).toBe('http://100.104.166.87:11434');
    expect(session.history.at(-1)?.text).toContain('current provider is gemini');

    await expect(handleTuiLine(session, '/endpoint ftp://bad.local', output)).resolves.toBe(true);
    expect(session.history.at(-1)?.text).toContain('must use http or https');
  });

  it('scrolls history through slash command', async () => {
    const output = new BufferOutput();
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: Array.from({ length: 12 }, (_, index) => ({ kind: 'assistant' as const, text: `item ${index}` })),
      scrollOffset: 0
    };

    await expect(handleTuiLine(session, '/scroll up', output)).resolves.toBe(true);
    expect(session.scrollOffset).toBeGreaterThan(0);
    expect(session.autoFollow).toBe(false);
  });

  it('pauses auto-follow while viewing older history', () => {
    const session: TuiSession = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: Array.from({ length: 12 }, (_, index) => ({ kind: 'assistant' as const, text: `item ${index}` })),
      scrollOffset: 0,
      autoFollow: true,
      agentRunning: true
    };

    expect(scrollHistory(session, 'up')).toBe(true);
    const pausedOffset = session.scrollOffset;

    expect(session.autoFollow).toBe(false);
    expect(session.flash).toContain('End to follow live');

    addHistory(session, 'assistant', 'new live output');
    expect(session.scrollOffset).toBe(pausedOffset);

    expect(scrollHistory(session, 'bottom')).toBe(true);
    expect(session.autoFollow).toBe(true);
    expect(session.scrollOffset).toBe(0);
  });

  it('shows command discovery for slash input and unknown commands', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/', output)).resolves.toBe(true);
    expect(session.history.at(-1)?.text).toContain('/commands');

    await expect(handleTuiLine(session, '/nope', output)).resolves.toBe(true);
    expect(session.history.at(-1)?.text).toContain('Unknown command: /nope');
  });

  it('clears the input buffer through slash command', async () => {
    const output = new BufferOutput();
    const session = {
      runtime: {
        provider,
        skills: [],
        tools: [],
        cwd: '.',
        maxTurns: 8,
        model: 'gemma4:26b',
        stream,
        async run() {
          return { answer: 'ok', turns: [], stats: { durationMs: 1, turns: 0, toolCalls: 0 } };
        }
      } satisfies Runtime,
      provider: 'ollama',
      history: [] as TuiHistoryEntry[],
      scrollOffset: 0,
      inputBuffer: 'draft',
      commandSuggestions: [{ name: '/help', description: 'help' }]
    } satisfies TuiSession;

    await expect(handleTuiLine(session, '/clear-input', output)).resolves.toBe(true);
    expect(session.inputBuffer).toBe('');
    expect(session.commandSuggestions).toBeUndefined();
    expect(output.data).toContain('input cleared');
  });

  it('completes slash commands and keeps parameter hints visible', () => {
    expect(completeSlashInput('/set')).toBe('/settings ');
    expect(completeSlashInput('/settings')).toBe('/settings maxTurns ');
    expect(completeSlashInput('/settings m')).toBe('/settings maxTurns ');
    expect(completeSlashInput('/debug')).toBe('/debug:prompt ');
    expect(completeSlashInput('/end')).toBe('/endpoint ');
    expect(completeSlashInput('/run')).toBe('/run ');
    expect(slashSuggestions('/settings')?.some((suggestion) => suggestion.name === '/settings maxTurns <n|unlimited>')).toBe(true);
    expect(slashSuggestions('/settings m')?.map((suggestion) => suggestion.name)).toEqual(['/settings maxTurns <n|unlimited>']);
    expect(slashSuggestions('/endpoint')?.some((suggestion) => suggestion.name === '/endpoint <provider> <url>')).toBe(true);
    expect(slashSuggestions('/run')?.[0]?.parameters).toContain('shell command executed');
    expect(commands().some((command) => command.name === '/debug:prompt')).toBe(true);
    expect(commands().some((command) => command.name === '/endpoint')).toBe(true);
    expect(commands().some((command) => command.name === '/models')).toBe(false);
  });

  it('parses shell command forms', () => {
    expect(parseShellInput('! npm test')).toMatchObject({ command: 'npm test', interactive: false });
    expect(parseShellInput('! -i npm run dev')).toMatchObject({ command: 'npm run dev', interactive: true });
    expect(parseShellInput('!!', 'npm test')).toMatchObject({ command: 'npm test', interactive: true, repeat: true });
  });
});
