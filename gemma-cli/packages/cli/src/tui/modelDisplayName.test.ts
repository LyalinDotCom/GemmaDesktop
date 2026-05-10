import { describe, expect, it } from 'vitest';
import { modelDisplayName } from './modelDisplayName.js';

describe('modelDisplayName', () => {
  it('labels suffixed Gemma 4 workstation tags without dropping the exact model name', () => {
    expect(modelDisplayName('gemma4:31b-coding-mtp-bf16')).toBe('Gemma 4 31B (gemma4:31b-coding-mtp-bf16)');
    expect(modelDisplayName('gemma4:26b-mlx-bf16')).toBe('Gemma 4 26B (gemma4:26b-mlx-bf16)');
  });

  it('labels Gemma 4 edge tags', () => {
    expect(modelDisplayName('gemma4:e4b')).toBe('Gemma 4 E4B (gemma4:e4b)');
  });

  it('leaves unknown model names unchanged', () => {
    expect(modelDisplayName('qwen2.5-coder:32b')).toBe('qwen2.5-coder:32b');
  });
});
