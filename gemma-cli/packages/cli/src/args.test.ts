import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('defaults to ollama and accepts prompt text', () => {
    expect(parseArgs(['--prompt', 'hello'], { INIT_CWD: '/launch/root' })).toMatchObject({
      provider: 'ollama',
      prompt: 'hello',
      cwd: '/launch/root',
      skills: [],
      contextTokens: 262144,
      temperature: 1,
      topP: 0.95,
      topK: 64,
      reasoningMode: 'auto',
      ollamaAutoStart: true,
      yolo: false
    });
    expect(parseArgs(['--prompt', 'hello'], { INIT_CWD: '/launch/root' }).maxTurns).toBeUndefined();
  });

  it('parses LM Studio provider and scenario', () => {
    expect(parseArgs(['--provider', 'lmstudio', '--scenario', 'file-analysis'], {})).toMatchObject({
      provider: 'lmstudio',
      scenario: 'file-analysis',
    });
  });

  it('parses Gemini provider and API settings', () => {
    expect(parseArgs([
      '--provider',
      'gemini',
      '--gemini-api-key',
      'test-key',
      '--gemini-api-base-url',
      'http://gemini.local/v1beta'
    ], {})).toMatchObject({
      provider: 'gemini',
      geminiApiKey: 'test-key',
      geminiApiBaseUrl: 'http://gemini.local/v1beta'
    });
    expect(parseArgs([], { GEMMA_PROVIDER: 'gemini', GEMINI_API_KEY: 'env-key' })).toMatchObject({
      provider: 'gemini',
      geminiApiKey: 'env-key'
    });
  });

  it('maps generic endpoint flags to the selected provider', () => {
    expect(parseArgs(['--provider', 'ollama', '--endpoint', 'http://ollama.remote:11434'], {})).toMatchObject({
      provider: 'ollama',
      ollamaUrl: 'http://ollama.remote:11434'
    });
    expect(parseArgs(['--endpoint', 'http://lm.remote:1234', '--provider', 'lmstudio'], {})).toMatchObject({
      provider: 'lmstudio',
      lmStudioUrl: 'http://lm.remote:1234'
    });
    expect(parseArgs(['--provider', 'gemini', '--endpoint', 'https://gemini.local/v1beta'], {})).toMatchObject({
      provider: 'gemini',
      geminiApiBaseUrl: 'https://gemini.local/v1beta'
    });
    expect(parseArgs(['--provider', 'llamacpp', '--endpoint', 'http://llama.local:8080'], {})).toMatchObject({
      provider: 'llamacpp',
      llamaCppUrl: 'http://llama.local:8080'
    });
    expect(parseArgs(['--provider', 'litertlm', '--endpoint', 'http://litert.local:9379'], {})).toMatchObject({
      provider: 'litertlm',
      liteRtLmUrl: 'http://litert.local:9379'
    });
  });

  it('maps GEMMA_ENDPOINT to GEMMA_PROVIDER unless a specific endpoint is configured', () => {
    expect(parseArgs([], { GEMMA_PROVIDER: 'lmstudio', GEMMA_ENDPOINT: 'http://lm.remote:1234' })).toMatchObject({
      provider: 'lmstudio',
      lmStudioUrl: 'http://lm.remote:1234'
    });
    expect(parseArgs([], { GEMMA_ENDPOINT: 'http://generic:11434', OLLAMA_URL: 'http://specific:11434' })).toMatchObject({
      provider: 'ollama',
      ollamaUrl: 'http://specific:11434'
    });
    expect(parseArgs(['--endpoint', 'http://cli:11434'], { OLLAMA_URL: 'http://env:11434' })).toMatchObject({
      ollamaUrl: 'http://cli:11434'
    });
    expect(parseArgs(['--endpoint', 'http://cli:11434', '--ollama-url', 'http://specific:11434'], {})).toMatchObject({
      ollamaUrl: 'http://specific:11434'
    });
    expect(parseArgs([], { GEMMA_PROVIDER: 'llamacpp', GEMMA_ENDPOINT: 'http://llama.remote:8080' })).toMatchObject({
      provider: 'llamacpp',
      llamaCppUrl: 'http://llama.remote:8080'
    });
    expect(parseArgs([], { GEMMA_PROVIDER: 'litertlm', GEMMA_ENDPOINT: 'http://litert.remote:9379' })).toMatchObject({
      provider: 'litertlm',
      liteRtLmUrl: 'http://litert.remote:9379'
    });
  });

  it('parses reasoning mode', () => {
    expect(parseArgs(['--think', 'off'], {})).toMatchObject({
      reasoningMode: 'off'
    });
    expect(() => parseArgs(['--think', 'maybe'], {})).toThrow('--think must be auto, on, or off');
  });

  it('parses yolo mode', () => {
    expect(parseArgs(['--yolo'], {})).toMatchObject({
      yolo: true
    });
  });

  it('parses JSON streaming mode separately from final JSON mode', () => {
    expect(parseArgs(['--json-stream'], {})).toMatchObject({
      json: false,
      jsonStream: true
    });
    expect(parseArgs(['--json', '--json-stream'], {})).toMatchObject({
      json: true,
      jsonStream: true
    });
  });

  it('parses version flags', () => {
    expect(parseArgs(['--version'], {})).toMatchObject({ version: true });
    expect(parseArgs(['-v'], {})).toMatchObject({ version: true });
  });

  it('rejects unknown providers', () => {
    expect(() => parseArgs(['--provider', 'other'], {})).toThrow('--provider must be ollama, lmstudio, llamacpp, litertlm, or gemini');
    expect(() => parseArgs(['--provider', 'remote-ai'], {})).toThrow('--provider must be ollama, lmstudio, llamacpp, litertlm, or gemini');
    expect(parseArgs([], { GEMMA_PROVIDER: 'remote-ai' })).toMatchObject({
      provider: 'ollama'
    });
  });

  it('parses LM Studio provider and endpoint', () => {
    expect(parseArgs(['--provider', 'lmstudio', '--lmstudio-url', 'http://localhost:1234'], {})).toMatchObject({
      provider: 'lmstudio',
      lmStudioUrl: 'http://localhost:1234'
    });
    expect(parseArgs(['--provider', 'lmstudio'], {}).maxTurns).toBeUndefined();
  });

  it('parses llama.cpp and LiteRT-LM provider endpoints', () => {
    expect(parseArgs(['--provider', 'llama-cpp', '--llamacpp-url', 'http://localhost:8080'], {})).toMatchObject({
      provider: 'llamacpp',
      llamaCppUrl: 'http://localhost:8080'
    });
    expect(parseArgs(['--provider', 'litert-lm', '--litertlm-url', 'http://localhost:9379'], {})).toMatchObject({
      provider: 'litertlm',
      liteRtLmUrl: 'http://localhost:9379'
    });
  });

  it('keeps explicit max turn limits for local providers', () => {
    expect(parseArgs(['--provider', 'ollama', '--max-turns', '12'], {})).toMatchObject({
      provider: 'ollama',
      maxTurns: 12
    });
  });

  it('parses tui, acp, and repeated skill flags', () => {
    expect(parseArgs(['--tui', '--acp', '--skill', 'Coding', '--skill', 'Shell'], {})).toMatchObject({
      tui: true,
      acp: true,
      skills: ['Coding', 'Shell']
    });
  });

  it('parses model token budget', () => {
    expect(parseArgs(['--max-tokens', '8192'], {})).toMatchObject({
      maxTokens: 8192
    });
  });

  it('parses local generation defaults and Ollama autostart control', () => {
    expect(parseArgs([
      '--context-tokens',
      '131072',
      '--temperature',
      '0.7',
      '--top-p',
      '0.8',
      '--top-k',
      '40',
      '--no-ollama-autostart'
    ], {})).toMatchObject({
      contextTokens: 131072,
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
      ollamaAutoStart: false
    });
  });

  it('parses shell idle timeout from flags and environment', () => {
    expect(parseArgs(['--shell-idle-timeout-ms', '120000'], {})).toMatchObject({
      shellIdleTimeoutMs: 120000
    });
    expect(parseArgs([], { GEMMA_CLI_SHELL_IDLE_TIMEOUT_MS: '90000' })).toMatchObject({
      shellIdleTimeoutMs: 90000
    });
    expect(() => parseArgs(['--shell-idle-timeout-ms', '0'], {})).toThrow('--shell-idle-timeout-ms must be a positive integer');
  });

  it('parses resume flags and session listing', () => {
    expect(parseArgs(['--resume'], {})).toMatchObject({ resume: 'latest' });
    expect(parseArgs(['--resume', 'abc123'], {})).toMatchObject({ resume: 'abc123' });
    expect(parseArgs(['--list-sessions'], {})).toMatchObject({ listSessions: true });
    expect(parseArgs(['--list-models'], {})).toMatchObject({ listModels: true });
  });
});
