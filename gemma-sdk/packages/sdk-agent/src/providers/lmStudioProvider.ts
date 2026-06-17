import {
  OpenAICompatibleLocalProvider,
  listOpenAICompatibleModels,
  normalizeOpenAICompatibleBaseUrl
} from './openAiCompatibleProvider.js';
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

interface LmStudioNativeModelsResponse {
  data?: Array<{
    id?: string;
    display_name?: string;
    selected_variant?: string;
    loaded_instance_id?: string;
    capabilities?: unknown;
    max_context_length?: number;
    loaded_context_length?: number;
  }>;
}

const defaultBaseUrl = 'http://127.0.0.1:1234';
const defaultModel = 'gemma-3-27b-it';
const defaultContextTokens = 262_144;
const defaultTemperature = 1;
const defaultTopP = 0.95;
const lmStudioNativeProbeTimeoutMs = 5_000;

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
      topK: options.topK,
      maxTokens: options.maxTokens,
      // `undefined` means "reasoning support unknown" — let the inner provider
      // default to attempting reasoning (with a retry-without-reasoning fallback)
      // so an explicit `--think on` is honored instead of being silently dropped.
      // Only an explicit `false` (model known not to support it) disables it.
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
  const nativeModels = await listLmStudioNativeModelInfos(baseUrl, fetchImpl);
  const nativeById = new Map(nativeModels.map((model) => [model.name, model]));
  const openAIModelIds = new Set(models.map((model) => model.id));
  const mergedModels = models.map((model) => {
    const native = nativeById.get(model.id);
    return {
      name: model.id,
      provider: 'lmstudio' as const,
      displayName: native?.displayName ?? model.id,
      ...(native?.selectedVariant !== undefined ? { selectedVariant: native.selectedVariant } : {}),
      ...(native?.loadedInstanceId !== undefined ? { loadedInstanceId: native.loadedInstanceId } : {}),
      ...(native?.supportsImage !== undefined ? { supportsImage: native.supportsImage } : {}),
      ...(native?.supportsAudio !== undefined ? { supportsAudio: native.supportsAudio } : {}),
      ...(native?.supportsReasoning !== undefined ? { supportsReasoning: native.supportsReasoning } : {})
    };
  });
  const nativeOnlyModels = nativeModels.filter((model) => !openAIModelIds.has(model.name));
  return [...mergedModels, ...nativeOnlyModels]
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listLmStudioNativeModelInfos(baseUrl: string, fetchImpl: typeof fetch): Promise<LmStudioModelInfo[]> {
  try {
    const root = lmStudioRootUrl(baseUrl);
    // Bound the native capability probe so a stalled LM Studio cannot hang model
    // listing / capability resolution at startup.
    const response = await fetchImpl(`${root}/api/v0/models`, { signal: AbortSignal.timeout(lmStudioNativeProbeTimeoutMs) });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as LmStudioNativeModelsResponse;
    return (body.data ?? []).flatMap((model) => {
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      if (!id) {
        return [];
      }
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.map((capability) => String(capability).toLowerCase())
        : [];
      const supportsImage = capabilities.some((capability) => /vision|image/.test(capability));
      const supportsAudio = capabilities.some((capability) => /audio|speech/.test(capability));
      return [{
        name: id,
        provider: 'lmstudio' as const,
        displayName: typeof model.display_name === 'string' ? model.display_name : id,
        selectedVariant: typeof model.selected_variant === 'string' ? model.selected_variant : undefined,
        loadedInstanceId: typeof model.loaded_instance_id === 'string' ? model.loaded_instance_id : undefined,
        supportsImage: supportsImage ? true : undefined,
        supportsAudio: supportsAudio ? true : undefined,
        // Match the image/audio handling: a model that does not advertise a
        // reasoning capability (or an older LM Studio build with no capability
        // list) is "unknown", not "unsupported". Returning `false` here would
        // silently override an explicit `--think on`.
        supportsReasoning: capabilities.some((capability) => /reason|think/.test(capability)) ? true : undefined
      }];
    });
  } catch {
    return [];
  }
}

function lmStudioRootUrl(baseUrl: string): string {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const url = new URL(normalized);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === 'v1') {
    url.pathname = `/${segments.slice(0, -1).join('/')}`;
  }
  return url.toString().replace(/\/+$/, '');
}
