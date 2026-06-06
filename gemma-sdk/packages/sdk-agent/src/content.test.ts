import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertContentSupported, buildPromptContentWithMedia, inferAttachmentCapabilities } from './content.js';

describe('content attachment capabilities', () => {
  it('infers Gemma image and audio support like Gemma Desktop', () => {
    expect(inferAttachmentCapabilities({ provider: 'ollama', model: 'gemma4:26b' })).toMatchObject({
      image: true,
      audio: false,
      video: true
    });
    expect(inferAttachmentCapabilities({ provider: 'ollama', model: 'gemma4:e4b' })).toMatchObject({
      image: true,
      audio: true,
      video: true
    });
    expect(inferAttachmentCapabilities({ provider: 'ollama', model: 'gemma4:12b' })).toMatchObject({
      image: true,
      audio: true,
      video: true
    });
    expect(inferAttachmentCapabilities({ provider: 'lmstudio', model: 'gemma4:e4b' })).toMatchObject({
      image: true,
      audio: false,
      video: true
    });
    expect(inferAttachmentCapabilities({ provider: 'lmstudio', model: 'google/gemma-4-12b' })).toMatchObject({
      image: true,
      audio: false,
      video: true
    });
  });

  it('blocks unsupported attachments before provider calls', () => {
    const capabilities = inferAttachmentCapabilities({ provider: 'ollama', model: 'qwen2.5-coder:32b' });

    expect(() => assertContentSupported([
      { type: 'text', text: 'look' },
      { type: 'image_url', url: '/tmp/image.png' }
    ], capabilities, 'qwen2.5-coder:32b', 'ollama')).toThrow('not configured for image input');
  });

  it('honors Gemini model metadata for image, audio, video, and PDF support', () => {
    expect(inferAttachmentCapabilities({
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      explicitImage: true,
      explicitAudio: true,
      explicitPdf: true
    })).toMatchObject({
      image: true,
      audio: true,
      video: true,
      pdf: true,
      source: 'provider-metadata'
    });

    const withoutMetadata = inferAttachmentCapabilities({
      provider: 'gemini',
      model: 'gemini-3.5-flash'
    });
    expect(withoutMetadata.image).toBe(false);
    expect(withoutMetadata.pdf).toBe(false);
  });

  it('extracts supported media paths from prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-cli-content-'));
    await writeFile(join(cwd, 'sample.png'), 'not-a-real-image', 'utf8');

    const content = await buildPromptContentWithMedia('look at @sample.png', cwd, {
      image: true,
      audio: false,
      video: true,
      pdf: false,
      source: 'test'
    });

    expect(content.content).toEqual([
      { type: 'text', text: 'look at @sample.png' },
      { type: 'image_url', url: join(cwd, 'sample.png'), mediaType: 'image/png' }
    ]);
  });

  it('rejects missing media paths before provider requests', async () => {
    await expect(buildPromptContentWithMedia('look at @missing.png', '/tmp')).rejects.toThrow('Attachment path does not exist');
  });
});
