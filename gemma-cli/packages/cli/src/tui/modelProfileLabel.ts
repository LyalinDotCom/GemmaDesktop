import { modelProfileFor } from '@gemma-sdk/agent';

export function modelProfileLabel(model: string): string | undefined {
  const profile = modelProfileFor(model);
  return profile.name ?? (profile.family === 'gemma4' ? 'gemma4_profile' : undefined);
}
