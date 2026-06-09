import { spawn } from 'node:child_process';
import { OpenAICompatibleLocalProvider, listOpenAICompatibleModels, normalizeOpenAICompatibleBaseUrl, parseProviderEndpointUrl, pathSegments, serializeProviderEndpointUrl } from './openAiCompatibleProvider.js';
import type { GenerateOptions, ModelProvider, StreamChunk } from '../types.js';

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  contextTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  generationStartTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PrepareOllamaOptions extends OllamaProviderOptions {
  autoStart?: boolean;
  requestTimeoutMs?: number;
}

export interface OllamaModelInfo {
  name: string;
  provider: 'ollama';
  sizeBytes?: number;
  modifiedAt?: string;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
  contextTokens?: number;
}

export interface OllamaModelCapabilities {
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
  contextTokens?: number;
}

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

const defaultBaseUrl = 'http://127.0.0.1:11434';
const defaultModel = 'gemma4:26b';
const defaultContextTokens = 262_144;
const defaultTemperature = 1;
const defaultTopP = 0.95;
export const defaultOllamaStreamInactivityTimeoutMs = 180_000;
export const defaultOllamaGenerationStartTimeoutMs = 30 * 60_000;
const ollamaStartupTimeoutMs = 10_000;
const ollamaPrepareRequestTimeoutMs = 15_000;

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  private readonly provider: OpenAICompatibleLocalProvider;

  constructor(options: OllamaProviderOptions = {}) {
    this.provider = new OpenAICompatibleLocalProvider({
      providerName: 'ollama',
      displayName: 'Ollama',
      baseUrl: options.baseUrl ?? defaultBaseUrl,
      model: options.model ?? defaultModel,
      contextTokens: options.contextTokens ?? defaultContextTokens,
      temperature: options.temperature ?? defaultTemperature,
      topP: options.topP ?? defaultTopP,
      topK: options.topK,
      maxTokens: options.maxTokens,
      autoDisablesProviderReasoning: true,
      generationStartTimeoutMs: options.generationStartTimeoutMs ?? defaultOllamaGenerationStartTimeoutMs,
      streamInactivityTimeoutMs: options.streamInactivityTimeoutMs ?? defaultOllamaStreamInactivityTimeoutMs,
      fetchImpl: options.fetchImpl,
      emptyResponseLabel: 'Ollama OpenAI-compatible response'
    });
  }

  async generate(messages: Parameters<ModelProvider['generate']>[0], options: GenerateOptions = {}): Promise<string> {
    return await this.provider.generate(messages, options);
  }

  async *generateStream(messages: Parameters<OpenAICompatibleLocalProvider['generateStream']>[0], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    yield* this.provider.generateStream(messages, options);
  }
}

export async function prepareOllama(options: PrepareOllamaOptions = {}): Promise<void> {
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const model = options.model ?? defaultModel;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestFetch = withFetchTimeout(fetchImpl, options.requestTimeoutMs ?? ollamaPrepareRequestTimeoutMs);

  let models: string[];
  try {
    models = await listOllamaModels(baseUrl, requestFetch);
  } catch (error) {
    if (options.autoStart === false || normalizeOpenAICompatibleBaseUrl(baseUrl) !== normalizeOpenAICompatibleBaseUrl(defaultBaseUrl)) {
      throw ollamaUnavailableError(error, model, baseUrl);
    }
    await startOllamaServer();
    models = await waitForOllama(baseUrl, requestFetch, model);
  }

  if (!models.includes(model)) {
    throw new Error(`Ollama model "${model}" is not installed. Install it with: ollama pull ${model}`);
  }
}

export async function ensureOllamaRunning(options: Pick<PrepareOllamaOptions, 'baseUrl' | 'autoStart' | 'requestTimeoutMs' | 'fetchImpl'> = {}): Promise<void> {
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestFetch = withFetchTimeout(fetchImpl, options.requestTimeoutMs ?? ollamaPrepareRequestTimeoutMs);
  try {
    await listOllamaModels(baseUrl, requestFetch);
    return;
  } catch (error) {
    if (options.autoStart === false || normalizeOpenAICompatibleBaseUrl(baseUrl) !== normalizeOpenAICompatibleBaseUrl(defaultBaseUrl)) {
      throw ollamaUnavailableError(error, defaultModel, baseUrl);
    }
    await startOllamaServer();
    await waitForOllama(baseUrl, requestFetch, defaultModel);
  }
}

export async function listOllamaModels(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listOllamaModelInfos(baseUrl, fetchImpl)).map((model) => model.name);
}

export async function listOllamaModelInfos(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<OllamaModelInfo[]> {
  const models = await listOpenAICompatibleModels(baseUrl, fetchImpl, 'Ollama');
  return models
    .filter((model) => !isGemmaCliInternalModel(model.id))
    .map((model) => ({
      name: model.id,
      provider: 'ollama' as const,
      modifiedAt: typeof model.created === 'number' ? new Date(model.created * 1000).toISOString() : undefined
    }));
}

export async function getOllamaModelCapabilities(model: string, baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<OllamaModelCapabilities> {
  const response = await fetchImpl(`${normalizeOllamaBaseUrl(baseUrl)}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model })
  });
  if (!response.ok) {
    throw new Error(`Ollama model details failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as OllamaShowResponse;
  const capabilities = new Set((body.capabilities ?? []).map((capability) => capability.toLowerCase()));
  return {
    supportsImage: capabilities.has('vision'),
    supportsAudio: capabilities.has('audio'),
    supportsReasoning: capabilities.has('thinking'),
    contextTokens: extractOllamaShowContextTokens(body)
  };
}

function isGemmaCliInternalModel(model: string): boolean {
  return model.startsWith('gemma-cli/');
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const url = parseProviderEndpointUrl(baseUrl, 'Ollama endpoint');
  const segments = pathSegments(url);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const v1Index = lowerSegments.lastIndexOf('v1');
  if (v1Index >= 0) {
    url.pathname = `/${segments.slice(0, v1Index).join('/')}`;
    return serializeProviderEndpointUrl(url);
  }
  const nativeApiIndex = lowerSegments.findIndex((segment, index) =>
    segment === 'api'
    && ['chat', 'copy', 'delete', 'embeddings', 'generate', 'pull', 'ps', 'show', 'tags'].includes(lowerSegments[index + 1] ?? '')
  );
  if (nativeApiIndex >= 0) {
    url.pathname = `/${segments.slice(0, nativeApiIndex).join('/')}`;
  }
  return serializeProviderEndpointUrl(url);
}

function extractOllamaShowContextTokens(body: OllamaShowResponse): number | undefined {
  const info = body.model_info ?? {};
  const exactKeys = [
    'context_length',
    'llama.context_length',
    'gemma.context_length',
    'qwen.context_length'
  ];
  for (const key of exactKeys) {
    const value = readPositiveInteger(info[key]);
    if (value !== undefined) {
      return value;
    }
  }

  for (const [key, value] of Object.entries(info)) {
    if (/context_length$/i.test(key)) {
      const parsed = readPositiveInteger(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function ollamaUnavailableError(error: unknown, model: string, baseUrl: string): Error {
  return new Error(
    [
      `Ollama is not reachable at ${normalizeOpenAICompatibleBaseUrl(baseUrl)}.`,
      'Install Ollama, start it with `ollama serve`, and install the required model with:',
      `ollama pull ${model}`,
      `Original error: ${error instanceof Error ? error.message : String(error)}`
    ].join('\n')
  );
}

async function startOllamaServer(): Promise<void> {
  try {
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? '1',
        OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS ?? '1'
      }
    });
    child.on('error', () => undefined);
    child.unref();
  } catch (error) {
    throw new Error(`Unable to start Ollama. Install Ollama and run \`ollama serve\`. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForOllama(baseUrl: string, fetchImpl: typeof fetch, model: string): Promise<string[]> {
  const deadline = Date.now() + ollamaStartupTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await listOllamaModels(baseUrl, fetchImpl);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw ollamaUnavailableError(lastError, model, baseUrl);
}

function withFetchTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (async (input, init) => {
    const controller = new AbortController();
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    try {
      if (upstreamSignal?.aborted) {
        controller.abort(upstreamSignal.reason);
      } else {
        upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
      }
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (didTimeout && isAbortError(error)) {
        throw new Error(`Ollama OpenAI-compatible request timed out after ${formatTimeout(timeoutMs)}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  }) as typeof fetch;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
}
