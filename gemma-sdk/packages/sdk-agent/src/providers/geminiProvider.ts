import type { ChatMessage, GenerateOptions, ModelProvider, StreamChunk } from '../types.js';
import { contentToText, resolveBinaryAssetForRequest, resolveImageAssetForRequest } from '../content.js';

export interface GeminiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface GeminiModelInfo {
  name: string;
  provider: 'gemini';
  displayName?: string;
  supportsReasoning?: boolean;
  supportsImage?: boolean;
  supportsAudio?: boolean;
  supportsPdf?: boolean;
  contextTokens?: number;
  outputTokens?: number;
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedGenerationMethods?: string[];
    thinking?: boolean;
  }>;
  nextPageToken?: string;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
}

const defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const defaultModel = 'gemini-3.5-flash';

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature?: number;
  private readonly topP?: number;
  private readonly maxTokens?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim();
    this.baseUrl = normalizeGeminiApiBaseUrl(options.baseUrl ?? defaultBaseUrl);
    this.model = options.model ?? defaultModel;
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    let text = '';
    for await (const chunk of this.generateStream(messages, options)) {
      if (chunk.content) text += chunk.content;
      await options.onActivity?.(chunk);
    }
    return text;
  }

  async *generateStream(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    if (!this.apiKey) {
      throw new Error('No Gemini API key is configured. Set GEMINI_API_KEY or configure Gemini API in Gemma Desktop Settings.');
    }
    const response = await this.fetchImpl(withApiKey(`${this.baseUrl}/${modelNameForUrl(this.model)}:streamGenerateContent`, this.apiKey, { alt: 'sse' }), {
      method: 'POST',
      signal: options.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await buildRequestBody(messages, {
        temperature: options.temperature ?? this.temperature,
        topP: options.topP ?? this.topP,
        maxTokens: options.maxTokens ?? this.maxTokens,
      })),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Gemini API request failed with ${response.status}: ${await response.text()}`);
    }
    for await (const event of parseSse(response.body, options.signal)) {
      const parsed = JSON.parse(event) as GeminiGenerateResponse;
      const text = extractText(parsed);
      if (text) {
        yield { content: text, raw: parsed };
      }
    }
    yield { done: true };
  }
}

export async function listGeminiModelInfos(
  apiKey = process.env.GEMINI_API_KEY,
  baseUrl = process.env.GEMINI_API_BASE_URL ?? defaultBaseUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiModelInfo[]> {
  if (!apiKey?.trim()) {
    return [];
  }
  const normalizedBaseUrl = normalizeGeminiApiBaseUrl(baseUrl);
  const models: GeminiModelInfo[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetchImpl(withApiKey(`${normalizedBaseUrl}/models`, apiKey, pageToken ? { pageToken } : {}));
    if (!response.ok) {
      throw new Error(`Gemini model list failed with ${response.status}: ${await response.text()}`);
    }
    const body = await response.json() as GeminiModelsResponse;
    models.push(
      ...(body.models ?? [])
        .filter((model) => model.name && (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => ({
          name: model.name!.replace(/^models\//, ''),
          provider: 'gemini' as const,
          displayName: model.displayName,
          supportsReasoning: model.thinking === true || /(?:pro|3\.5|3\.1)/i.test(model.name ?? ''),
          supportsImage: /gemini/i.test(model.name ?? ''),
          supportsAudio: /gemini/i.test(model.name ?? ''),
          supportsPdf: /gemini/i.test(model.name ?? ''),
          contextTokens: model.inputTokenLimit,
          outputTokens: model.outputTokenLimit,
        })),
    );
    pageToken = body.nextPageToken;
  } while (pageToken);
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listGeminiModels(
  apiKey = process.env.GEMINI_API_KEY,
  baseUrl = process.env.GEMINI_API_BASE_URL ?? defaultBaseUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return (await listGeminiModelInfos(apiKey, baseUrl, fetchImpl)).map((model) => model.name);
}

async function buildRequestBody(
  messages: ChatMessage[],
  options: { temperature?: number; topP?: number; maxTokens?: number },
): Promise<Record<string, unknown>> {
  const systemTexts: string[] = [];
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentToText(message.content).trim();
      if (text) systemTexts.push(text);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: await messageParts(message),
    });
  }
  const generationConfig: Record<string, unknown> = {};
  if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature;
  if (typeof options.topP === 'number') generationConfig.topP = options.topP;
  if (typeof options.maxTokens === 'number') generationConfig.maxOutputTokens = options.maxTokens;
  return {
    contents,
    ...(systemTexts.length > 0 ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

async function messageParts(message: ChatMessage): Promise<unknown[]> {
  if (typeof message.content === 'string') {
    return [{ text: message.content }];
  }
  return await Promise.all(message.content.map(async (part) => {
    if (part.type === 'text') return { text: part.text };
    const resolved = part.type === 'image_url'
      ? await resolveImageAssetForRequest(part.url)
      : await resolveBinaryAssetForRequest(part.url);
    if (!resolved) return { text: `[${part.type}:${part.url}]` };
    return {
      inlineData: {
        mimeType: part.mediaType ?? resolved.mimeType,
        data: resolved.base64Data,
      },
    };
  }));
}

function extractText(response: GeminiGenerateResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .join('');
}

export function normalizeGeminiApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Gemini API base URL must not be empty.');
  }
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `${defaultGeminiProtocol(trimmed)}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error('Gemini API base URL must be a valid https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Gemini API base URL must use http or https.');
  }
  if (!url.hostname) {
    throw new Error('Gemini API base URL must include a host.');
  }
  if (url.username || url.password) {
    throw new Error('Gemini API base URL must not include credentials in the URL.');
  }
  if (url.search || url.hash) {
    throw new Error('Gemini API base URL must not include query strings or fragments.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const modelsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'models');
  if (modelsIndex >= 0) {
    url.pathname = `/${segments.slice(0, modelsIndex).join('/')}`;
  } else if (segments.length === 0 && url.hostname === 'generativelanguage.googleapis.com') {
    url.pathname = '/v1beta';
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function defaultGeminiProtocol(value: string): 'http' | 'https' {
  const host = (value.split(/[/?#]/, 1)[0] ?? '').replace(/^\[/, '').replace(/\]$/, '').split(':', 1)[0]?.toLowerCase() ?? '';
  if (
    host === 'localhost'
    || host === '::1'
    || host.endsWith('.local')
    || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
  ) {
    return 'http';
  }
  return 'https';
}

function modelNameForUrl(modelId: string): string {
  return modelId.startsWith('models/') ? modelId : `models/${modelId}`;
}

function withApiKey(url: string, apiKey: string | undefined, params: Record<string, string> = {}): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  if (apiKey?.trim()) {
    parsed.searchParams.set('key', apiKey.trim());
  }
  return parsed.toString();
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) throw new Error('Gemini stream cancelled.');
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) yield data;
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
}
