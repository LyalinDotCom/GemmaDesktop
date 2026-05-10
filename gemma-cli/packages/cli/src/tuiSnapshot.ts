import { renderTuiFrame } from './tuiRenderer.js';
import { slashSuggestions, type TuiSession } from './tui.js';
import type { Runtime } from './runtime.js';
import type { ModelProvider } from 'gemma-cli-core';

const provider: ModelProvider = {
  name: 'ollama',
  async generate() {
    return '';
  }
};

const runtime: Runtime = {
  provider,
  model: 'gemma4:26b',
  cwd: '/Users/example/Source/gemma-cli',
  maxTurns: 32,
  tools: [],
  skills: [],
  async run() {
    return { answer: '', turns: [], stats: { durationMs: 0, turns: 0, toolCalls: 0 } };
  },
  async *stream() {
    yield { done: true };
  }
};

const session: TuiSession = {
  runtime,
  provider: 'ollama',
  history: [],
  scrollOffset: 0,
  flash: 'Ready.',
  inputBuffer: '/',
  commandSuggestions: slashSuggestions('/') ?? []
};

console.log(renderTuiFrame(session, { width: 110, height: 28, color: false }));
