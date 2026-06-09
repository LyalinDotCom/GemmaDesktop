import { describe, expect, it } from 'vitest';
import { GeminiProvider, listGeminiModelInfos, normalizeGeminiApiBaseUrl } from './geminiProvider.js';

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

  it('passes topK into the Gemini generationConfig', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gemini.local/v1beta',
      model: 'gemini-3.5-flash',
      topK: 64,
      fetchImpl: (async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]);
      }) as typeof fetch
    });

    await expect(provider.generate([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
    expect(calls[0]?.body).toMatchObject({ generationConfig: { topK: 64 } });
  });

  it('parses SSE events even when separators use mixed line endings', async () => {
    // "\r\n\n" is a valid 3-char separator. The boundary skip must consume
    // exactly the matched length, not eat the first char of the next event.
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gemini.local/v1beta',
      model: 'gemini-3.5-flash',
      fetchImpl: (async () => {
        const encoder = new TextEncoder();
        const payloads = [
          { candidates: [{ content: { parts: [{ text: 'first ' }] } }] },
          { candidates: [{ content: { parts: [{ text: 'second' }] } }] }
        ];
        const body = `data: ${JSON.stringify(payloads[0])}\r\n\ndata: ${JSON.stringify(payloads[1])}\r\n\n`;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
          }
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch
    });

    await expect(provider.generate([{ role: 'user', content: 'hi' }])).resolves.toBe('first second');
  });

  it('normalizes Gemini API base URLs from host and copied endpoint shapes', () => {
    expect(normalizeGeminiApiBaseUrl('generativelanguage.googleapis.com')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(normalizeGeminiApiBaseUrl('localhost:8080/v1beta/models')).toBe('http://localhost:8080/v1beta');
    expect(normalizeGeminiApiBaseUrl('https://gemini.local/v1beta/models')).toBe('https://gemini.local/v1beta');
    expect(normalizeGeminiApiBaseUrl('http://localhost:8080/v1beta/models/gemini-3.5-flash:streamGenerateContent')).toBe('http://localhost:8080/v1beta');
    expect(() => normalizeGeminiApiBaseUrl('ftp://gemini.local')).toThrow('must use http or https');
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
