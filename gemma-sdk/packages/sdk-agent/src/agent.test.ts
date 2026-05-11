import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import type { ChatMessage, GenerateOptions, ModelProvider } from './types.js';

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  constructor(private readonly responses: string[]) {}

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    return this.responses[this.index++] ?? '{"answer":"done"}';
  }
}

class ActivityDriftProvider implements ModelProvider {
  readonly name = 'activity-drift';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      await options?.onActivity?.({ content: '```json\n{"tool":"echo","args":{"message":"bad"}}\n```' });
      await options?.onActivity?.({ content: '\n\nWait, I made a mistake and should use a different path.' });
      return 'not reached';
    }
    if (this.index === 2) {
      return '{"tool":"echo","args":{"message":"ok"}}';
    }
    return '{"answer":"done"}';
  }
}

class ThoughtTagDriftProvider implements ModelProvider {
  readonly name = 'thought-tag-drift';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      await options?.onActivity?.({ content: '<thought>\nThinking Process:\nI should inspect the workspace before acting.' });
      return 'not reached';
    }
    if (this.index === 2) {
      return '{"tool":"echo","args":{"message":"ok"}}';
    }
    return '{"answer":"done"}';
  }
}

class RawToolMarkerDriftProvider implements ModelProvider {
  readonly name = 'raw-tool-marker-drift';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      await options?.onActivity?.({ content: '{"tool":"echo","args":{"message":"bad"}}' });
      await options?.onActivity?.({ content: '<tool_call|>}<tool_call|>}' });
      await options?.onActivity?.({ content: '<tool_call|>}<tool_call|>}' });
      return '{"tool":"echo","args":{"message":"bad"}}<tool_call|>}<tool_call|>}<tool_call|>}<tool_call|>';
    }
    if (this.index === 2) {
      return '{"answer":"done"}';
    }
    return '{"answer":"extra"}';
  }
}

class EmptyOnceProvider implements ModelProvider {
  readonly name = 'empty-once';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      throw new Error('Ollama response did not include text content (done_reason=stop).');
    }
    return '{"answer":"recovered"}';
  }
}

class OutputLimitOnceProvider implements ModelProvider {
  readonly name = 'output-limit-once';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      throw new Error('Ollama OpenAI-compatible response reached the output token limit before a complete text response was received (done_reason=length).');
    }
    return '{"answer":"recovered"}';
  }
}

class FetchFailedOnceProvider implements ModelProvider {
  readonly name = 'fetch-failed-once';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      throw new TypeError('fetch failed');
    }
    return '{"answer":"recovered"}';
  }
}

class AbortedOnceProvider implements ModelProvider {
  readonly name = 'aborted-once';
  private index = 0;
  messages: ChatMessage[][] = [];
  options: GenerateOptions[] = [];

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    this.index += 1;
    if (this.index === 1) {
      throw new Error('Ollama OpenAI-compatible stream was aborted: This operation was aborted.');
    }
    return '{"answer":"recovered"}';
  }
}

describe('Agent', () => {
  it('returns a direct final answer', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider(['{"answer":"hello"}'])
    });

    await expect(agent.run('say hello')).resolves.toMatchObject({
      answer: 'hello',
      stats: { turns: 1, toolCalls: 0 },
      turns: [{ kind: 'final', content: 'hello' }]
    });
  });

  it('runs a requested tool then returns final answer', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"echo","args":{"message":"hi"}}',
        '{"answer":"used tool"}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo a message',
          async run(args) {
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool');
    expect(result.answer).toBe('used tool');
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 });
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'echo' },
      toolResult: { ok: true, output: 'hi' }
    });
  });

  it('compacts older history before provider calls when the context budget is exceeded', async () => {
    const oldMarker = 'OLD_MARKER_SHOULD_NOT_REACH_PROVIDER';
    const oldBlob = `${'A'.repeat(1000)}${oldMarker}${'B'.repeat(3000)}`;
    const history: ChatMessage[] = [{ role: 'user', content: 'original benchmark task request' }];
    for (let index = 0; index < 32; index += 1) {
      history.push({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: index === 2 ? oldBlob : `older turn ${index}`
      });
    }
    history.push({ role: 'tool', content: 'RECENT_RESULT_MUST_STAY_VISIBLE' });
    const provider = new ScriptedProvider(['{"answer":"ok"}']);
    const agent = new Agent({
      provider,
      history,
      generation: { contextTokens: 600 }
    });

    await agent.run('current task prompt');

    const callText = provider.messages[0]
      .map((message) => typeof message.content === 'string' ? `${message.role}:${message.content}` : `${message.role}:attachment`)
      .join('\n');
    expect(callText).toContain('Earlier conversation compacted to stay within the model context budget');
    expect(callText).toContain('original benchmark task request');
    expect(callText).toContain('RECENT_RESULT_MUST_STAY_VISIBLE');
    expect(callText).not.toContain(oldMarker);
  });

  it('masks older bulky tool results before provider calls while preserving recent tool output', async () => {
    let toolRuns = 0;
    const oldMarker = 'OLD_TOOL_OUTPUT_MARKER_SHOULD_NOT_REACH_PROVIDER';
    const latestMarker = 'LATEST_TOOL_OUTPUT_MARKER_MUST_STAY_VISIBLE';
    const provider = new ScriptedProvider([
      '{"tool":"big_output","args":{}}',
      '{"tool":"big_output","args":{}}',
      '{"tool":"big_output","args":{}}',
      '{"tool":"big_output","args":{}}',
      '{"tool":"big_output","args":{}}',
      '{"answer":"done"}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'big_output',
          description: 'returns bulky output',
          async run() {
            toolRuns += 1;
            const marker = toolRuns === 1 ? oldMarker : toolRuns === 5 ? latestMarker : `middle-${toolRuns}`;
            return {
              ok: true,
              output: `${'A'.repeat(36_000)}${marker}${'B'.repeat(36_000)}`
            };
          }
        }
      ]
    });

    const result = await agent.run('collect bulky outputs');

    const finalProviderText = provider.messages.at(-1)!
      .map((message) => typeof message.content === 'string' ? `${message.role}:${message.content}` : `${message.role}:attachment`)
      .join('\n');
    expect(result.answer).toBe('done');
    expect(finalProviderText).toContain('<tool_output_masked>');
    expect(finalProviderText).not.toContain(oldMarker);
    expect(finalProviderText).toContain(latestMarker);
  });

  it('normalizes common native tool-call name drift before tool lookup', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"tool:list_dir:","args":{"path":"."}}',
        '{"answer":"listed"}'
      ]),
      tools: [
        {
          name: 'list_tree',
          description: 'list files',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'empty' };
          }
        }
      ]
    });

    const result = await agent.run('inspect files');

    expect(result.answer).toBe('listed');
    expect(calls).toEqual([{ path: '.' }]);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'list_tree', args: { path: '.' } }
    });
  });

  it('normalizes tool namespace prefixes before tool lookup', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"tool:read_file","args":{"path":"filter.py"}}',
        '{"answer":"read file"}'
      ]),
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          async run() {
            return { ok: true, output: 'contents' };
          }
        }
      ]
    });

    const result = await agent.run('inspect filter');

    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'read_file', args: { path: 'filter.py' } },
      toolResult: { ok: true, output: 'contents' }
    });
  });

  it('strips trailing punctuation from exact tool names before tool lookup', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"list_tree.","args":{"path":"."}}',
        '{"answer":"listed"}'
      ]),
      tools: [
        {
          name: 'list_tree',
          description: 'list files',
          async run() {
            return { ok: true, output: 'empty' };
          }
        }
      ]
    });

    const result = await agent.run('inspect files');

    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'list_tree' },
      toolResult: { ok: true }
    });
  });

  it('gives retired Gemini replace calls a concrete recovery path', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"replace","args":{"file_path":"a.ts","old_string":"a","new_string":"b","instruction":"rename"}}',
        '{"answer":"switched to patch"}'
      ]),
      tools: []
    });

    const result = await agent.run('edit file');

    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'replace' },
      toolResult: { ok: false }
    });
    expect(result.turns[0]?.content).toContain('Use apply_patch');
    expect(result.answer).toBe('switched to patch');
  });

  it('accepts LM Studio Gemma native tool-call transport as a tool request', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '<|tool_call>call:read_files{requests:[{path:"test-projects/web-notes02/index.html"},{path:"test-projects/web-notes02/style.css"},{path:"test-projects/web-notes02/script.js"}]}<tool_call|>',
        '{"answer":"read files"}'
      ]),
      tools: [
        {
          name: 'read_files',
          description: 'read several files',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'index/style/script contents' };
          }
        }
      ]
    });

    const result = await agent.run('inspect files');

    expect(result.answer).toBe('read files');
    expect(calls).toEqual([
      {
        requests: [
          { path: 'test-projects/web-notes02/index.html' },
          { path: 'test-projects/web-notes02/style.css' },
          { path: 'test-projects/web-notes02/script.js' }
        ]
      }
    ]);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: {
        tool: 'read_files',
        args: {
          requests: [
            { path: 'test-projects/web-notes02/index.html' },
            { path: 'test-projects/web-notes02/style.css' },
            { path: 'test-projects/web-notes02/script.js' }
          ]
        }
      },
      toolResult: { ok: true, output: 'index/style/script contents' }
    });
  });

  it('accepts JSON tool calls with a trailing Gemma native close marker', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"path":"index.html","content":"<html></html>"}}<tool_call|>',
        '{"answer":"created file"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'wrote index.html' };
          }
        }
      ]
    });

    const result = await agent.run('create a page');

    expect(result.answer).toBe('created file');
    expect(calls).toEqual([{ path: 'index.html', content: '<html></html>' }]);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: {
        tool: 'write_file',
        args: { path: 'index.html', content: '<html></html>' }
      },
      toolResult: { ok: true, output: 'wrote index.html' }
    });
  });

  it('accepts JSON tool calls with repeated trailing Gemma native close markers', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"path":"index.html","content":"<html></html>"}}<tool_call|><tool_call|>',
        '{"answer":"created file"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'wrote index.html' };
          }
        }
      ]
    });

    const result = await agent.run('create a page');

    expect(result.answer).toBe('created file');
    expect(calls).toEqual([{ path: 'index.html', content: '<html></html>' }]);
  });

  it('accepts JSON tool calls with noisy repeated marker and brace suffixes', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"exec_command","args":{"command":"npx tailwindcss init -p --prefix app"}}<tool_call|>}<tool_call|>}<tool_call|>}<tool_call|>',
        '{"answer":"configured tailwind"}'
      ]),
      tools: [
        {
          name: 'exec_command',
          description: 'run a command',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'created tailwind.config.js' };
          }
        }
      ]
    });

    const result = await agent.run('configure tailwind');

    expect(result.answer).toBe('configured tailwind');
    expect(calls).toEqual([{ command: 'npx tailwindcss init -p --prefix app' }]);
  });

  it('accepts loose write_file JSON when file content includes unescaped quotes', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"content":"<script>document.querySelectorAll(\'a[href^="#"]\').forEach(() => {})</script>","path":"index.html"}<tool_call|>',
        '{"answer":"created file"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'wrote index.html' };
          }
        }
      ]
    });

    const result = await agent.run('create a page');

    expect(result.answer).toBe('created file');
    expect(calls).toEqual([{
      path: 'index.html',
      content: '<script>document.querySelectorAll(\'a[href^="#"]\').forEach(() => {})</script>'
    }]);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: {
        tool: 'write_file',
        args: {
          path: 'index.html',
          content: '<script>document.querySelectorAll(\'a[href^="#"]\').forEach(() => {})</script>'
        }
      },
      toolResult: { ok: true, output: 'wrote index.html' }
    });
  });

  it('accepts loose write_file JSON with a stray brace before path and repeated markers', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"content":"body {\\n  color: red;\\n}"},"path":"style.css"}}<tool_call|><tool_call|>',
        '{"answer":"created stylesheet"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'wrote style.css' };
          }
        }
      ]
    });

    const result = await agent.run('create a stylesheet');

    expect(result.answer).toBe('created stylesheet');
    expect(calls).toEqual([{ path: 'style.css', content: 'body {\n  color: red;\n}' }]);
  });

  it('accepts path-first loose write_file JSON with unescaped quotes in content', async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"path":"script.js","content":"const selector = "button.primary";\\nconsole.log(selector);"}}<tool_call|>',
        '{"answer":"created script"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            calls.push(args);
            return { ok: true, output: 'wrote script.js' };
          }
        }
      ]
    });

    const result = await agent.run('create a script');

    expect(result.answer).toBe('created script');
    expect(calls).toEqual([{
      path: 'script.js',
      content: 'const selector = "button.primary";\nconsole.log(selector);'
    }]);
  });

  it('accepts Gemma native tool calls after a thought channel', async () => {
    const seen: unknown[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '<|channel>thought\nI should read the file first.\n<channel|><|tool_call>call:read_file{path:<|"|>package.json<|"|>,limit:40}<tool_call|><|tool_response>',
        '<|channel>thought\nNow answer.\n<channel|>{"answer":"read package"}<turn|>'
      ]),
      tools: [
        {
          name: 'read_file',
          description: 'read one file',
          async run(args) {
            seen.push(args);
            return { ok: true, output: 'package contents' };
          }
        }
      ]
    });

    const result = await agent.run('inspect package');

    expect(result.answer).toBe('read package');
    expect(seen).toEqual([{ path: 'package.json', limit: 40 }]);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: {
        tool: 'read_file',
        args: { path: 'package.json', limit: 40 }
      }
    });
  });

  it('allows explicitly uncapped local-style runs to continue past the default turn budget', async () => {
    let toolRuns = 0;
    const responses = [
      ...Array.from({ length: 35 }, () => '{"tool":"echo","args":{"message":"next"}}'),
      '{"answer":"done"}'
    ];
    const agent = new Agent({
      provider: new ScriptedProvider(responses),
      maxTurns: null,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run() {
            toolRuns += 1;
            return { ok: true, output: 'next' };
          }
        }
      ]
    });

    const result = await agent.run('keep going');

    expect(result.answer).toBe('done');
    expect(toolRuns).toBe(35);
    expect(result.turns).toHaveLength(36);
    expect(result.completionStatus).toBe('completed');
  });

  it('reuses duplicate successful validation commands after the latest file change', async () => {
    let commandRuns = 0;
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"exec_command","args":{"command":"npm test"}}',
        '{"tool":"exec_command","args":{"command":"npm test"}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'exec_command',
          description: 'run command',
          async run() {
            commandRuns += 1;
            return { ok: true, output: 'Command exited with 0.\nRunning tests...' };
          }
        }
      ]
    });

    const result = await agent.run('run tests');

    expect(commandRuns).toBe(1);
    expect(result.answer).toBe('done');
    expect(result.turns[1]).toMatchObject({
      kind: 'tool',
      toolResult: {
        ok: true,
        output: expect.stringContaining('reused previous successful validation')
      }
    });
  });

  it('does not reuse validation commands across different cwd values', async () => {
    let commandRuns = 0;
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"exec_command","args":{"command":"npm test","cwd":"one"}}',
        '{"tool":"exec_command","args":{"command":"npm test","cwd":"two"}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'exec_command',
          description: 'run command',
          async run() {
            commandRuns += 1;
            return { ok: true, output: 'Command exited with 0.\nRunning tests...' };
          }
        }
      ]
    });

    const result = await agent.run('run tests');

    expect(commandRuns).toBe(2);
    expect(result.answer).toBe('done');
  });

  it('rejects cosmetic success-message edits after validation already passed', async () => {
    let patchRuns = 0;
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"exec_command","args":{"command":"npm test"}}',
        '{"tool":"apply_patch","args":{"patch":"--- a/test.js\\n+++ b/test.js\\n@@ -1 +1,2 @@\\n runTests();\\n+console.log(\\"All tests passed!\\");\\n"}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'exec_command',
          description: 'run command',
          async run() {
            return { ok: true, output: 'Command exited with 0.\nRunning tests...' };
          }
        },
        {
          name: 'apply_patch',
          description: 'apply patch',
          async run() {
            patchRuns += 1;
            return { ok: true, output: 'edited' };
          }
        }
      ]
    });

    const result = await agent.run('finish tests');

    expect(patchRuns).toBe(0);
    expect(result.answer).toBe('done');
    expect(result.turns[1]).toMatchObject({
      kind: 'tool',
      toolResult: {
        ok: false,
        output: expect.stringContaining('Refusing cosmetic success-message edit')
      }
    });
  });

  it('blocks repeated file mutation after patch context failure until the agent rereads context', async () => {
    let patchRuns = 0;
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"apply_patch","args":{"patch":"--- a/style.css\\n+++ b/style.css\\n@@ -101 +101 @@\\n-old\\n+new\\n"}}',
        '{"tool":"apply_patch","args":{"patch":"--- a/style.css\\n+++ b/style.css\\n@@ -101 +101 @@\\n-old\\n+new\\n"}}',
        '{"tool":"read_file","args":{"path":"style.css"}}',
        '{"tool":"apply_patch","args":{"patch":"--- a/style.css\\n+++ b/style.css\\n@@ -1 +1 @@\\n-current\\n+new\\n"}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'apply_patch',
          description: 'apply patch',
          async run() {
            patchRuns += 1;
            if (patchRuns === 1) {
              return {
                ok: false,
                output: 'apply_patch: hunk @@ -101 did not match in style.css.'
              };
            }
            return { ok: true, output: 'updated style.css (1 hunk)' };
          }
        },
        {
          name: 'read_file',
          description: 'read file',
          async run() {
            return { ok: true, output: 'current' };
          }
        }
      ]
    });

    const result = await agent.run('update the stylesheet');

    expect(result.answer).toBe('done');
    expect(patchRuns).toBe(2);
    expect(result.turns[1]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'apply_patch' },
      toolResult: {
        ok: false,
        meta: { presentation: 'notice' },
        output: expect.stringContaining('Before another file mutation')
      }
    });
    expect(result.turns[2]).toMatchObject({ toolCall: { tool: 'read_file' }, toolResult: { ok: true } });
    expect(result.turns[3]).toMatchObject({ toolCall: { tool: 'apply_patch' }, toolResult: { ok: true } });
  });

  it('repairs invalid JSON escapes in a tool call instead of rendering raw tool JSON', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"path":"test/index.html","content":"<meta name=\\"viewport\\" content=\\"width\\_width\\">"}}',
        '{"answer":"wrote file"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            return { ok: true, output: `wrote ${String(args.path)} ${String(args.content)}` };
          }
        }
      ]
    });

    const result = await agent.run('write file');

    expect(result.answer).toBe('wrote file');
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 });
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: {
        tool: 'write_file',
        args: {
          path: 'test/index.html',
          content: '<meta name="viewport" content="width_width">'
        }
      }
    });
  });

  it('recovers from malformed tool calls instead of rendering raw transport JSON as prose', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"write_file","args":{"path":"test/index.html","content":"unterminated}}',
        '{"tool":"write_file","args":{"path":"test/index.html","content":"ok"}}',
        '{"answer":"recovered"}'
      ]),
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          async run(args) {
            return { ok: true, output: `wrote ${String(args.path)}` };
          }
        }
      ]
    });

    const result = await agent.run('write file');
    expect(result.answer).toBe('recovered');
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'write_file', args: { path: 'test/index.html', content: 'ok' } }
    });
  });

  it('retries prose after fenced tool JSON instead of executing the first embedded tool call', async () => {
    const provider = new ScriptedProvider([
      '```json\n{"tool":"echo","args":{"message":"bad"}}\n```\n\nWait, I made a mistake and should use a different path.',
      '{"tool":"echo","args":{"message":"ok"}}',
      '{"answer":"done"}'
    ]);
    const seen: string[] = [];
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool');

    expect(seen).toEqual(['ok']);
    expect(result.answer).toBe('done');
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('closing Markdown fence'))).toBe(true);
  });

  it('cuts off streamed visible scratch after a fenced tool JSON block and retries', async () => {
    const provider = new ActivityDriftProvider();
    const seen: string[] = [];
    const activity: string[] = [];
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool', {
      onModelActivity(event) {
        if (event.chunk.content) {
          activity.push(event.chunk.content);
        }
      }
    });

    expect(activity.join('')).toContain('Wait, I made a mistake');
    expect(seen).toEqual(['ok']);
    expect(result.answer).toBe('done');
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('drifted outside the Gemma CLI JSON protocol'))).toBe(true);
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('cuts off streamed visible thought tags and retries with reasoning disabled', async () => {
    const provider = new ThoughtTagDriftProvider();
    const seen: string[] = [];
    const activity: string[] = [];
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool', {
      onModelActivity(event) {
        if (event.chunk.content) {
          activity.push(event.chunk.content);
        }
      }
    });

    expect(activity.join('')).toContain('<thought>');
    expect(seen).toEqual(['ok']);
    expect(result.answer).toBe('done');
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Visible <thought> scratch text'))).toBe(true);
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('accepts complete tool JSON followed by repeated raw transport markers', async () => {
    const provider = new RawToolMarkerDriftProvider();
    const seen: string[] = [];
    const activity: string[] = [];
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool', {
      onModelActivity(event) {
        if (event.chunk.content) {
          activity.push(event.chunk.content);
        }
      }
    });

    expect(activity.join('')).toContain('<tool_call|>}<tool_call|>}');
    expect(seen).toEqual(['bad']);
    expect(result.answer).toBe('done');
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Raw tool-call transport markers repeated'))).toBe(false);
    expect(provider.options[1]?.reasoningMode).toBeUndefined();
  });

  it('repairs Gemma string delimiters leaked into single-string tool JSON', async () => {
    const seen: string[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"echo","args":{"message":"hi<|"|>}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool');

    expect(seen).toEqual(['hi']);
    expect(result.answer).toBe('done');
  });

  it('repairs native-style Gemma string delimiters inside JSON tool wrappers', async () => {
    const seen: string[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"echo","args":{"message:<|"|>hello from native delimiter<|"|>}}',
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo',
          async run(args) {
            seen.push(String(args.message));
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool');

    expect(seen).toEqual(['hello from native delimiter']);
    expect(result.answer).toBe('done');
  });

  it('recovers from thinking-only empty model responses without failing the run', async () => {
    const provider = new EmptyOnceProvider();
    const agent = new Agent({ provider });

    const result = await agent.run('finish the task');

    expect(result.answer).toBe('recovered');
    expect(provider.messages).toHaveLength(2);
    expect(String(provider.messages[1].at(-1)?.content)).toContain('thinking only and no JSON content');
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('retries output-limit model responses with reasoning disabled', async () => {
    const provider = new OutputLimitOnceProvider();
    const agent = new Agent({
      provider,
      model: 'gemma4:31b',
      reasoningMode: 'auto'
    });

    const result = await agent.run('finish the task');

    expect(result.answer).toBe('recovered');
    expect(provider.messages).toHaveLength(2);
    expect(String(provider.messages[1]?.[0]?.content)).not.toContain('Thinking mode is enabled');
    expect(String(provider.messages[1]?.at(-1)?.content)).toContain('output token limit');
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('retries transient local provider transport failures once with thinking disabled', async () => {
    const provider = new FetchFailedOnceProvider();
    const agent = new Agent({ provider });

    const result = await agent.run('finish the task');

    expect(result.answer).toBe('recovered');
    expect(provider.messages).toHaveLength(2);
    expect(String(provider.messages[1].at(-1)?.content)).toContain('provider transport disconnected');
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('retries local provider aborts once unless the run was cancelled', async () => {
    const provider = new AbortedOnceProvider();
    const agent = new Agent({ provider });

    const result = await agent.run('finish the task');

    expect(result.answer).toBe('recovered');
    expect(provider.messages).toHaveLength(2);
    expect(String(provider.messages[1].at(-1)?.content)).toContain('provider transport disconnected');
    expect(provider.options[1]?.reasoningMode).toBe('off');
  });

  it('does not retry provider aborts after the run signal is cancelled', async () => {
    const provider = new AbortedOnceProvider();
    const controller = new AbortController();
    controller.abort();
    const agent = new Agent({ provider, generation: { signal: controller.signal } });

    await expect(agent.run('finish the task')).rejects.toThrow('stream was aborted');
    expect(provider.messages).toHaveLength(1);
  });

  it('notifies progress callbacks as tools and turns run', async () => {
    const events: string[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"echo","args":{"message":"hi"}}',
        '{"answer":"used tool"}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo a message',
          async run(args) {
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    await agent.run('use tool', {
      onToolStart(event) {
        events.push(`start:${event.index}:${event.toolCall.tool}`);
      },
      onTurn(event) {
        events.push(`turn:${event.index}:${event.turn.kind}`);
      }
    });

    expect(events).toEqual(['start:0:echo', 'turn:0:tool', 'turn:1:final']);
  });

  it('runs a no-tool final response pass when max turns end after tool use', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"echo","args":{"message":"hi"}}',
      '{"answer":"I wrote the file, but validation did not run."}'
    ]);
    const agent = new Agent({
      provider,
      maxTurns: 1,
      tools: [
        {
          name: 'echo',
          description: 'echo a message',
          async run(args) {
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use tool');

    expect(result.completionStatus).toBe('completed');
    expect(result.answer).toContain('validation did not run');
    expect(result.turns).toHaveLength(2);
    expect(result.turns.at(-1)).toMatchObject({ kind: 'final' });
    expect(provider.messages[1]?.at(-1)?.content).toContain('final no-tools response pass');
    expect(String(provider.messages[1]?.[0]?.content)).not.toContain('Thinking mode is enabled');
    expect(provider.options[1]).toMatchObject({ maxTokens: 1024, reasoningMode: 'off' });
  });

  it('runs a tool call nested inside an answer string when it is the whole answer', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"answer":"{\\"tool\\":\\"echo\\",\\"args\\":{\\"message\\":\\"hi\\"}}"}',
        '{"answer":"used nested tool"}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo a message',
          async run(args) {
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('use nested tool');
    expect(result.answer).toBe('used nested tool');
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 });
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'echo', args: { message: 'hi' } },
      toolResult: { ok: true, output: 'hi' }
    });
  });

  it('recovers literal newlines in single-string tool calls', async () => {
    const command = '{"tool":"exec_command","args":{"command":"python3 -c \\"print(1); \\' + '\n' + 'print(2)\\""}}';
    const seen: string[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([
        command,
        '{"answer":"done"}'
      ]),
      tools: [
        {
          name: 'exec_command',
          description: 'run a command',
          async run(args) {
            seen.push(String(args.command));
            return { ok: true, output: 'ran' };
          }
        }
      ]
    });

    const result = await agent.run('run command');

    expect(result.answer).toBe('done');
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 });
    expect(seen).toEqual(['python3 -c "print(1); \\\nprint(2)"']);
  });

  it('does not run a tool call merely mentioned inside an answer string', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"answer":"Use {\\"tool\\":\\"echo\\",\\"args\\":{\\"message\\":\\"hi\\"}} as an example."}'
      ]),
      tools: [
        {
          name: 'echo',
          description: 'echo a message',
          async run(args) {
            return { ok: true, output: String(args.message) };
          }
        }
      ]
    });

    const result = await agent.run('explain nested tool');
    expect(result.answer).toBe('Use {"tool":"echo","args":{"message":"hi"}} as an example.');
    expect(result.stats).toMatchObject({ turns: 1, toolCalls: 0 });
    expect(result.turns[0]).toMatchObject({ kind: 'final' });
  });

  it('uses the first complete JSON object from noisy model output', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider(['{"answer":"first"}\n{"answer":"second"}'])
    });

    await expect(agent.run('answer')).resolves.toMatchObject({ answer: 'first' });
  });

  it('does not crash when a model emits malformed JSON text', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider(['{"answer":"created files\nvalidation passed"}'])
    });

    await expect(agent.run('answer')).resolves.toMatchObject({
      answer: '{"answer":"created files\nvalidation passed"}',
      stats: { turns: 1, toolCalls: 0 }
    });
  });

  it('seeds provider messages with resumable history', async () => {
    const provider = new ScriptedProvider(['{"answer":"continued"}']);
    const agent = new Agent({
      provider,
      history: [
        { role: 'user', content: 'old prompt' },
        { role: 'assistant', content: 'old answer' }
      ]
    });

    await agent.run('new prompt');

    expect(provider.messages[0]).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'old prompt' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'new prompt' }
    ]);
  });

  it('converts resumable tool history into user-visible tool results before provider calls', async () => {
    const provider = new ScriptedProvider(['{"answer":"continued"}']);
    const agent = new Agent({
      provider,
      history: [
        { role: 'user', content: 'old prompt' },
        { role: 'tool', content: 'wrote app/index.html' },
        { role: 'assistant', content: 'old answer' }
      ]
    });

    await agent.run('new prompt');

    expect(provider.messages[0]).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'old prompt' },
      { role: 'user', content: 'Previous tool result:\nwrote app/index.html' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'new prompt' }
    ]);
  });

  it('keeps a crashed tool as a failed tool turn', async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        '{"tool":"explode","args":{}}',
        '{"answer":"handled"}'
      ]),
      tools: [
        {
          name: 'explode',
          description: 'throws',
          async run() {
            throw new Error('boom');
          }
        }
      ]
    });

    const result = await agent.run('use tool');

    expect(result.answer).toBe('handled');
    expect(result.turns[0]).toMatchObject({
      kind: 'tool',
      toolResult: { ok: false, output: 'Tool explode crashed: boom' }
    });
  });

  it('forces validation after file edits when validation was requested', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"app.js","content":"console.log(1)"}}',
      '{"answer":"Updated app.js, but validation was not run."}',
      '{"tool":"exec_command","args":{"command":"npm test"}}',
      '{"answer":"Updated app.js and npm test passed."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          async run() {
            return { ok: true, output: 'wrote app.js' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          async run() {
            return { ok: true, output: 'tests passed' };
          }
        }
      ]
    });

    const result = await agent.run('update app.js and run tests');

    expect(result.answer).toBe('Updated app.js and npm test passed.');
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 2 });
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Validation is still required'))).toBe(true);
  });

  it('does not force validation when a successful command ran after the last edit', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"app.js","content":"console.log(1)"}}',
      '{"tool":"exec_command","args":{"command":"npm test"}}',
      '{"answer":"Updated app.js and npm test passed."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          async run() {
            return { ok: true, output: 'wrote app.js' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          async run() {
            return { ok: true, output: 'tests passed' };
          }
        }
      ]
    });

    await expect(agent.run('update app.js and run tests')).resolves.toMatchObject({
      answer: 'Updated app.js and npm test passed.',
      stats: { turns: 3, toolCalls: 2 }
    });
  });

  it('does not treat game mechanics using the word run as a validation request', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"test-projects/game03/index.html","content":"<canvas id=\\"game-canvas\\"></canvas>"}}',
      '{"answer":"Created the side-scrolling game files in test-projects/game03."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote index.html' };
          }
        },
        {
          name: 'exec_command',
          description: 'run command',
          capability: 'command',
          async run() {
            return { ok: true, output: 'should not run validation' };
          }
        }
      ]
    });

    const result = await agent.run('Make a side scrolling web game where you run and enemies run at you randomly.');

    expect(result.answer).toBe('Created the side-scrolling game files in test-projects/game03.');
    expect(result.stats).toMatchObject({ turns: 2, toolCalls: 1 });
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'final']);
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Validation is still required'))).toBe(false);
  });

  it('retries promise-only answers for actionable workspace changes before any tool use', async () => {
    const provider = new ScriptedProvider([
      '{"answer":"I will update the simulation to include camera controls."}',
      '{"tool":"read_file","args":{"path":"test-projects/black01/script.js"}}',
      '{"tool":"edit_file","args":{"path":"test-projects/black01/script.js","oldText":"draw();","newText":"drawCamera();"}}',
      '{"answer":"Added camera controls."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'read_file',
          description: 'read',
          async run() {
            return { ok: true, output: 'function draw() { draw(); }' };
          }
        },
        {
          name: 'edit_file',
          description: 'edit',
          capability: 'write',
          async run() {
            return { ok: true, output: 'edited script.js' };
          }
        }
      ]
    });

    const result = await agent.run('let me rotate the cmaer view and zoom in/out');

    expect(result.answer).toBe('Added camera controls.');
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 2 });
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('only promised or claimed work without using any tools'))).toBe(true);
  });

  it('does not force tool use for planning-only requests', async () => {
    const provider = new ScriptedProvider([
      '{"answer":"I will outline a plan."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'edit_file',
          description: 'edit',
          capability: 'write',
          async run() {
            return { ok: true, output: 'unused' };
          }
        }
      ]
    });

    await expect(agent.run('make a plan')).resolves.toMatchObject({
      answer: 'I will outline a plan.',
      stats: { turns: 1, toolCalls: 0 }
    });
  });

  it('retries completed-project claims when only a directory was created', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"exec_command","args":{"command":"mkdir -p test-projects/ledger10-run03"}}',
      '{"answer":"I created the project files and all tests and build passed."}',
      '{"tool":"write_file","args":{"path":"test-projects/ledger10-run03/package.json","content":"{\\"scripts\\":{\\"test\\":\\"node test.js\\",\\"build\\":\\"node --check index.js\\"}}"}}',
      '{"tool":"exec_command","args":{"command":"npm test --prefix test-projects/ledger10-run03"}}',
      '{"tool":"exec_command","args":{"command":"npm run build --prefix test-projects/ledger10-run03"}}',
      '{"answer":"Created the project and verified npm test plus npm run build."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            return { ok: true, output: 'ok' };
          }
        },
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote package.json' };
          }
        }
      ]
    });

    const result = await agent.run('Make me a small Node project. I need to be able to run npm test and npm run build in the project when it is done.');

    expect(result.answer).toBe('Created the project and verified npm test plus npm run build.');
    expect(result.stats).toMatchObject({ turns: 5, toolCalls: 4 });
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Missing validation evidence for: npm test, npm run build'))).toBe(true);
  });

  it('retries claimed npm validation when requested build evidence is missing', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"package.json","content":"{\\"scripts\\":{\\"test\\":\\"node test.js\\",\\"build\\":\\"node --check index.js\\"}}"}}',
      '{"tool":"exec_command","args":{"command":"npm test"}}',
      '{"answer":"All tests and build passed."}',
      '{"tool":"exec_command","args":{"command":"npm run build"}}',
      '{"answer":"npm test and npm run build passed."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote package.json' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            return { ok: true, output: 'ok' };
          }
        }
      ]
    });

    const result = await agent.run('Update this project. I need npm test and npm run build to work.');

    expect(result.answer).toBe('npm test and npm run build passed.');
    expect(result.stats).toMatchObject({ turns: 4, toolCalls: 3 });
    expect(result.turns.map((turn) => turn.kind)).toEqual(['tool', 'tool', 'tool', 'final']);
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('Missing validation evidence for: npm run build'))).toBe(true);
  });

  it('retries final answers that still describe pending workspace work after read-only tools', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"list_tree","args":{"path":"."}}',
      '{"answer":"```python\\nprint(42)\\n```\\n\\nWait, I should write this script and run it. {\\"tool\\":\\"write_file\\",\\"args\\":{\\"path\\":\\"task_file/output_data/answer.py\\",\\"content\\":\\"print(42)\\n\\"}}"}',
      '{"tool":"write_file","args":{"path":"task_file/output_data/answer.py","content":"print(42)\\n"}}',
      '{"answer":"Created task_file/output_data/answer.py."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'list_tree',
          description: 'list files',
          async run() {
            return { ok: true, output: 'dir task_file' };
          }
        },
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote task_file/output_data/answer.py' };
          }
        }
      ]
    });

    const result = await agent.run('Work in the task workspace and create the required output_data file.');

    expect(result.answer).toBe('Created task_file/output_data/answer.py.');
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 2 });
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('premature final answer'))).toBe(true);
  });

  it('retries final answers after an unvalidated rewrite following a failed run', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"gpt2.c","content":"int main(void){return 1;}\\n"}}',
      '{"tool":"exec_command","args":{"command":"gcc -O3 /app/gpt2.c -o /app/a.out && /app/a.out"}}',
      '{"tool":"write_file","args":{"path":"gpt2.c","content":"int main(void){return 0;}\\n"}}',
      '{"answer":"I have implemented the GPT-2 sampler in C at /app/gpt2.c. To compile and run it, use gcc -O3 /app/gpt2.c -o /app/a.out && /app/a.out."}',
      '{"tool":"exec_command","args":{"command":"gcc -O3 /app/gpt2.c -o /app/a.out && /app/a.out"}}',
      '{"answer":"gpt2.c now compiles and runs."}'
    ]);
    let execCalls = 0;
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote and reread gpt2.c' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            execCalls += 1;
            return execCalls === 1
              ? { ok: false, output: 'Command exited with 139.\nSegmentation fault' }
              : { ok: true, output: 'Command exited with 0.' };
          }
        }
      ]
    });

    const result = await agent.run('Implement gpt2.c in this workspace.');

    expect(result.answer).toBe('gpt2.c now compiles and runs.');
    expect(result.stats).toMatchObject({ turns: 5, toolCalls: 4 });
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('latest file write has not been validated'))).toBe(true);
  });

  it('marks max-turn final summaries incomplete after an unvalidated rewrite following a failed run', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"scripts/run-dashboard.mjs","content":"broken\\n"}}',
      '{"tool":"exec_command","args":{"command":"npm run build && npm run run:dashboard && npm run validate"}}',
      '{"tool":"write_file","args":{"path":"scripts/run-dashboard.mjs","content":"fixed\\n"}}',
      '{"answer":"All dashboard commands passed after the fix."}'
    ]);
    const agent = new Agent({
      provider,
      maxTurns: 3,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote scripts/run-dashboard.mjs' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            return { ok: false, output: 'Command exited with 1.\nSyntaxError: Invalid or unexpected token' };
          }
        }
      ]
    });

    const result = await agent.run('Build the dashboard, then run npm run build, npm run run:dashboard, and npm run validate.');

    expect(result.completionStatus).toBe('incomplete');
    expect(result.completionReason).toBe('final_response_unverified');
    expect(result.answer).toContain('final summary pass could not be accepted');
    expect(result.answer).toContain('Validation is still required before the final answer');
    expect(result.stats).toMatchObject({ turns: 4, toolCalls: 3 });
  });

  it('retries final answers when validation metrics miss explicit benchmark thresholds', async () => {
    const prompt = [
      'Implement optimized batching plans in /app/task_file/output_data.',
      'You can run /app/task_file/scripts/eval_plan.py to verify.',
      'Your goal is to achieve metrics below the thresholds listed below:',
      '| Input File | Cost | Pad Ratio | P95 Latency (ms) | Sequential Timecost (ms) |',
      '|---|---:|---:|---:|---:|',
      '| `requests_bucket_1.jsonl` | `3.0e11` | `0.055` | `2.1e6` | `2.7e8` |',
      '| `requests_bucket_2.jsonl` | `4.8e10` | `0.15` | `2.1e5` | `3.2e7` |'
    ].join('\n');
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"task_file/scripts/optimizer_packer.py","content":"print(\\"v1\\")\\n"}}',
      '{"tool":"exec_command","args":{"command":"python3 /app/task_file/scripts/optimizer_packer.py && python3 /app/task_file/scripts/eval_plan.py"}}',
      '{"answer":"I have implemented a shape-aware batching scheduler. Performance results show significant improvements."}',
      '{"tool":"write_file","args":{"path":"task_file/scripts/optimizer_packer.py","content":"print(\\"v2\\")\\n"}}',
      '{"tool":"exec_command","args":{"command":"python3 /app/task_file/scripts/optimizer_packer.py && python3 /app/task_file/scripts/eval_plan.py"}}',
      '{"answer":"The batching plans now meet the target thresholds."}'
    ]);
    let execCalls = 0;
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote optimizer_packer.py' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            execCalls += 1;
            return {
              ok: true,
              output: execCalls === 1
                ? [
                    'Command exited with 0.',
                    'File: /app/task_file/input_data/requests_bucket_1.jsonl',
                    'Cost: 4.81e+11',
                    'Pad Ratio: 0.1284',
                    'P95 Latency: 2.84e+06',
                    'Sequential Timecost: 4.18e+07',
                    '--------------------',
                    'File: /app/task_file/input_data/requests_bucket_2.jsonl',
                    'Cost: 5.17e+10',
                    'Pad Ratio: 0.1886',
                    'P95 Latency: 2.53e+05',
                    'Sequential Timecost: 2.05e+07'
                  ].join('\n')
                : [
                    'Command exited with 0.',
                    'File: /app/task_file/input_data/requests_bucket_1.jsonl',
                    'Cost: 2.90e+11',
                    'Pad Ratio: 0.050',
                    'P95 Latency: 2.00e+06',
                    'Sequential Timecost: 4.18e+07',
                    '--------------------',
                    'File: /app/task_file/input_data/requests_bucket_2.jsonl',
                    'Cost: 4.70e+10',
                    'Pad Ratio: 0.140',
                    'P95 Latency: 2.00e+05',
                    'Sequential Timecost: 2.05e+07'
                  ].join('\n')
            };
          }
        }
      ]
    });

    const result = await agent.run(prompt);

    expect(result.answer).toBe('The batching plans now meet the target thresholds.');
    expect(result.stats).toMatchObject({ turns: 5, toolCalls: 4 });
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('latest validation metrics still miss explicit target thresholds'))).toBe(true);
  });

  it('retries final answers when compact bucket metric lines miss explicit benchmark thresholds', async () => {
    const prompt = [
      'Implement optimized batching plans in /app/task_file/output_data.',
      'The baseline performs far worse than required thresholds:',
      '| Input File | Cost | Pad Ratio | P95 Latency (ms) | Sequential Timecost (ms) |',
      '|---|---:|---:|---:|---:|',
      '| `requests_bucket_1.jsonl` | `2.4830e+12` | `1.4363` | `1.3157e+07` | `4.8973e+07` |',
      '| `requests_bucket_2.jsonl` | `1.6673e+12` | `4.0430` | `3.4104e+06` | `1.1463e+07` |',
      'Your goal is to achieve metrics below the thresholds listed below:',
      '| Input File | Cost | Pad Ratio | P95 Latency (ms) | Sequential Timecost (ms) |',
      '|---|---:|---:|---:|---:|',
      '| `requests_bucket_1.jsonl` | `3.0e11` | `0.055` | `2.1e6` | `2.7e8` |',
      '| `requests_bucket_2.jsonl` | `4.8e10` | `0.15` | `2.1e5` | `3.2e7` |',
      'The output files must satisfy the performance thresholds above.'
    ].join('\n');
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"task_file/scripts/optimizer_packer.py","content":"print(\\"v1\\")\\n"}}',
      '{"tool":"exec_command","args":{"command":"python3 /app/task_file/scripts/optimizer_packer.py"}}',
      '{"answer":"Optimized batching plans were generated by implementing a shape-aware scheduler. The plans significantly reduce cost and latency compared to the baseline."}',
      '{"tool":"write_file","args":{"path":"task_file/scripts/optimizer_packer.py","content":"print(\\"v2\\")\\n"}}',
      '{"tool":"exec_command","args":{"command":"python3 /app/task_file/scripts/optimizer_packer.py"}}',
      '{"answer":"The batching plans now meet the target thresholds."}'
    ]);
    let execCalls = 0;
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          async run() {
            return { ok: true, output: 'wrote optimizer_packer.py' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          capability: 'command',
          async run() {
            execCalls += 1;
            return {
              ok: true,
              output: execCalls === 1
                ? [
                    'Command exited with 0.',
                    'Bucket 1: Cost=4.31e+11, Pad=0.088, P95=2.38e+06, SeqTime=7.75e+07',
                    'Bucket 2: Cost=7.96e+10, Pad=0.227, P95=4.83e+05, SeqTime=1.64e+07'
                  ].join('\n')
                : [
                    'Command exited with 0.',
                    'Bucket 1: Cost=2.90e+11, Pad=0.050, P95=2.00e+06, SeqTime=7.75e+07',
                    'Bucket 2: Cost=4.70e+10, Pad=0.140, P95=2.00e+05, SeqTime=1.64e+07'
                  ].join('\n')
            };
          }
        }
      ]
    });

    const result = await agent.run(prompt);

    expect(result.answer).toBe('The batching plans now meet the target thresholds.');
    expect(result.stats).toMatchObject({ turns: 5, toolCalls: 4 });
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('requests_bucket_1.jsonl Cost 4.310e+11 > 3.000e+11'))).toBe(true);
  });

  it('rejects passed finalize_build validation without matching command evidence', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"app.js","content":"console.log(1)"}}',
      '{"tool":"finalize_build","args":{"summary":"done","artifacts":["app.js"],"validation":[{"command":"npm start","status":"passed"}],"instructionChecklist":["created app"]}}',
      '{"tool":"exec_command","args":{"command":"npm start"}}',
      '{"tool":"finalize_build","args":{"summary":"done","artifacts":["app.js"],"validation":[{"command":"npm start","status":"passed"}],"instructionChecklist":["created app"]}}',
      '{"answer":"npm start passed."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          async run() {
            return { ok: true, output: 'wrote app.js' };
          }
        },
        {
          name: 'exec_command',
          description: 'run',
          async run() {
            return { ok: true, output: 'server started and exited cleanly' };
          }
        },
        {
          name: 'finalize_build',
          description: 'finalize',
          async run() {
            return { ok: true, output: 'recorded finalize_build' };
          }
        }
      ]
    });

    const result = await agent.run('create an npm app');

    expect(result.answer).toBe('npm start passed.');
    expect(result.stats).toMatchObject({ turns: 5, toolCalls: 4 });
    expect(result.turns[1]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'finalize_build' },
      toolResult: { ok: false, meta: { presentation: 'notice' } }
    });
    expect(result.turns[1]?.content).toContain('Missing successful exec_command result for: npm start');
    expect(result.turns[3]).toMatchObject({
      kind: 'tool',
      toolCall: { tool: 'finalize_build' },
      toolResult: { ok: true }
    });
  });

  it('retries final answers when the latest file write reported suspicious generated content', async () => {
    const provider = new ScriptedProvider([
      '{"tool":"write_file","args":{"path":"gpt2.c","content":"// Mock sampling loop to satisfy the output requirement\\nint main(void){return 0;}"}}',
      '{"answer":"The C file is done."}',
      '{"tool":"write_file","args":{"path":"gpt2.c","content":"int main(void){return 0;}"}}',
      '{"answer":"The corrected C file is done."}'
    ]);
    const agent = new Agent({
      provider,
      tools: [
        {
          name: 'write_file',
          description: 'write',
          async run(args) {
            const content = typeof args.content === 'string' ? args.content : '';
            if (content.includes('Mock sampling loop')) {
              return {
                ok: true,
                output: [
                  'wrote and reread gpt2.c (75 bytes)',
                  'suspicious text detected in gpt2.c: // Mock sampling loop to satisfy the output requirement',
                  'The file was written. Verify this was intentional; if not, inspect and correct the edit before finalizing.'
                ].join('\n')
              };
            }
            return { ok: true, output: 'wrote and reread gpt2.c (24 bytes)' };
          }
        }
      ]
    });

    const result = await agent.run('Create gpt2.c');

    expect(result.answer).toBe('The corrected C file is done.');
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 2 });
    expect(provider.messages.some((messages) => String(messages.at(-1)?.content).includes('A recent file write reported suspicious generated content'))).toBe(true);
  });

  it('includes tuned CLI act-mode guidance in the system prompt', async () => {
    const provider = new ScriptedProvider(['{"answer":"ok"}']);
    const agent = new Agent({
      provider,
      workspace: '/repo',
      tools: [
        {
          name: 'write_file',
          description: 'write',
          capability: 'write',
          requiredParameters: ['path', 'content'],
          parameters: {
            path: 'Destination path.',
            content: 'Complete file contents.'
          },
          async run() {
            return { ok: true, output: 'unused' };
          }
        }
      ]
    });

    await agent.run('build an app');
    const systemPrompt = provider.messages[0]?.[0]?.content ?? '';
    expect(systemPrompt).toContain('<workspace_build_rules>');
    expect(systemPrompt).toContain('Workspace: /repo');
    expect(systemPrompt).toContain('Act mode is active.');
    expect(systemPrompt).toContain('**Execution & File Mutation Rules:**');
    expect(systemPrompt).toContain('Before creating, initializing, or scaffolding a project in a user-named directory');
    expect(systemPrompt).toContain('write_file creates missing parent directories automatically');
    expect(systemPrompt).toContain('**Validation & Dependencies:**');
    expect(systemPrompt).not.toContain('create package.json scripts and use npm commands by default');
    expect(systemPrompt).toContain('Do not create a new validator or test script just to prove a simple static artifact exists');
    expect(systemPrompt).toContain('make it assert every important requested behavior and constraint');
    expect(systemPrompt).toContain('partial output contains success-looking text');
    expect(systemPrompt).toContain('**Generated Web App Quality:**');
    expect(systemPrompt).toContain('Prefer self-contained local assets');
    expect(systemPrompt).toContain('validation must execute or syntax-check the changed script');
    expect(systemPrompt).toContain('Never write self-correction notes');
    expect(systemPrompt).toContain('**Communication Workflow:**');
    expect(systemPrompt).toContain('Do not end with tool calls only, reasoning only, or an empty reply.');
    expect(systemPrompt).toContain('Never emit raw transport syntax');
    expect(systemPrompt).toContain('escape literal newlines as \\n');
    expect(systemPrompt).toContain('<available_tools>');
    expect(systemPrompt).toContain('Capability write: write_file');
    expect(systemPrompt).toContain('Required parameters: path, content');
    expect(systemPrompt).toContain('- content: Complete file contents.');
  });
});
