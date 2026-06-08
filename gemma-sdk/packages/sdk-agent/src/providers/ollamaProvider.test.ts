import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../types.js';
import { defaultOllamaGenerationStartTimeoutMs, defaultOllamaStreamInactivityTimeoutMs, ensureOllamaRunning, getOllamaModelCapabilities, listOllamaModelInfos, listOllamaModels, normalizeOllamaBaseUrl, OllamaProvider, prepareOllama } from './ollamaProvider.js';
import { defaultLocalOpenAICompatibleHeadersTimeoutMs } from './openAiCompatibleProvider.js';

describe('OllamaProvider', () => {
  it('uses a long default stream inactivity timeout for local reasoning pauses', () => {
    expect(defaultOllamaStreamInactivityTimeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  it('uses a long default generation-start timeout for slow local first tokens', () => {
    expect(defaultOllamaGenerationStartTimeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(defaultLocalOpenAICompatibleHeadersTimeoutMs).toBeGreaterThanOrEqual(defaultOllamaGenerationStartTimeoutMs);
  });

  it('posts OpenAI-compatible chat completions and returns content', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      model: 'gemma4:26b',
      baseUrl: 'http://ollama.local',
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }])).resolves.toBe('ok');
    expect(calls[0]?.url).toBe('http://ollama.local/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({
      model: 'gemma4:26b',
      temperature: 1,
      top_p: 0.95,
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(calls[0]?.body).not.toHaveProperty('think');
    expect(calls[0]?.body).not.toHaveProperty('keep_alive');
    expect(calls[0]?.body).not.toHaveProperty('options');
  });

  it('uses standard reasoning_effort none when thinking is disabled', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      model: 'gemma4:26b',
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], { reasoningMode: 'off' })).resolves.toBe('ok');
    expect(calls[0]?.body).toMatchObject({ reasoning_effort: 'none' });
  });

  it('disables provider reasoning by default for non-Gemma Ollama models', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      model: 'qwen3.6:35b-a3b-coding-bf16',
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }])).resolves.toBe('ok');
    expect(calls[0]?.body).toMatchObject({ reasoning_effort: 'none' });
  });

  it('retries once with a corrective prompt when OpenAI-compatible content is empty', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch(calls, [chatCompletion(''), chatCompletion('{"answer":"recovered"}')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }])).resolves.toBe('{"answer":"recovered"}');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({
      reasoning_effort: 'none',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: expect.stringContaining('previous model response was empty') }
      ]
    });
  });

  it('retries thinking-only streams with a corrective prompt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const activity: StreamChunk[] = [];
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch(calls, [
        chatCompletionStream([
          { delta: { reasoning_content: 'plan' } },
          { delta: {}, finish_reason: 'stop' }
        ]),
        chatCompletionStream([
          { delta: { content: '{"answer":"recovered"}' } },
          { delta: {}, finish_reason: 'stop' }
        ])
      ])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onActivity: async (chunk) => {
        activity.push(chunk);
      }
    })).resolves.toBe('{"answer":"recovered"}');

    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ reasoning_effort: 'none' });
    expect(activity).toContainEqual({ thinking: 'plan', done: false });
    expect(activity).toContainEqual({ done: true, doneReason: 'stop' });
  });

  it('fails output-token-limit streams instead of retrying them as ordinary empty responses', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch(calls, [chatCompletionStream([
        { delta: { reasoning_content: 'long plan' } },
        { delta: {}, finish_reason: 'length' }
      ])])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onActivity: async () => undefined
    })).rejects.toThrow(/output token limit/);
    expect(calls).toHaveLength(1);
  });

  it('streams thinking and content chunks from OpenAI-compatible SSE', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch(calls, [chatCompletionStream([
        { delta: { reasoning_content: 'plan' } },
        { delta: { content: 'hi' } },
        { delta: {}, finish_reason: 'stop' }
      ])])
    });
    const chunks: StreamChunk[] = [];

    for await (const chunk of provider.generateStream([{ role: 'user', content: 'hello' }])) {
      chunks.push(chunk);
    }

    expect(calls[0]?.body).toMatchObject({ stream: true, reasoning_effort: 'high' });
    expect(chunks).toEqual([
      { thinking: 'plan', done: false },
      { content: 'hi', done: false },
      { done: true, doneReason: 'stop' }
    ]);
  });

  it('cancels OpenAI-compatible streams when activity handling aborts early', async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveAborted!: (aborted: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    const provider = new OllamaProvider({
      fetchImpl: (async (_url, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        requestSignal?.addEventListener('abort', () => resolveAborted(true), { once: true });
        return hangingChatCompletionStream({ delta: { content: '<thought' } });
      }) as typeof fetch
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onActivity: async (chunk) => {
        if (chunk.content) {
          throw new Error('protocol retry');
        }
      }
    })).rejects.toThrow('protocol retry');

    const abortedBeforeTimeout = await Promise.race([
      aborted,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    expect(abortedBeforeTimeout).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('fails whitespace-only output streams as no-progress failures', async () => {
    const whitespaceChunks = Array.from({ length: 80 }, () => ({ delta: { content: '\n'.repeat(64) } }));
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch([], [chatCompletionStream(whitespaceChunks)])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onActivity: async () => undefined
    })).rejects.toThrow(/no semantic progress/);
  });

  it('converts OpenAI-compatible native tool_calls into Gemma CLI JSON tool calls', async () => {
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch([], [chatCompletionStream([
        {
          delta: {
            tool_calls: [{
              id: 'call_test',
              index: 0,
              type: 'function',
              function: { name: 'list_dir', arguments: '{"path":' }
            }]
          }
        },
        {
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '"."}' }
            }]
          }
        },
        { delta: {}, finish_reason: 'tool_calls' }
      ])])
    });
    const chunks: StreamChunk[] = [];

    await expect(provider.generate([{ role: 'user', content: 'list files' }], {
      onActivity: async (chunk) => {
        chunks.push(chunk);
      }
    })).resolves.toBe('{"tool":"list_dir","args":{"path":"."}}');
    expect(chunks).toContainEqual({
      content: '{"tool":"list_dir","args":{"path":"."}}',
      done: false
    });
  });

  it('serializes image attachments as OpenAI-compatible content parts', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', url: 'data:image/png;base64,aGVsbG8=' }
      ]
    }])).resolves.toBe('ok');

    expect(calls[0]?.body).toMatchObject({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
        ]
      }]
    });
  });
});

describe('listOllamaModels', () => {
  it('returns sorted model names from OpenAI-compatible models', async () => {
    const calls: string[] = [];
    const models = await listOllamaModels(
      'http://ollama.local',
      (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'gemma-cli/z:ctx8192' }, { id: 'a' }] }), { status: 200 });
      }) as typeof fetch
    );

    expect(calls).toEqual(['http://ollama.local/v1/models']);
    expect(models).toEqual(['a', 'z']);
  });

  it('returns OpenAI-compatible model metadata for picker rows', async () => {
    const models = await listOllamaModelInfos(
      'http://ollama.local/v1',
      (async () =>
        new Response(JSON.stringify({
          data: [
            { id: 'gemma-cli/gemma4-26b-test:ctx8192', created: 1_777_593_500, owned_by: 'local' },
            { id: 'gemma4:26b', created: 1_777_593_600, owned_by: 'library' }
          ]
        }), {
          status: 200
        })) as typeof fetch
    );

    expect(models).toEqual([
      {
        name: 'gemma4:26b',
        provider: 'ollama',
        modifiedAt: '2026-05-01T00:00:00.000Z'
      }
    ]);
  });

  it('reads native Ollama show metadata for capabilities and loaded context', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const capabilities = await getOllamaModelCapabilities(
      'gemma4:26b',
      'http://ollama.local/v1',
      (async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({
          capabilities: ['completion', 'vision', 'tools', 'thinking'],
          model_info: {
            'gemma.context_length': 262144
          }
        }), { status: 200 });
      }) as typeof fetch
    );

    expect(calls).toEqual([{ url: 'http://ollama.local/api/show', body: { model: 'gemma4:26b' } }]);
    expect(capabilities).toEqual({
      supportsImage: true,
      supportsAudio: false,
      supportsReasoning: true,
      contextTokens: 262144
    });
  });

  it('normalizes common Ollama endpoint paste shapes back to the server root', () => {
    expect(normalizeOllamaBaseUrl('100.104.166.87:11434')).toBe('http://100.104.166.87:11434');
    expect(normalizeOllamaBaseUrl('http://ollama.local:11434/v1')).toBe('http://ollama.local:11434');
    expect(normalizeOllamaBaseUrl('http://ollama.local:11434/v1/chat/completions')).toBe('http://ollama.local:11434');
    expect(normalizeOllamaBaseUrl('https://proxy.local/ollama/v1/models')).toBe('https://proxy.local/ollama');
    expect(normalizeOllamaBaseUrl('http://ollama.local:11434/api/tags')).toBe('http://ollama.local:11434');
    expect(() => normalizeOllamaBaseUrl('file:///tmp/ollama')).toThrow('must use http or https');
  });
});

describe('prepareOllama', () => {
  it('can verify Ollama availability through OpenAI-compatible model discovery', async () => {
    const calls: string[] = [];
    await ensureOllamaRunning({
      baseUrl: 'http://ollama.local',
      autoStart: false,
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch
    });

    expect(calls).toEqual(['http://ollama.local/v1/models']);
  });

  it('verifies the target model without native unload or warm-load calls', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    await prepareOllama({
      model: 'gemma4:26b',
      baseUrl: 'http://ollama.local',
      autoStart: false,
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ data: [{ id: 'gemma4:26b' }] }), { status: 200 });
      }) as typeof fetch
    });

    expect(calls).toEqual([{ url: 'http://ollama.local/v1/models', body: undefined }]);
  });

  it('fails clearly when the target model is not installed', async () => {
    await expect(prepareOllama({
      model: 'gemma4:26b',
      baseUrl: 'http://ollama.local',
      autoStart: false,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'gemma4:e2b' }] }), {
          status: 200
        })) as typeof fetch
    })).rejects.toThrow('ollama pull gemma4:26b');
  });
});

function openAiChatFetch(
  calls: Array<{ url: string; body: Record<string, unknown> }>,
  responses: Response[]
): typeof fetch {
  return (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return responses.shift() ?? chatCompletion('ok');
  }) as typeof fetch;
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }), { status: 200 });
}

function chatCompletionStream(chunks: Array<{ delta: Record<string, unknown>; finish_reason?: string | null }>): Response {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finish_reason ?? null }]
  })}`);
  return new Response(`${lines.join('\n\n')}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function hangingChatCompletionStream(
  chunk: { delta: Record<string, unknown>; finish_reason?: string | null }
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finish_reason ?? null }]
      })}\n\n`));
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}
