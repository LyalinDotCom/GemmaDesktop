import { describe, expect, it } from 'vitest';
import { buildAgentSystemPrompt, renderEnvironmentBlock } from './agent.js';
import type { Tool } from './types.js';

const sampleTool: Tool = {
  name: 'exec_command',
  description: 'Run a shell command.',
  async run() {
    return { ok: true, output: '' };
  }
};

const writeTool: Tool = {
  name: 'write_file',
  description: 'Write a file.',
  async run() {
    return { ok: true, output: '' };
  }
};

describe('buildAgentSystemPrompt', () => {
  it('identifies as a local-model coding tool optimized for Gemma', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('Gemma CLI');
    expect(prompt).toContain('local-model');
    expect(prompt).toMatch(/optimized for Gemma/i);
    expect(prompt).toMatch(/Ollama|LM Studio/);
  });

  it('lists available tool names inline at the top', () => {
    const prompt = buildAgentSystemPrompt({
      tools: [sampleTool, { name: 'read_file', description: 'r', async run() { return { ok: true, output: '' }; } }]
    });
    expect(prompt).toContain('Tools you can call this turn: exec_command, read_file');
  });

  it('emits a runtime-query example when exec_command is available', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('<runtime_query_example>');
    expect(prompt).toContain('"tool":"exec_command","args":{"command":"date"}');
    expect(prompt).toMatch(/Wrong:.*```bash/);
  });

  it('tells the model to trust successful command exit status', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('ok:true means the process exited with status 0');
  });

  it('enables Gemma thinking instructions for dashed Gemma 4 model ids', () => {
    const prompt = buildAgentSystemPrompt({
      tools: [sampleTool],
      model: 'google/gemma-4-26b-a4b'
    });
    expect(prompt).toContain('Thinking mode is enabled for this Gemma 4 coding conversation.');
    expect(prompt).toContain('Gemma 4 native tool-call transport is also accepted');
    expect(prompt).toContain('<|tool>declaration:exec_command');
  });

  it('keeps the generic JSON-only transport warning for non-Gemma models', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool], model: 'qwen2.5-coder' });
    expect(prompt).toContain('Never emit raw transport syntax');
    expect(prompt).not.toContain('Gemma 4 native tool-call transport is also accepted');
    expect(prompt).not.toContain('<|tool>declaration:exec_command');
  });

  it('requires direct CLI validation and non-fake build scripts', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('run at least one direct CLI command');
    expect(prompt).toContain('Do not use a build script that only echoes or prints success');
    expect(prompt).toContain('Create package.json scripts only when the user asks for a package-managed app');
    expect(prompt).not.toContain('create package.json scripts and use npm commands by default');
    expect(prompt).toContain('Do not create a new validator or test script just to prove a simple static artifact exists');
  });

  it('includes non-interactive container recovery guidance', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('nohup <command> > /tmp/<service>.log 2>&1 &');
    expect(prompt).toContain('kill -0 <PID>');
    expect(prompt).toContain('pgrep/ps/pidof -> procps');
    expect(prompt).toContain('ss/ip -> iproute2');
  });

  it('keeps tool-result turns action-oriented', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool] });
    expect(prompt).toContain('After a tool result, do not restate the full task or repeat earlier analysis');
    expect(prompt).toContain('decide the next concrete action');
  });

  it('steers handwritten multiline file creation away from shell heredocs', () => {
    const prompt = buildAgentSystemPrompt({ tools: [sampleTool, writeTool] });
    expect(prompt).toContain('do not use shell heredocs, echo, printf, or python -c for hand-written multiline file contents when write_file is available');
    expect(prompt).not.toContain('any command that creates or modifies files');
  });

  it('omits the runtime-query example when exec_command is not available', () => {
    const prompt = buildAgentSystemPrompt({
      tools: [{ name: 'read_file', description: 'r', async run() { return { ok: true, output: '' }; } }]
    });
    expect(prompt).not.toContain('<runtime_query_example>');
  });

  it('emits a search-strategy block when search tools are present', () => {
    const prompt = buildAgentSystemPrompt({
      tools: [
        { name: 'search_paths', description: 's', async run() { return { ok: true, output: '' }; } },
        { name: 'search_text', description: 's', async run() { return { ok: true, output: '' }; } },
        { name: 'read_file', description: 'r', async run() { return { ok: true, output: '' }; } }
      ]
    });
    expect(prompt).toContain('<search_strategy>');
    expect(prompt).toContain('search_paths');
    expect(prompt).toContain('search_text');
    expect(prompt).toMatch(/parallel/i);
    expect(prompt).toMatch(/Cap result counts/);
  });

  it('drops permission-prompt language under yolo mode', () => {
    const promptDefault = buildAgentSystemPrompt({ tools: [sampleTool], yolo: false });
    const promptYolo = buildAgentSystemPrompt({ tools: [sampleTool], yolo: true });
    expect(promptDefault).toMatch(/permission/i);
    expect(promptYolo).toMatch(/Yolo mode is active/);
    expect(promptYolo).not.toMatch(/may prompt the user for permission/);
  });
});

describe('renderEnvironmentBlock', () => {
  it('includes formatted time and timezone when provided', () => {
    const block = renderEnvironmentBlock({
      environment: { time: '2026-05-03 14:22 PDT', timezone: 'America/Los_Angeles' }
    });
    expect(block).toContain('time: 2026-05-03 14:22 PDT (America/Los_Angeles)');
  });

  it('falls back to date when time is not provided', () => {
    const block = renderEnvironmentBlock({ environment: { date: '2026-05-03' } });
    expect(block).toContain('date: 2026-05-03');
  });

  it('renders git context with branch, dirty state, repoRoot, and last commit', () => {
    const block = renderEnvironmentBlock({
      environment: {
        git: { branch: 'main', dirty: true, repoRoot: '/repo', lastCommit: 'abc1234 fix: stuff' }
      }
    });
    expect(block).toMatch(/git: main \(dirty\)\s+root=\/repo/);
    expect(block).toContain('last commit: abc1234 fix: stuff');
  });

  it('renders clean git state when not dirty', () => {
    const block = renderEnvironmentBlock({ environment: { git: { branch: 'main', dirty: false } } });
    expect(block).toMatch(/git: main \(clean\)/);
  });

  it('emits platform-specific shell guidance', () => {
    expect(renderEnvironmentBlock({ environment: { platform: 'darwin' } })).toMatch(/zsh|bash on macOS/);
    expect(renderEnvironmentBlock({ environment: { platform: 'linux' } })).toMatch(/bash\/sh on Linux/);
    expect(renderEnvironmentBlock({ environment: { platform: 'win32' } })).toMatch(/PowerShell/);
  });
});
