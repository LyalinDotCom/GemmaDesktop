import { describe, expect, it } from 'vitest';
import { AcpRuntime } from './acp.js';

describe('AcpRuntime', () => {
  it('initializes with bounded capabilities', async () => {
    const acp = new AcpRuntime({
      provider: 'lmstudio',
      cwd: process.cwd(),
      maxTurns: 8,
      contextTokens: 262144,
      temperature: 1,
      topP: 0.95,
      topK: 64,
      reasoningMode: 'auto',
      ollamaAutoStart: true,
      yolo: false,
      skills: [],
      tui: false,
      acp: true,
      json: false,
      jsonStream: false,
      help: false,
      version: false
    });

    await expect(acp.handleRequest({ id: 1, method: 'initialize' })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: ['session/new', 'session/prompt', 'models/list', 'skills/list'] }
    });
  });

  it('rejects unknown methods', async () => {
    const acp = new AcpRuntime({
      provider: 'ollama',
      cwd: process.cwd(),
      maxTurns: 8,
      contextTokens: 262144,
      temperature: 1,
      topP: 0.95,
      topK: 64,
      reasoningMode: 'auto',
      ollamaAutoStart: true,
      yolo: false,
      skills: [],
      tui: false,
      acp: true,
      json: false,
      jsonStream: false,
      help: false,
      version: false
    });

    await expect(acp.handleRequest({ id: 1, method: 'nope' })).resolves.toMatchObject({
      error: { code: -32601 }
    });
  });
});
