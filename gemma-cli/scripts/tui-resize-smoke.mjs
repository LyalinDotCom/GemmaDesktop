#!/usr/bin/env node
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const pty = require('@lydell/node-pty');

const cwd = new URL('..', import.meta.url).pathname;
const harness = `
import React from 'react';
import { render } from './packages/cli/node_modules/ink/build/index.js';
import { App } from './packages/cli/dist/tui/ink/App.js';

const runtime = {
  provider: { name: 'ollama', generate: async () => 'unused', stream: async function* () {} },
  model: 'gemma4:26b',
  selectedModel: 'gemma4:26b',
  cwd: process.cwd(),
  skills: [],
  tools: [],
  messages: [],
  contextTokens: 262144,
  async run(prompt) {
    return { answer: prompt, turns: [], stats: { durationMs: 0, turns: 0, toolCalls: 0 } };
  },
  async *stream(prompt) {
    yield { content: prompt, done: false };
    yield { done: true };
  }
};

const session = {
  runtime,
  runtimeReady: new Promise((resolve) => setTimeout(() => resolve(runtime), 900)),
  provider: 'ollama',
  contextTokens: 262144,
  reasoningMode: 'on',
  history: [
    { kind: 'user', text: 'resize smoke prompt' },
    { kind: 'assistant', text: 'This transcript should survive terminal resizing while the spinner is active.' }
  ],
  scrollOffset: 0,
  autoFollow: true,
  flash: 'resize smoke'
};

const app = render(React.createElement(App, {
  session,
  inputStream: process.stdin,
  output: process.stdout
}), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  exitOnCtrlC: false,
  patchConsole: false,
  standardReactLayoutTiming: false,
  terminalBuffer: false
});

await app.waitUntilExit();
`;

const child = pty.spawn(process.execPath, ['--input-type=module', '--eval', harness], {
  name: 'xterm-256color',
  cols: 120,
  rows: 32,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' }
});

let output = '';
let childExit;
child.onData((data) => {
  output += data;
});
child.onExit((event) => {
  childExit = { timedOut: false, ...event };
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resize = (columns, rows) => {
  if (!childExit) {
    child.resize(columns, rows);
  }
};
const write = (text) => {
  if (!childExit) {
    child.write(text);
  }
};

await sleep(350);
resize(72, 18);
await sleep(120);
resize(150, 40);
await sleep(120);
resize(88, 24);
await sleep(900);
write('/clear');
await sleep(80);
write('\r');
await sleep(300);
resize(64, 18);
await sleep(650);
write('/quit');
await sleep(80);
write('\r');

const exit = await new Promise((resolve) => {
  if (childExit) {
    resolve(childExit);
    return;
  }
  const timer = setTimeout(() => resolve({ timedOut: true }), 4_000);
  child.onExit((event) => {
    clearTimeout(timer);
    resolve({ timedOut: false, ...event });
  });
});

const plain = output
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');

const result = {
  exit,
  bytes: output.length,
  repaintedFrame: plain.includes('Gemma CLI') && plain.includes('Send a message') && plain.includes('history cleared'),
  noReactKeyWarning: !plain.includes('Each child in a list should have a unique "key" prop'),
  didNotEndOnClearOnly: !/\x1b\[2J\x1b\[3J\x1b\[H$/.test(output) && !/\x1bc$/.test(output)
};

console.log(JSON.stringify(result, null, 2));

if (
  exit.timedOut ||
  exit.exitCode !== 0 ||
  !result.repaintedFrame ||
  !result.noReactKeyWarning ||
  !result.didNotEndOnClearOnly
) {
  console.error('--- TUI output tail ---');
  console.error(plain.slice(-2_000));
  process.exit(1);
}
