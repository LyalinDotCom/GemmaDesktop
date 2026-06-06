import { describe, expect, it } from 'vitest';
import { createJsonStreamReporter, main, resolvedCliSettings } from './index.js';
import { parseArgs } from './args.js';
import { cliVersionText } from './version.js';

describe('main', () => {
  it('keeps help non-interactive', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      await expect(main(['--help'])).resolves.toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(lines.join('\n')).toContain('No prompt/scenario/acp starts the TUI by default.');
    expect(lines.join('\n')).toContain('--json-stream');
    expect(lines.join('\n')).toContain('--endpoint <url>');
    expect(lines.join('\n')).toContain('--version');
    expect(lines.join('\n')).toContain('~/.gemmacli/skills');
  });

  it('prints version without starting a run', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      await expect(main(['--version'])).resolves.toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual([cliVersionText()]);
  });

  it('reports resolved headless settings from normal CLI defaults', () => {
    expect(resolvedCliSettings(parseArgs(['--prompt', 'hello']))).toMatchObject({
      maxTurns: 'unlimited',
      maxTokens: 'provider settings',
      contextTokens: 262_144,
      temperature: 1,
      topP: 0.95,
      topK: 64,
      reasoningMode: 'auto'
    });
    expect(resolvedCliSettings(parseArgs(['--prompt', 'hello', '--think', 'off']))).toMatchObject({
      reasoningMode: 'off'
    });
  });

  it('formats headless JSON stream progress as JSONL events', async () => {
    const lines: string[] = [];
    const reporter = createJsonStreamReporter({
      sessionId: 'session-1',
      runId: 'run-1',
      provider: 'ollama',
      model: 'gemma4:26b'
    }, (line) => lines.push(line));
    const runOptions = reporter.runOptions();

    await runOptions.onModelStart?.({ index: 0 });
    await runOptions.onModelActivity?.({
      index: 0,
      chunk: {
        thinking: 'thinking through the next tool',
        content: '{"tool":"write_file"',
        done: true,
        usage: {
          outputTokens: 12,
          totalTokens: 20
        }
      }
    });
    await runOptions.onToolStart?.({
      index: 0,
      toolCall: {
        tool: 'write_file',
        args: {
          path: 'app.js',
          content: 'x'.repeat(300)
        }
      }
    });
    await runOptions.onTurn?.({
      index: 0,
      turn: {
        kind: 'tool',
        content: 'wrote app.js',
        toolCall: { tool: 'write_file', args: { path: 'app.js' } },
        toolResult: { ok: true, output: 'wrote app.js' }
      }
    });

    const events = lines.map((line) => JSON.parse(line) as Record<string, any>);
    expect(events.map((event) => event.type)).toEqual(['model_start', 'model_activity', 'tool_start', 'tool_result']);
    expect(events[1].data.thinkingPreview).toContain('thinking through');
    expect(events[1].data.usage).toMatchObject({
      outputTokens: 12,
      totalTokens: 20
    });
    expect(events[2].data.args.content).toMatchObject({
      chars: 300,
      preview: expect.stringContaining('x')
    });
    expect(events[3].data).toMatchObject({
      tool: 'write_file',
      ok: true,
      outputPreview: 'wrote app.js'
    });
  });
});
