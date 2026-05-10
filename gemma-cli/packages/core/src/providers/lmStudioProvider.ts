import { OpenAICompatibleLocalProvider, listOpenAICompatibleModels } from './openAiCompatibleProvider.js';
import type { GenerateOptions, ModelProvider, StreamChunk } from '../types.js';

export interface LmStudioProviderOptions {
  baseUrl?: string;
  model?: string;
  contextTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  reasoning?: boolean;
  fetchImpl?: typeof fetch;
}

export interface LmStudioModelInfo {
  name: string;
  provider: 'lmstudio';
  displayName?: string;
  selectedVariant?: string;
  loadedInstanceId?: string;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
}

const defaultBaseUrl = 'http://127.0.0.1:1234';
const defaultModel = 'gemma-3-27b-it';
const defaultContextTokens = 262_144;
const defaultTemperature = 1;
const defaultTopP = 0.95;

export class LmStudioProvider implements ModelProvider {
  readonly name = 'lmstudio';
  private readonly provider: OpenAICompatibleLocalProvider;

  constructor(options: LmStudioProviderOptions = {}) {
    this.provider = new OpenAICompatibleLocalProvider({
      providerName: 'lmstudio',
      displayName: 'LM Studio',
      baseUrl: options.baseUrl ?? defaultBaseUrl,
      model: options.model ?? defaultModel,
      contextTokens: options.contextTokens ?? defaultContextTokens,
      temperature: options.temperature ?? defaultTemperature,
      topP: options.topP ?? defaultTopP,
      maxTokens: options.maxTokens,
      supportsReasoning: options.reasoning,
      fetchImpl: options.fetchImpl,
      emptyResponseLabel: 'LM Studio OpenAI-compatible response'
    });
  }

  async generate(messages: Parameters<ModelProvider['generate']>[0], options: GenerateOptions = {}): Promise<string> {
    return await this.provider.generate(messages, options);
  }

  async *generateStream(messages: Parameters<OpenAICompatibleLocalProvider['generateStream']>[0], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    yield* this.provider.generateStream(messages, options);
  }
}

export async function listLmStudioModels(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listLmStudioModelInfos(baseUrl, fetchImpl)).map((model) => model.name);
}

export async function listLmStudioModelInfos(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<LmStudioModelInfo[]> {
  const models = await listOpenAICompatibleModels(baseUrl, fetchImpl, 'LM Studio');
  return models.map((model) => ({
    name: model.id,
    provider: 'lmstudio' as const,
    displayName: model.id
  }));
}
