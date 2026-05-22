import { describe, expect, it } from 'vitest';
import { GeminiProvider, listGeminiModelInfos } from './geminiProvider.js';

describe('GeminiProvider', () => {
  it('lists Gemini multimodal support from model metadata', async () => {
    const models = await listGeminiModelInfos(
      'test-key',
      'https://gemini.local/v1beta',
      (async (url) => {
        expect(String(url)).toContain('/models?key=test-key');
        return new Response(JSON.stringify({
          models: [
            {
              name: 'models/gemini-3.5-flash',
              displayName: 'Gemini 3.5 Flash',
              inputTokenLimit: 1_048_576,
              outputTokenLimit: 65_536,
              supportedGenerationMethods: ['generateContent'],
              thinking: true
            }
          ]
        }), { status: 200 });
      }) as typeof fetch
    );

    expect(models).toEqual([{
      name: 'gemini-3.5-flash',
      provider: 'gemini',
      displayName: 'Gemini 3.5 Flash',
      supportsReasoning: true,
      supportsImage: true,
      supportsAudio: true,
      supportsPdf: true,
      contextTokens: 1_048_576,
      outputTokens: 65_536
    }]);
  });

  it('serializes image attachments as Gemini inline data', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gemini.local/v1beta',
      model: 'gemini-3.5-flash',
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>
        });
        return sseResponse([
          { candidates: [{ content: { parts: [{ text: 'visible' }] } }] }
        ]);
      }) as typeof fetch
    });

    await expect(provider.generate([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }
      ]
    }])).resolves.toBe('visible');

    expect(calls[0]?.url).toContain('/models/gemini-3.5-flash:streamGenerateContent');
    expect(calls[0]?.body).toMatchObject({
      contents: [{
        role: 'user',
        parts: [
          { text: 'describe this' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'aGVsbG8='
            }
          }
        ]
      }]
    });
  });
});

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}
