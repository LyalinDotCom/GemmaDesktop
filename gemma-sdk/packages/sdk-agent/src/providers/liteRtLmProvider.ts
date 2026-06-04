import { OpenAICompatibleLocalProvider, listOpenAICompatibleModels } from './openAiCompatibleProvider.js';
import type { GenerateOptions, ModelProvider, StreamChunk } from '../types.js';

export interface LiteRtLmProviderOptions {
  baseUrl?: string;
  model?: string;
  contextTokens?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface LiteRtLmModelInfo {
  name: string;
  provider: 'litertlm';
  displayName?: string;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
}

const defaultBaseUrl = 'http://127.0.0.1:9379';
const defaultModel = 'gemma-3-27b-it';
const defaultContextTokens = 262_144;
const defaultTemperature = 1;
const defaultTopP = 0.95;

export class LiteRtLmProvider implements ModelProvider {
  readonly name = 'litertlm';
  private readonly provider: OpenAICompatibleLocalProvider;

  constructor(options: LiteRtLmProviderOptions = {}) {
    this.provider = new OpenAICompatibleLocalProvider({
      providerName: 'litertlm',
      displayName: 'LiteRT-LM',
      baseUrl: options.baseUrl ?? defaultBaseUrl,
      model: options.model ?? defaultModel,
      contextTokens: options.contextTokens ?? defaultContextTokens,
      temperature: options.temperature ?? defaultTemperature,
      topP: options.topP ?? defaultTopP,
      maxTokens: options.maxTokens,
      supportsReasoning: true,
      fetchImpl: options.fetchImpl,
      emptyResponseLabel: 'LiteRT-LM OpenAI-compatible response',
    });
  }

  async generate(messages: Parameters<ModelProvider['generate']>[0], options: GenerateOptions = {}): Promise<string> {
    return await this.provider.generate(messages, options);
  }

  async *generateStream(messages: Parameters<OpenAICompatibleLocalProvider['generateStream']>[0], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    yield* this.provider.generateStream(messages, options);
  }
}

export async function listLiteRtLmModels(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listLiteRtLmModelInfos(baseUrl, fetchImpl)).map((model) => model.name);
}

export async function listLiteRtLmModelInfos(baseUrl = defaultBaseUrl, fetchImpl: typeof fetch = fetch): Promise<LiteRtLmModelInfo[]> {
  const models = await listOpenAICompatibleModels(baseUrl, fetchImpl, 'LiteRT-LM');
  return models.map((model) => ({
    name: model.id,
    provider: 'litertlm' as const,
    displayName: model.id,
    supportsImage: false,
    supportsAudio: false,
    supportsReasoning: true,
  }));
}
