import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, type JSONValue, type LanguageModelUsage, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai';
import { contentToText, resolveBinaryAssetForRequest, resolveImageAssetForRequest } from '../content.js';
import { shouldEnableProviderReasoning } from '../modelProfiles.js';
import type { ChatMessage, ContentPart, GenerateOptions, ModelProvider, StreamChunk, TokenUsage } from '../types.js';

export interface OpenAICompatibleLocalProviderOptions {
  providerName: string;
  displayName: string;
  baseUrl: string;
  model: string;
  contextTokens?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  supportsReasoning?: boolean;
  autoDisablesProviderReasoning?: boolean;
  generationStartTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  emptyResponseLabel?: string;
}

export interface OpenAICompatibleModelInfo {
  id: string;
  created?: number;
  ownedBy?: string;
}

interface OpenAICompatibleModelsResponse {
  data?: Array<{
    id?: string;
    created?: number;
    owned_by?: string;
  }>;
}

const defaultGenerationStartTimeoutMs = 15 * 60_000;
const defaultStreamInactivityTimeoutMs = 15 * 60_000;
const whitespaceOnlyContentStallLimitChars = 4096;
const streamCancelTimeoutMs = 250;

type LocalProviderOptions = Record<string, Record<string, JSONValue | undefined>>;
type UserModelContent = Extract<ModelMessage, { role: 'user' }>['content'];
type UserModelPart = Exclude<UserModelContent, string>[number];
type LocalToolSet = ToolSet;
type LocalTextStreamPart = TextStreamPart<LocalToolSet>;

export class OpenAICompatibleLocalProvider implements ModelProvider {
  readonly name: string;
  private readonly displayName: string;
  private readonly providerName: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature?: number;
  private readonly topP?: number;
  private readonly maxTokens?: number;
  private readonly supportsReasoning: boolean;
  private readonly autoDisablesProviderReasoning: boolean;
  private readonly generationStartTimeoutMs: number;
  private readonly streamInactivityTimeoutMs: number;
  private readonly emptyResponseLabel: string;
  private readonly languageModel: ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;

  constructor(options: OpenAICompatibleLocalProviderOptions) {
    this.name = options.providerName;
    this.providerName = options.providerName;
    this.displayName = options.displayName;
    this.baseUrl = normalizeOpenAICompatibleBaseUrl(options.baseUrl);
    this.model = options.model;
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.maxTokens = options.maxTokens;
    this.supportsReasoning = options.supportsReasoning ?? true;
    this.autoDisablesProviderReasoning = options.autoDisablesProviderReasoning ?? false;
    this.generationStartTimeoutMs = options.generationStartTimeoutMs ?? defaultGenerationStartTimeoutMs;
    this.streamInactivityTimeoutMs = options.streamInactivityTimeoutMs ?? defaultStreamInactivityTimeoutMs;
    this.emptyResponseLabel = options.emptyResponseLabel ?? `${options.displayName} OpenAI-compatible response`;

    const provider = createOpenAICompatible({
      name: options.providerName,
      baseURL: this.baseUrl,
      fetch: options.fetchImpl,
      includeUsage: true,
      supportedUrls: () => ({
        'image/*': [/^data:/, /^https?:/]
      })
    });
    this.languageModel = provider.chatModel(options.model);
  }

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    if (options.onActivity) {
      const result = await this.generateWithActivity(messages, options);
      if (isOutputLimitDoneReason(result.doneReason)) {
        throw outputLimitError(this.emptyResponseLabel, result.doneReason);
      }
      if (result.text) {
        return result.text;
      }

      const retryResult = await this.generateWithActivity([
        ...messages,
        {
          role: 'user',
          content: 'The previous model response was empty. Thinking is disabled for this retry. Continue now and return exactly one JSON object: either {"answer":"..."} or {"tool":"tool_name","args":{...}}.'
        }
      ], emptyResponseRetryOptions(options));
      if (isOutputLimitDoneReason(retryResult.doneReason)) {
        throw outputLimitError(this.emptyResponseLabel, retryResult.doneReason);
      }
      if (!retryResult.text) {
        throw new Error(`${this.emptyResponseLabel} did not include text content${doneReasonLabel(retryResult.doneReason ?? result.doneReason)}.`);
      }
      return retryResult.text;
    }

    const result = await this.generateTextOnce(messages, options);
    if (isOutputLimitDoneReason(result.doneReason)) {
      throw outputLimitError(this.emptyResponseLabel, result.doneReason);
    }
    if (result.text) {
      return result.text;
    }

    const retryResult = await this.generateTextOnce([
      ...messages,
      {
        role: 'user',
        content: 'The previous model response was empty. Thinking is disabled for this retry. Continue now and return exactly one JSON object: either {"answer":"..."} or {"tool":"tool_name","args":{...}}.'
      }
    ], emptyResponseRetryOptions(options));
    if (isOutputLimitDoneReason(retryResult.doneReason)) {
      throw outputLimitError(this.emptyResponseLabel, retryResult.doneReason);
    }
    if (!retryResult.text) {
      throw new Error(`${this.emptyResponseLabel} did not include text content${doneReasonLabel(retryResult.doneReason ?? result.doneReason)}.`);
    }
    return retryResult.text;
  }

  async *generateStream(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    const controlsReasoning = this.controlsProviderReasoning(options, false);
    try {
      yield* this.generateStreamOnce(messages, options, false);
    } catch (error) {
      if (!controlsReasoning || !shouldRetryWithoutProviderReasoning(error)) {
        throw this.decorateProviderError(error);
      }
      yield {
        status: `${this.displayName} reasoning control unavailable; retrying without provider reasoning`,
        done: false
      };
      try {
        yield* this.generateStreamOnce(messages, options, true);
      } catch (retryError) {
        throw this.decorateProviderError(retryError);
      }
    }
  }

  private async generateTextOnce(messages: ChatMessage[], options: GenerateOptions): Promise<{ text: string; doneReason?: string }> {
    const controlsReasoning = this.controlsProviderReasoning(options, false);
    try {
      const result = await generateText({
        model: this.languageModel,
        messages: await toModelMessages(messages),
        allowSystemInMessages: true,
        maxRetries: 0,
        abortSignal: options.signal,
        temperature: options.temperature ?? this.temperature,
        topP: options.topP ?? this.topP,
        maxOutputTokens: options.maxTokens ?? this.maxTokens,
        providerOptions: this.providerOptions(options, false)
      });
      return { text: result.text, doneReason: result.rawFinishReason ?? result.finishReason };
    } catch (error) {
      if (!controlsReasoning || !shouldRetryWithoutProviderReasoning(error)) {
        throw this.decorateProviderError(error);
      }
      const result = await generateText({
        model: this.languageModel,
        messages: await toModelMessages(messages),
        allowSystemInMessages: true,
        maxRetries: 0,
        abortSignal: options.signal,
        temperature: options.temperature ?? this.temperature,
        topP: options.topP ?? this.topP,
        maxOutputTokens: options.maxTokens ?? this.maxTokens,
        providerOptions: this.providerOptions(options, true)
      });
      return { text: result.text, doneReason: result.rawFinishReason ?? result.finishReason };
    }
  }

  private async generateWithActivity(messages: ChatMessage[], options: GenerateOptions): Promise<{ text: string; doneReason?: string }> {
    let text = '';
    let doneReason: string | undefined;
    for await (const chunk of this.generateStream(messages, options)) {
      if (chunk.content) {
        text += chunk.content;
      }
      if (chunk.doneReason) {
        doneReason = chunk.doneReason;
      }
      await options.onActivity?.(chunk);
    }
    return { text, doneReason };
  }

  private async *generateStreamOnce(messages: ChatMessage[], options: GenerateOptions, disableProviderReasoning: boolean): AsyncIterable<StreamChunk> {
    const streamAbortController = new AbortController();
    const upstreamSignal = options.signal;
    const abortFromUpstream = () => streamAbortController.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      streamAbortController.abort(upstreamSignal.reason);
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }
    const result = streamText({
      model: this.languageModel,
      messages: await toModelMessages(messages),
      allowSystemInMessages: true,
      maxRetries: 0,
      abortSignal: streamAbortController.signal,
      timeout: {
        stepMs: this.generationStartTimeoutMs,
        chunkMs: this.streamInactivityTimeoutMs
      },
      temperature: options.temperature ?? this.temperature,
      topP: options.topP ?? this.topP,
      maxOutputTokens: options.maxTokens ?? this.maxTokens,
      providerOptions: this.providerOptions(options, disableProviderReasoning),
      includeRawChunks: true,
      onError: () => undefined
    });

    let emittedDone = false;
    let whitespaceOnlyContentChars = 0;
    const nativeToolCalls = new OpenAICompatibleToolCallAccumulator();
    let cancelAfterDone = false;
    const stream = result.fullStream;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const part = next.value;
        if (part.type === 'raw') {
          nativeToolCalls.observe(part.rawValue);
        }
        if (isOpenAICompatibleToolCallFinish(part)) {
          const toolCallText = nativeToolCalls.toProtocolText();
          if (toolCallText) {
            yield withRaw({
              content: toolCallText,
              done: false
            }, {
              type: 'openai-compatible-tool-call',
              toolCall: toolCallText
            }, options);
          }
        }
        const chunk = this.chunkFromStreamPart(part, options);
        if (!chunk) {
          continue;
        }
        if (chunk.done) {
          emittedDone = true;
        }
        whitespaceOnlyContentChars = nextWhitespaceOnlyContentChars(whitespaceOnlyContentChars, chunk);
        if (whitespaceOnlyContentChars > whitespaceOnlyContentStallLimitChars) {
          throw new Error(`${this.displayName} OpenAI-compatible stream made no semantic progress after ${whitespaceOnlyContentChars} whitespace-only content characters.`);
        }
        yield chunk;
        if (chunk.done === true) {
          cancelAfterDone = true;
          break;
        }
      }
    } finally {
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      if ((cancelAfterDone || !emittedDone) && !streamAbortController.signal.aborted) {
        streamAbortController.abort();
      }
      if (cancelAfterDone || !emittedDone) {
        await cancelStreamIterator(iterator, stream);
      }
    }
    if (!emittedDone) {
      yield { done: true };
    }
  }

  private chunkFromStreamPart(part: LocalTextStreamPart, options: GenerateOptions): StreamChunk | undefined {
    switch (part.type) {
      case 'text-start':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-end':
      case 'tool-input-start':
      case 'tool-input-end':
      case 'tool-input-delta':
      case 'source':
      case 'file':
      case 'tool-call':
      case 'tool-result':
      case 'tool-error':
      case 'tool-output-denied':
      case 'tool-approval-request':
      case 'start-step':
      case 'finish-step':
      case 'start':
        return undefined;
      case 'text-delta':
        return withRaw({ content: streamPartText(part), done: false }, part, options);
      case 'reasoning-delta':
        return withRaw({ thinking: streamPartText(part), done: false }, part, options);
      case 'finish': {
        const usage = normalizeLanguageModelUsage(part.totalUsage);
        return withRaw({
          done: true,
          doneReason: part.rawFinishReason ?? part.finishReason,
          ...(usage ? { usage } : {})
        }, part, options);
      }
      case 'abort':
        throw new Error(`${this.displayName} OpenAI-compatible stream was aborted${part.reason ? `: ${part.reason}` : ''}.`);
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      case 'raw':
        return options.includeRawChunks ? { raw: { provider: this.providerName, data: part.rawValue }, done: false } : undefined;
    }
  }

  private providerOptions(options: GenerateOptions, disableProviderReasoning: boolean): LocalProviderOptions | undefined {
    const reasoningEffort = this.reasoningEffort(options, disableProviderReasoning);
    if (!reasoningEffort) {
      return undefined;
    }
    return {
      openaiCompatible: { reasoningEffort },
      [this.providerName]: { reasoningEffort }
    };
  }

  private reasoningEffort(options: GenerateOptions, disableProviderReasoning: boolean): string | undefined {
    if (disableProviderReasoning) {
      return undefined;
    }
    if (options.reasoningMode === 'off') {
      return 'none';
    }
    if (shouldEnableProviderReasoning(this.model, options, this.supportsReasoning)) {
      return 'high';
    }
    return this.autoDisablesProviderReasoning ? 'none' : undefined;
  }

  private controlsProviderReasoning(options: GenerateOptions, disableProviderReasoning: boolean): boolean {
    return this.reasoningEffort(options, disableProviderReasoning) !== undefined;
  }

  private decorateProviderError(error: unknown): Error {
    const original = error instanceof Error ? error : new Error(String(error));
    const enriched = enrichProviderHttpError(original, this.displayName);
    if (this.providerName !== 'ollama' || !looksLikeTimeoutError(enriched)) {
      return enriched;
    }
    return new Error([
      enriched.message,
      '',
      `Gemma CLI is using Ollama through the OpenAI-compatible endpoint at ${this.baseUrl}.`,
      'If the local runner is wedged, reset it outside Gemma CLI and retry:',
      ollamaResetInstructions(this.model, this.baseUrl)
    ].join('\n'));
  }
}

function enrichProviderHttpError(error: Error, displayName: string): Error {
  const details = providerHttpErrorDetails(error, displayName);
  if (!details) {
    return error;
  }
  const enriched = new Error([error.message, '', details].join('\n'));
  enriched.name = error.name;
  return enriched;
}

function providerHttpErrorDetails(error: Error, displayName: string): string | undefined {
  const record = error as unknown as Record<string, unknown>;
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const url = typeof record.url === 'string' ? record.url : undefined;
  const responseBody = typeof record.responseBody === 'string' && record.responseBody.trim().length > 0
    ? truncateDiagnosticText(record.responseBody.trim())
    : undefined;
  if (statusCode === undefined && !responseBody) {
    return undefined;
  }
  const lines = [];
  if (statusCode !== undefined) {
    lines.push(`${displayName} OpenAI-compatible request failed with HTTP ${statusCode}${url ? ` at ${url}` : ''}.`);
  } else {
    lines.push(`${displayName} OpenAI-compatible request failed.`);
  }
  if (responseBody) {
    lines.push(`Response body: ${responseBody}`);
  }
  return lines.join('\n');
}

function truncateDiagnosticText(value: string): string {
  const maxLength = 2000;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export async function listOpenAICompatibleModels(baseUrl: string, fetchImpl: typeof fetch, label: string): Promise<OpenAICompatibleModelInfo[]> {
  const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const response = await fetchImpl(`${normalizedBaseUrl}/models`);
  if (!response.ok) {
    throw new Error(`${label} model list failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as OpenAICompatibleModelsResponse;
  return (body.data ?? [])
    .flatMap((model) => typeof model.id === 'string' && model.id.trim().length > 0
      ? [{
          id: model.id.trim(),
          created: typeof model.created === 'number' ? model.created : undefined,
          ownedBy: typeof model.owned_by === 'string' ? model.owned_by : undefined
        }]
      : [])
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  const url = parseProviderEndpointUrl(baseUrl, 'OpenAI-compatible endpoint');
  const segments = pathSegments(url);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const v1Index = lowerSegments.lastIndexOf('v1');
  if (v1Index >= 0) {
    url.pathname = `/${segments.slice(0, v1Index + 1).join('/')}`;
    return serializeProviderEndpointUrl(url);
  }

  const nativeApiIndex = nativeOllamaApiIndex(lowerSegments);
  if (nativeApiIndex >= 0) {
    url.pathname = providerPath([...segments.slice(0, nativeApiIndex), 'v1']);
    return serializeProviderEndpointUrl(url);
  }

  url.pathname = providerPath([...segments, 'v1']);
  return serializeProviderEndpointUrl(url);
}

export function parseProviderEndpointUrl(value: string, label = 'Provider endpoint'): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL or host:port value.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https.`);
  }
  if (!url.hostname) {
    throw new Error(`${label} must include a host.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials in the URL.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not include query strings or fragments.`);
  }
  return url;
}

export function pathSegments(url: URL): string[] {
  return url.pathname.split('/').map((segment) => segment.trim()).filter(Boolean);
}

export function serializeProviderEndpointUrl(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

function providerPath(segments: string[]): string {
  return `/${segments.filter(Boolean).join('/')}`;
}

function nativeOllamaApiIndex(lowerSegments: string[]): number {
  return lowerSegments.findIndex((segment, index) =>
    segment === 'api'
    && ['chat', 'copy', 'delete', 'embeddings', 'generate', 'pull', 'ps', 'show', 'tags'].includes(lowerSegments[index + 1] ?? '')
  );
}

async function toModelMessages(messages: ChatMessage[]): Promise<ModelMessage[]> {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      converted.push({ role: 'system', content: contentToText(message.content) });
    } else if (message.role === 'assistant') {
      converted.push({ role: 'assistant', content: contentToText(message.content) });
    } else if (message.role === 'tool') {
      converted.push({ role: 'user', content: `Tool result:\n${contentToText(message.content)}` });
    } else {
      converted.push({ role: 'user', content: await toUserContent(message.content) });
    }
  }
  return converted;
}

async function toUserContent(content: ChatMessage['content']): Promise<UserModelContent> {
  if (typeof content === 'string') {
    return content;
  }

  const parts: UserModelPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    const converted = await convertAttachmentPart(part);
    parts.push(converted);
  }
  return parts.length > 0 ? parts : '';
}

async function convertAttachmentPart(part: Exclude<ContentPart, { type: 'text' }>): Promise<UserModelPart> {
  if (part.type === 'image_url') {
    const resolved = await resolveImageAssetForRequest(part.url);
    if (resolved) {
      return { type: 'image', image: resolved.dataUrl, mediaType: resolved.mimeType };
    }
    if (isHttpUrl(part.url)) {
      return { type: 'image', image: new URL(part.url), mediaType: part.mediaType };
    }
    return { type: 'text', text: `[image:${part.url}]` };
  }

  if (part.type === 'audio_url' || part.type === 'pdf_url') {
    const resolved = await resolveBinaryAssetForRequest(part.url);
    if (resolved) {
      return {
        type: 'file',
        data: resolved.dataUrl,
        mediaType: resolved.mimeType
      };
    }
    return { type: 'text', text: `[${part.type.replace(/_url$/, '')}:${part.url}]` };
  }

  return { type: 'text', text: `[${part.type.replace(/_url$/, '')}:${part.url}]` };
}

function streamPartText(part: LocalTextStreamPart): string {
  const value = (part as unknown as { text?: unknown; delta?: unknown }).text
    ?? (part as unknown as { text?: unknown; delta?: unknown }).delta;
  return typeof value === 'string' ? value : '';
}

function normalizeLanguageModelUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const normalized = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
    totalTokens: usage.totalTokens
  } satisfies TokenUsage;
  return Object.values(normalized).some((value) => typeof value === 'number')
    ? normalized
    : undefined;
}

function withRaw(chunk: StreamChunk, raw: unknown, options: GenerateOptions): StreamChunk {
  return options.includeRawChunks ? { ...chunk, raw } : chunk;
}

function nextWhitespaceOnlyContentChars(current: number, chunk: StreamChunk): number {
  if (!chunk.content) {
    return current;
  }
  return /\S/.test(chunk.content) ? 0 : current + chunk.content.length;
}

interface OpenAICompatibleRawToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

class OpenAICompatibleToolCallAccumulator {
  private readonly calls = new Map<number, { id?: string; name?: string; argumentsText: string }>();

  observe(rawValue: unknown): void {
    const choices = rawValue && typeof rawValue === 'object'
      ? (rawValue as { choices?: unknown }).choices
      : undefined;
    if (!Array.isArray(choices)) {
      return;
    }

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }
      const delta = (choice as { delta?: unknown }).delta;
      if (!delta || typeof delta !== 'object') {
        continue;
      }
      const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
      if (!Array.isArray(toolCalls)) {
        continue;
      }
      for (const toolCall of toolCalls) {
        this.observeToolCallDelta(toolCall as OpenAICompatibleRawToolCall);
      }
    }
  }

  toProtocolText(): string | undefined {
    const toolCall = [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .find((value) => typeof value.name === 'string' && value.name.trim().length > 0);
    if (!toolCall?.name) {
      return undefined;
    }
    const args = parseToolCallArguments(toolCall.argumentsText);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return undefined;
    }
    return JSON.stringify({ tool: toolCall.name, args });
  }

  private observeToolCallDelta(delta: OpenAICompatibleRawToolCall): void {
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const existing = this.calls.get(index) ?? { argumentsText: '' };
    if (typeof delta.id === 'string' && delta.id.length > 0) {
      existing.id = delta.id;
    }
    if (typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
      existing.name = delta.function.name;
    }
    if (typeof delta.function?.arguments === 'string') {
      existing.argumentsText += delta.function.arguments;
    }
    this.calls.set(index, existing);
  }
}

function parseToolCallArguments(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isOpenAICompatibleToolCallFinish(part: LocalTextStreamPart): boolean {
  if (part.type !== 'finish') {
    return false;
  }
  const finishReason = String(part.rawFinishReason ?? part.finishReason ?? '');
  return /tool[-_]?calls?/i.test(finishReason);
}

function emptyResponseRetryOptions(options: GenerateOptions): GenerateOptions {
  return { ...options, reasoningMode: 'off' };
}

function doneReasonLabel(doneReason: string | undefined): string {
  return doneReason ? ` (done_reason=${doneReason})` : '';
}

function isOutputLimitDoneReason(doneReason: string | undefined): boolean {
  return typeof doneReason === 'string' && /^(?:length|max[_ -]?tokens?|output[_ -]?tokens?|token[_ -]?limit)$/i.test(doneReason.trim());
}

function outputLimitError(label: string, doneReason: string | undefined): Error {
  return new Error(`${label} reached the output token limit before a complete text response was received${doneReasonLabel(doneReason)}.`);
}

async function cancelStreamIterator(
  iterator: AsyncIterator<LocalTextStreamPart>,
  stream: ReadableStream<unknown>
): Promise<void> {
  try {
    const cleanups: Array<Promise<unknown>> = [];
    const returned = iterator.return?.();
    if (returned) {
      cleanups.push(Promise.resolve(returned).catch(() => undefined));
    }
    try {
      cleanups.push(stream.cancel().catch(() => undefined));
    } catch {
      // The stream may already be locked by the async iterator.
    }
    await Promise.race([
      Promise.all(cleanups),
      delay(streamCancelTimeoutMs)
    ]);
  } catch {
    // Some local OpenAI-compatible streams do not settle cleanly after finish.
    // This cleanup is best-effort; the request signal has already been aborted.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const unref = typeof timer === 'object' ? (timer as { unref?: () => void }).unref : undefined;
    if (typeof unref === 'function') {
      unref.call(timer);
    }
  });
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function shouldRetryWithoutProviderReasoning(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning|reasoning_effort|reasoning effort/i.test(message)
    && /invalid|unsupported|not supported|unavailable|does not expose|unknown|unrecognized/i.test(message);
}

function looksLikeTimeoutError(error: Error): boolean {
  return /timeout|timed out|aborted|no semantic progress|whitespace-only content/i.test(error.message) || error.name === 'TimeoutError';
}

function ollamaResetInstructions(model: string, baseUrl: string): string {
  return [
    `ollama stop ${shellQuote(model)}`,
    process.platform === 'win32'
      ? 'If Ollama remains stuck, restart the Ollama app or service from Task Manager.'
      : 'If Ollama remains stuck in "Stopping...", approve and run: pkill -f "ollama runner"',
    `Ollama endpoint: ${baseUrl}`
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
