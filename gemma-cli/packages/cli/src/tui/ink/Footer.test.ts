import { describe, expect, it } from 'vitest';
import { Footer, footerLayout, reasoningFooterLabel } from './Footer.js';
import type { TuiSession } from '../../tui.js';

describe('footerLayout', () => {
  it('puts cwd on the left and model+context on the right', () => {
    const { left, right } = footerLayout({ cwd: '/repo', model: 'gemma4:26b', reasoning: 'think on', context: '~2% used (256k)', width: 80 });
    expect(left).toBe('/repo');
    expect(right).toBe('gemma4_profile  ·  think on  ·  gemma4:26b  ·  ~2% used (256k)');
  });

  it('omits the profile label for generic models', () => {
    const { right } = footerLayout({ cwd: '/repo', model: 'qwen2.5-coder', reasoning: 'think off', context: '~2% used (32k)', width: 80 });
    expect(right).toBe('think off  ·  qwen2.5-coder  ·  ~2% used (32k)');
  });

  it('can omit the reasoning label for non-TUI renderers', () => {
    const { right } = footerLayout({ cwd: '/repo', model: 'qwen2.5-coder', context: 'n/a', width: 80 });
    expect(right).toBe('qwen2.5-coder  ·  n/a');
  });

  it('puts the live token rate at the far right when present', () => {
    const { right } = footerLayout({ cwd: '/repo', model: 'gemma4:26b', reasoning: 'think on', context: '~2% used (256k)', tokenRate: '~42 tok/s', width: 100 });

    expect(right).toBe('gemma4_profile  ·  think on  ·  gemma4:26b  ·  ~2% used (256k)  ·  ~42 tok/s');
    expect(right.endsWith('~42 tok/s')).toBe(true);
  });

  it('clips long cwd to fit available width', () => {
    const longCwd = '/'.padEnd(120, 'a');
    const { left, right } = footerLayout({ cwd: longCwd, model: 'm', context: 'c', width: 40 });
    expect(left.length + right.length).toBeLessThanOrEqual(40);
    expect(left.endsWith('...')).toBe(true);
    expect(right).toBe('m  ·  c');
  });

  it('includes branch on the left when provided', () => {
    const { left } = footerLayout({ cwd: '/repo', model: 'm', context: 'c', branch: 'main', width: 80 });
    expect(left).toContain('/repo');
    expect(left).toContain('main');
  });

  it('renders the reasoning label in the Ink footer component', () => {
    const element = Footer({ cwd: '/repo', model: 'gemma4:26b', reasoning: 'think on', context: '~2% used (256k)', width: 80 });

    expect(reactText(element)).toContain('think on');
    expect(reactText(element)).toContain('~2% used (256k)');
  });
});

describe('reasoningFooterLabel', () => {
  it('shows unsupported for LM Studio models without reasoning control', () => {
    expect(reasoningFooterLabel(session({ provider: 'lmstudio', model: 'gemma-4-31b-it-mlx', providerReasoning: false })))
      .toBe('think unsupported');
  });

  it('shows on for LM Studio Gemma 4 models with reasoning control', () => {
    expect(reasoningFooterLabel(session({ provider: 'lmstudio', model: 'google/gemma-4-26b-a4b', providerReasoning: true })))
      .toBe('think on');
  });

  it('shows off when the user disables reasoning', () => {
    expect(reasoningFooterLabel(session({ provider: 'lmstudio', model: 'google/gemma-4-26b-a4b', providerReasoning: true, reasoningMode: 'off' })))
      .toBe('think off');
  });
});

function session(options: {
  provider: TuiSession['provider'];
  model: string;
  providerReasoning?: boolean;
  reasoningMode?: TuiSession['reasoningMode'];
}): TuiSession {
  return {
    provider: options.provider,
    reasoningMode: options.reasoningMode ?? 'auto',
    runtime: {
      model: options.model,
      providerReasoning: options.providerReasoning
    }
  } as unknown as TuiSession;
}

function reactText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const props = (value as { props?: { children?: unknown } }).props;
  const children = props?.children;
  if (Array.isArray(children)) {
    return children.map(reactText).join('');
  }
  return reactText(children);
}
