import { describe, expect, it } from 'vitest';
import { normalizeOpenAICompatibleBaseUrl } from './openAiCompatibleProvider.js';
import { listLmStudioModelInfos, listLmStudioModels, LmStudioProvider } from './lmStudioProvider.js';

describe('LmStudioProvider', () => {
  it('posts OpenAI-compatible chat completions and returns content', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
      model: 'gemma-test',
      baseUrl: 'http://lmstudio.local',
      contextTokens: 4096,
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], { maxTokens: 128 })).resolves.toBe('ok');
    expect(calls[0]).toMatchObject({
      url: 'http://lmstudio.local/v1/chat/completions',
      body: {
        model: 'gemma-test',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 1,
        top_p: 0.95,
        max_tokens: 128
      }
    });
    expect(calls[0]?.body).not.toHaveProperty('input');
    expect(calls[0]?.body).not.toHaveProperty('context_length');
  });

  it('streams OpenAI-compatible thinking and message chunks', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
      model: 'google/gemma-4-26b-a4b',
      baseUrl: 'http://lmstudio.local',
      reasoning: true,
      fetchImpl: openAiChatFetch(calls, [chatCompletionStream([
        { delta: { reasoning_content: 'plan' } },
        { delta: { content: '{"answer":' } },
        { delta: { content: '"ok"}' } },
        { delta: {}, finish_reason: 'stop' }
      ])])
    });

    const activity: unknown[] = [];
    await expect(provider.generate([{ role: 'user', content: 'hello' }], {
      onActivity(chunk) {
        activity.push(chunk);
      }
    })).resolves.toBe('{"answer":"ok"}');

    expect(calls[0]?.body).toMatchObject({
      model: 'google/gemma-4-26b-a4b',
      stream: true,
      reasoning_effort: 'high'
    });
    expect(activity).toEqual([
      { thinking: 'plan', done: false },
      { content: '{"answer":', done: false },
      { content: '"ok"}', done: false },
      { done: true, doneReason: 'stop' }
    ]);
  });

  it('does not enable provider reasoning when reasoning mode is off', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
      model: 'google/gemma-4-26b-a4b',
      baseUrl: 'http://lmstudio.local',
      reasoning: true,
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], { reasoningMode: 'off' })).resolves.toBe('ok');
    expect(calls[0]?.body).toMatchObject({ reasoning_effort: 'none' });
  });

  it('does not send provider reasoning control when LM Studio discovery says it is unsupported', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
      model: 'google/gemma-4-31b',
      baseUrl: 'http://lmstudio.local',
      reasoning: false,
      fetchImpl: openAiChatFetch(calls, [chatCompletion('ok')])
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }], { reasoningMode: 'on' })).resolves.toBe('ok');
    expect(calls[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('reads LM Studio native capability metadata when listing models', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'google/gemma-4-31b' },
            { id: 'google/gemma-4-26b-a4b' }
          ]
        }), { status: 200 });
      }
      if (String(url).endsWith('/api/v0/models')) {
        return new Response(JSON.stringify({
          data: [
            {
              id: 'google/gemma-4-31b',
              display_name: 'Gemma 4 31B',
              capabilities: ['tool_use']
            },
            {
              id: 'google/gemma-4-26b-a4b',
              display_name: 'Gemma 4 26B A4B',
              capabilities: ['tool_use', 'reasoning']
            }
          ]
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const models = await listLmStudioModelInfos('http://lmstudio.local', fetchImpl);

    expect(urls).toEqual([
      'http://lmstudio.local/v1/models',
      'http://lmstudio.local/api/v0/models'
    ]);
    expect(models).toEqual([
      expect.objectContaining({
        name: 'google/gemma-4-26b-a4b',
        displayName: 'Gemma 4 26B A4B',
        supportsReasoning: true
      }),
      expect.objectContaining({
        name: 'google/gemma-4-31b',
        displayName: 'Gemma 4 31B',
        supportsReasoning: false
      })
    ]);
  });

  it('retries streams without provider reasoning when the server rejects reasoning control', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
      model: 'gemma-4-31b-it-mlx',
      baseUrl: 'http://lmstudio.local',
      reasoning: true,
      fetchImpl: openAiChatFetch(calls, [
        new Response(JSON.stringify({
          error: {
            message: "Model 'gemma-4-31b-it-mlx' does not expose reasoning configuration.",
            type: 'invalid_request_error',
            param: 'reasoning_effort',
            code: 'invalid_value'
          }
        }), { status: 400 }),
        chatCompletionStream([
          { delta: { content: 'alive' } },
          { delta: {}, finish_reason: 'stop' }
        ])
      ])
    });

    const chunks = [];
    for await (const chunk of provider.generateStream([{ role: 'user', content: 'hello' }], { reasoningMode: 'on' })) {
      chunks.push(chunk);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ reasoning_effort: 'high' });
    expect(calls[1]?.body).not.toHaveProperty('reasoning_effort');
    expect(chunks).toEqual([
      { status: 'LM Studio reasoning control unavailable; retrying without provider reasoning', done: false },
      { content: 'alive', done: false },
      { done: true, doneReason: 'stop' }
    ]);
  });

  it('throws with OpenAI-compatible response text on errors', async () => {
    const provider = new LmStudioProvider({
      fetchImpl: (async () => new Response(JSON.stringify({
        error: { message: 'model failed to load', type: 'server_error' }
      }), { status: 500 })) as typeof fetch
    });

    await expect(provider.generate([{ role: 'user', content: 'hello' }])).rejects.toThrow('model failed to load');
  });

  it('serializes image attachments as OpenAI-compatible content parts', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LmStudioProvider({
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

describe('listLmStudioModels', () => {
  it('returns sorted OpenAI-compatible model identifiers', async () => {
    const calls: string[] = [];
    const models = await listLmStudioModels(
      'http://lmstudio.local',
      (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({
          data: [
            { id: 'z' },
            { id: 'a' }
          ]
        }), { status: 200 });
      }) as typeof fetch
    );

    expect(calls).toEqual([
      'http://lmstudio.local/v1/models',
      'http://lmstudio.local/api/v0/models'
    ]);
    expect(models).toEqual(['a', 'z']);
  });

  it('normalizes common OpenAI-compatible endpoint paste shapes', async () => {
    expect(normalizeOpenAICompatibleBaseUrl('lmstudio.local:1234')).toBe('http://lmstudio.local:1234/v1');
    expect(normalizeOpenAICompatibleBaseUrl('http://lmstudio.local:1234/v1/chat/completions')).toBe('http://lmstudio.local:1234/v1');
    expect(normalizeOpenAICompatibleBaseUrl('https://proxy.local/lmstudio/v1/models')).toBe('https://proxy.local/lmstudio/v1');
    expect(normalizeOpenAICompatibleBaseUrl('http://ollama.local:11434/api/tags')).toBe('http://ollama.local:11434/v1');
    expect(() => normalizeOpenAICompatibleBaseUrl('ftp://lmstudio.local')).toThrow('must use http or https');
  });

  it('returns display metadata for model picker rows', async () => {
    const models = await listLmStudioModelInfos(
      'http://lmstudio.local/v1',
      (async (url) => {
        if (String(url).endsWith('/api/v0/models')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [
            { id: 'gemma' }
          ]
        }), { status: 200 });
      }) as typeof fetch
    );

    expect(models).toEqual([{
      name: 'gemma',
      provider: 'lmstudio',
      displayName: 'gemma'
    }]);
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
