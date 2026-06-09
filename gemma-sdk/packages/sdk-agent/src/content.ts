import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ContentPart, MessageContent } from './types.js';

const execFileAsync = promisify(execFile);
const imageExtensions = new Set(['.png', '.webp', '.gif', '.jpg', '.jpeg']);
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const audioExtensions = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac']);
const pdfExtensions = new Set(['.pdf']);
const requestImageMaxLongEdge = 2048;

export interface ResolvedImageAsset {
  sourceUrl: string;
  mimeType: string;
  base64Data: string;
  dataUrl: string;
  originalBytes: number;
  preparedBytes: number;
}

export interface PromptAttachmentResult {
  content: MessageContent;
  notices: string[];
}

export interface AttachmentCapabilities {
  image: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
  source: string;
}

export interface AttachmentCapabilityInput {
  provider: string;
  model: string;
  displayName?: string;
  explicitImage?: boolean;
  explicitAudio?: boolean;
  explicitPdf?: boolean;
}

export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return part.text;
    }
    return `[${part.type.replace(/_url$/, '')}:${part.url}]`;
  }).join('\n');
}

export function inferAttachmentCapabilities(input: AttachmentCapabilityInput): AttachmentCapabilities {
  const providerSupportsImages = input.provider === 'ollama' || input.provider === 'lmstudio' || input.provider === 'gemini';
  const providerSupportsAudio = input.provider === 'ollama' || input.provider === 'gemini';
  const providerSupportsPdf = input.provider === 'gemini';
  const signature = [input.model, input.displayName]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const isGemma = signature.includes('gemma');
  const isGemma4 = signature.includes('gemma4');
  const isGemma3n = signature.includes('gemma3n');
  const inferredImage = isGemma && (isGemma4 || isGemma3n);
  const inferredAudio = isGemma && (isGemma3n || isGemma4AudioModel(signature));
  const image = providerSupportsImages && (input.explicitImage ?? inferredImage);
  const audio = providerSupportsAudio && (input.explicitAudio ?? inferredAudio);

  return {
    image,
    audio,
    video: image,
    pdf: providerSupportsPdf && (input.explicitPdf ?? false),
    source: input.explicitImage != null || input.explicitAudio != null || input.explicitPdf != null ? 'provider-metadata' : isGemma ? 'model-family-inference' : 'provider-default'
  };
}

function isGemma4AudioModel(signature: string): boolean {
  return signature.includes('gemma4e2b')
    || signature.includes('gemma4e4b')
    || /gemma412b/.test(signature);
}

export function assertContentSupported(content: MessageContent, capabilities: AttachmentCapabilities, model: string, provider: string): void {
  const parts = typeof content === 'string' ? [] : content;
  const unsupported = new Set<string>();
  for (const part of parts) {
    if (part.type === 'image_url' && !capabilities.image) {
      unsupported.add('image');
    } else if (part.type === 'audio_url' && !capabilities.audio) {
      unsupported.add('audio');
    } else if (part.type === 'video_url' && !capabilities.video) {
      unsupported.add('video');
    } else if (part.type === 'pdf_url' && !capabilities.pdf) {
      unsupported.add('pdf');
    }
  }
  if (unsupported.size === 0) {
    return;
  }
  throw new Error(
    `Model "${model}" on ${provider} is not configured for ${[...unsupported].join(', ')} input. Switch to a compatible model/provider or provide the content as text.`
  );
}

export function inferMimeTypeFromPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.m4v':
      return 'video/x-m4v';
    case '.webm':
      return 'video/webm';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

export async function resolveImageAssetForRequest(url: string): Promise<ResolvedImageAsset | undefined> {
  const inline = parseImageDataUrl(url);
  if (inline) {
    return inline;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return undefined;
  }
  const filePath = resolveFileUrl(url);
  if (!filePath) {
    return undefined;
  }
  const fileStats = await stat(filePath).catch(() => undefined);
  if (!fileStats?.isFile()) {
    return undefined;
  }
  const originalBytes = await readFile(filePath);
  const preparedBytes = await normalizeLocalImageForRequest(filePath, originalBytes);
  const mimeType = inferMimeTypeFromPath(filePath);
  const base64Data = preparedBytes.toString('base64');
  return {
    sourceUrl: filePath,
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    originalBytes: originalBytes.byteLength,
    preparedBytes: preparedBytes.byteLength
  };
}

export async function resolveBinaryAssetForRequest(url: string): Promise<ResolvedImageAsset | undefined> {
  const inline = parseBinaryDataUrl(url);
  if (inline) {
    return inline;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return undefined;
  }
  const filePath = resolveFileUrl(url);
  if (!filePath) {
    return undefined;
  }
  const fileStats = await stat(filePath).catch(() => undefined);
  if (!fileStats?.isFile()) {
    return undefined;
  }
  const originalBytes = await readFile(filePath);
  const mimeType = inferMimeTypeFromPath(filePath);
  const base64Data = originalBytes.toString('base64');
  return {
    sourceUrl: filePath,
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    originalBytes: originalBytes.byteLength,
    preparedBytes: originalBytes.byteLength
  };
}

export async function buildPromptContentWithMedia(prompt: string, cwd: string, capabilities?: AttachmentCapabilities): Promise<PromptAttachmentResult> {
  const attachments: ContentPart[] = [];
  const notices: string[] = [];
  const candidates = extractMediaPathCandidates(prompt, cwd);
  for (const { path: filePath, explicit } of candidates) {
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      if (explicit) {
        // The user explicitly attached this file with @path; a miss is a real error.
        throw new Error(`Attachment path does not exist or is not a file: ${filePath}`);
      }
      // An incidental path mention (e.g. an output file the agent is being asked
      // to create) must not abort the run just because it does not exist yet.
      continue;
    }
    const ext = extname(filePath).toLowerCase();
    const mediaType = inferMimeTypeFromPath(filePath);
    if (imageExtensions.has(ext)) {
      attachments.push({ type: 'image_url', url: filePath, mediaType });
    } else if (videoExtensions.has(ext)) {
      if (capabilities && !capabilities.video) {
        notices.push(`Video input is not supported by the selected model; ${filePath} was not sampled.`);
        attachments.push({ type: 'video_url', url: filePath, mediaType });
        continue;
      }
      const sampled = await sampleVideoFrames(filePath);
      if (sampled.frames.length > 0) {
        notices.push(`Attached ${sampled.frames.length} sampled video frame${sampled.frames.length === 1 ? '' : 's'} from ${filePath}.`);
        attachments.push(
          { type: 'text', text: `Video attachment: ${filePath}${sampled.durationSeconds ? ` (${sampled.durationSeconds.toFixed(1)}s)` : ''}. Sampled frames follow.` },
          ...sampled.frames.map((dataUrl, index) => ({
            type: 'image_url' as const,
            url: dataUrl,
            mediaType: 'image/jpeg',
            text: undefined,
            index
          })).map(({ type, url, mediaType }) => ({ type, url, mediaType }))
        );
      } else {
        throw new Error(`Could not sample video frames from ${filePath}; install ffmpeg or provide image frames.`);
      }
    } else if (audioExtensions.has(ext)) {
      attachments.push({ type: 'audio_url', url: filePath, mediaType });
    } else if (pdfExtensions.has(ext)) {
      attachments.push({ type: 'pdf_url', url: filePath, mediaType });
    }
  }

  if (attachments.length === 0) {
    return { content: prompt, notices };
  }

  return {
    content: [
      { type: 'text', text: prompt },
      ...attachments
    ],
    notices
  };
}

function parseImageDataUrl(value: string): ResolvedImageAsset | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(value);
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] ?? 'image';
  const base64Data = match[2] ?? '';
  const buffer = Buffer.from(base64Data, 'base64');
  return {
    sourceUrl: value,
    mimeType,
    base64Data,
    dataUrl: value,
    originalBytes: buffer.byteLength,
    preparedBytes: buffer.byteLength
  };
}

function parseBinaryDataUrl(value: string): ResolvedImageAsset | undefined {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value);
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] ?? 'application/octet-stream';
  const base64Data = match[2] ?? '';
  const buffer = Buffer.from(base64Data, 'base64');
  return {
    sourceUrl: value,
    mimeType,
    base64Data,
    dataUrl: value,
    originalBytes: buffer.byteLength,
    preparedBytes: buffer.byteLength
  };
}

function resolveFileUrl(url: string): string | undefined {
  if (url.startsWith('file://')) {
    return fileURLToPath(url);
  }
  if (isAbsolute(url)) {
    return url;
  }
  return undefined;
}

async function normalizeLocalImageForRequest(filePath: string, originalBytes: Buffer): Promise<Buffer> {
  if (process.platform !== 'darwin') {
    return originalBytes;
  }
  try {
    const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
    const width = Number(/pixelWidth:\s+(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s+(\d+)/.exec(stdout)?.[1]);
    const longEdge = Math.max(width, height);
    if (!Number.isFinite(longEdge) || longEdge <= requestImageMaxLongEdge) {
      return originalBytes;
    }
    const tempDirectory = await mkdtemp(join(tmpdir(), 'gemma-cli-image-'));
    const outputPath = join(tempDirectory, basename(filePath));
    try {
      await execFileAsync('sips', ['--resampleHeightWidthMax', String(requestImageMaxLongEdge), filePath, '--out', outputPath]);
      return await readFile(outputPath);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  } catch {
    return originalBytes;
  }
}

interface MediaPathCandidate {
  path: string;
  /** True only for explicit `@path` attachment markers (a miss is a hard error). */
  explicit: boolean;
}

function extractMediaPathCandidates(prompt: string, cwd: string): MediaPathCandidate[] {
  // Map keeps insertion order and lets an explicit `@` match override an
  // incidental mention of the same path.
  const explicitByPath = new Map<string, boolean>();
  const extensions = [...imageExtensions, ...videoExtensions, ...audioExtensions, ...pdfExtensions]
    .map((ext) => ext.slice(1))
    .join('|');
  const explicitPattern = new RegExp(`@(?:"([^"]+\\.(${extensions}))"|'([^']+\\.(${extensions}))'|([^\\s]+\\.(${extensions})))`, 'gi');
  const incidentalPattern = new RegExp(`(?:"([^"]+\\.(${extensions}))"|'([^']+\\.(${extensions}))'|((?:\\.?\\.?/|/)[^\\s]+\\.(${extensions})))`, 'gi');
  const scan = (pattern: RegExp, explicit: boolean) => {
    for (const match of prompt.matchAll(pattern)) {
      const raw = [match[1], match[3], match[5]].find((value) => typeof value === 'string' && value.length > 0);
      if (!raw) {
        continue;
      }
      const cleaned = raw.replace(/[),.;:!?]+$/g, '');
      const resolved = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
      explicitByPath.set(resolved, (explicitByPath.get(resolved) ?? false) || explicit);
    }
  };
  scan(explicitPattern, true);
  scan(incidentalPattern, false);
  return [...explicitByPath].map(([path, explicit]) => ({ path, explicit }));
}

async function sampleVideoFrames(filePath: string): Promise<{ frames: string[]; durationSeconds?: number }> {
  const stats = await stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    return { frames: [] };
  }
  const durationSeconds = await probeVideoDuration(filePath);
  const frameCount = durationSeconds == null ? 3 : durationSeconds > 180 ? 8 : durationSeconds > 45 ? 5 : 3;
  const times = buildSampleTimes(durationSeconds ?? 6, frameCount);
  const frames: string[] = [];
  const tempDirectory = await mkdtemp(join(tmpdir(), 'gemma-cli-video-'));
  try {
    for (let index = 0; index < times.length; index += 1) {
      const outputPath = join(tempDirectory, `frame-${index + 1}.jpg`);
      try {
        await execFileAsync('ffmpeg', [
          '-v', 'error',
          '-ss', String(times[index]),
          '-i', filePath,
          '-frames:v', '1',
          '-vf', 'scale=1024:-1',
          '-q:v', '3',
          '-y',
          outputPath
        ]);
        const bytes = await readFile(outputPath);
        frames.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
      } catch {
        // Keep sampling other timestamps; some containers cannot seek to every requested frame.
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  return { frames, durationSeconds };
}

async function probeVideoDuration(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

function buildSampleTimes(durationSeconds: number, count: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0];
  }
  if (count <= 1) {
    return [Math.min(durationSeconds * 0.5, Math.max(durationSeconds - 0.1, 0))];
  }
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 1) / (count + 1);
    return Math.max(0, Math.min(durationSeconds * fraction, Math.max(durationSeconds - 0.1, 0)));
  });
}
