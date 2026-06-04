import { OpenAICompatibleLocalProvider, listOpenAICompatibleModels } from './openAiCompatibleProvider.js';
import type { GenerateOptions, ModelProvider, StreamChunk } from '../types.js';

export interface LlamaCppProviderOptions {
  baseUrl?: string;
  model?: string;
  contextTokens?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface LlamaCppModelInfo {
  name: string;
  provider: 'llamacpp';
  displayName?: string;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
}

const defaultBaseUrl = 'http://127.0.0.1:8080';
const defaultModel = 'gemma-3-27b-it';
const defaultContextTokens = 262_144;
const defaultTemperature = 1;
const defaultTopP = 0.95;

export class LlamaCppProvider implements ModelProvider {
  readonly name = 'llamacpp';
  private readonly provider: OpenAICompatibleLocalProvider;

  constructor(options: LlamaCppProviderOptions = {}) {
    this.provider = new OpenAICompatibleLocalProvider({
      providerName: 'llamacpp',
      displayName: 'llama.cpp',
      baseUrl: options.baseUrl ?? defaultBaseUrl,
      model: options.model ?? defaultModel,
      contextTokens: options.contextTokens ?? defaultContextTokens,
      temperature: options.temperature ?? defaultTemperature,
      topP: options.topP ?? defaultTopP,
      maxTokens: options.maxTokens,
      supportsReasoning: true,
      fetchImpl: options.fetchImpl,
      emptyResponseLabel: 'llama.cpp OpenAI-compatible response',
    });
  }

  async generate(messages: Parameters<ModelProvider['generate']>[0], options: GenerateOptions = {}): Promise<string> {
    return await this.provider.generate(messages, options);
  }

  async *generateStream(messages: Parameters<OpenAICompatibleLocalProvider['generateStream']>[0], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    yield* this.provider.generateStream(messages, options);
  }
}

export async function listLlamaCppModels(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listLlamaCppModelInfos(baseUrl, fetchImpl)).map((model) => model.name);
}

export async function listLlamaCppModelInfos(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<LlamaCppModelInfo[]> {
  const models = await listOpenAICompatibleModels(baseUrl, fetchImpl, 'llama.cpp');
  return models.map((model) => ({
    name: model.id,
    provider: 'llamacpp' as const,
    displayName: model.id,
    supportsImage: false,
    supportsAudio: false,
    supportsReasoning: true,
  }));
}
