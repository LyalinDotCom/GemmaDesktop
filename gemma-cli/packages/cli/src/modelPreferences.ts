import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CliOptions } from './args.js';

export type LocalModelProvider = Extract<CliOptions['provider'], 'ollama' | 'lmstudio'>;

export interface ModelPreference {
  version: 1;
  provider: LocalModelProvider;
  model: string;
  updatedAt: string;
}

export async function readModelPreference(cwd: string): Promise<ModelPreference | undefined> {
  try {
    const parsed = JSON.parse(await readFile(preferencePath(cwd), 'utf8')) as Partial<ModelPreference>;
    if (
      parsed.version === 1
      && isLocalProvider(parsed.provider)
      && typeof parsed.model === 'string'
      && parsed.model.length > 0
    ) {
      return {
        version: 1,
        provider: parsed.provider,
        model: parsed.model,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function writeModelPreference(cwd: string, provider: LocalModelProvider, model: string): Promise<void> {
  const root = join(resolve(cwd), '.gemmacli');
  await mkdir(root, { recursive: true });
  const target = join(root, 'model-preference.json');
  const temp = `${target}.tmp`;
  const preference: ModelPreference = {
    version: 1,
    provider,
    model,
    updatedAt: new Date().toISOString()
  };
  try {
    await writeFile(temp, `${JSON.stringify(preference, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isLocalProvider(provider: unknown): provider is LocalModelProvider {
  return provider === 'ollama' || provider === 'lmstudio';
}

function preferencePath(cwd: string): string {
  return join(resolve(cwd), '.gemmacli', 'model-preference.json');
}
