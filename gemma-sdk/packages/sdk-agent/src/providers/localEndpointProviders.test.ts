import { describe, expect, it } from 'vitest';
import { listLiteRtLmModelInfos, listLiteRtLmModels } from './liteRtLmProvider.js';
import { listLlamaCppModelInfos, listLlamaCppModels } from './llamaCppProvider.js';

describe('llama.cpp and LiteRT-LM provider model listing', () => {
  it('lists llama.cpp models through the OpenAI-compatible endpoint', async () => {
    const calls: string[] = [];
    const models = await listLlamaCppModels(
      'http://llama.local:8080',
      modelListFetch(calls, [{ id: 'z' }, { id: 'a' }]),
    );

    expect(calls).toEqual(['http://llama.local:8080/v1/models']);
    expect(models).toEqual(['a', 'z']);
  });

  it('returns llama.cpp display metadata for model picker rows', async () => {
    const models = await listLlamaCppModelInfos(
      'http://llama.local:8080/v1',
      modelListFetch([], [{ id: 'gemma.gguf' }]),
    );

    expect(models).toEqual([{
      name: 'gemma.gguf',
      provider: 'llamacpp',
      displayName: 'gemma.gguf',
      supportsImage: false,
      supportsAudio: false,
      supportsReasoning: true,
    }]);
  });

  it('lists LiteRT-LM models through the OpenAI-compatible endpoint', async () => {
    const calls: string[] = [];
    const models = await listLiteRtLmModels(
      'http://litert.local:9379',
      modelListFetch(calls, [{ id: 'gemma4-12b' }]),
    );

    expect(calls).toEqual(['http://litert.local:9379/v1/models']);
    expect(models).toEqual(['gemma4-12b']);
  });

  it('returns LiteRT-LM display metadata for model picker rows', async () => {
    const models = await listLiteRtLmModelInfos(
      'http://litert.local:9379/v1',
      modelListFetch([], [{ id: 'gemma4-12b' }]),
    );

    expect(models).toEqual([{
      name: 'gemma4-12b',
      provider: 'litertlm',
      displayName: 'gemma4-12b',
      supportsImage: false,
      supportsAudio: false,
      supportsReasoning: true,
    }]);
  });
});

function modelListFetch(calls: string[], data: Array<{ id: string }>): typeof fetch {
  return (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}
