import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLocalProvider, readModelPreference, writeModelPreference } from './modelPreferences.js';

describe('model preferences', () => {
  it('persists the last selected local model under the workspace diagnostics directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-cli-preferences-'));

    await writeModelPreference(cwd, 'lmstudio', 'google/gemma-4-26b-a4b');

    await expect(readModelPreference(cwd)).resolves.toMatchObject({
      version: 1,
      provider: 'lmstudio',
      model: 'google/gemma-4-26b-a4b'
    });
  });

  it('recognizes only local model providers', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('lmstudio')).toBe(true);
    expect(isLocalProvider('remote')).toBe(false);
  });
});
