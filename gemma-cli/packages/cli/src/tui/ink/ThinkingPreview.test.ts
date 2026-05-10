import { describe, expect, it } from 'vitest';
import { thinkingPreviewSegments } from './ThinkingPreview.js';

describe('thinkingPreviewSegments', () => {
  it('uses styled thinking text instead of one plain gray segment', () => {
    const segments = thinkingPreviewSegments('Plan: inspect file, run test, fix error', 80);

    expect(segments[0]?.text).toBe('  ◌ ');
    expect(segments.some((segment) => segment.text === 'Plan' && segment.style?.token === 'info')).toBe(true);
    expect(segments.some((segment) => segment.text === 'file' && segment.style?.token === 'info')).toBe(true);
    expect(segments.some((segment) => segment.text === 'error' && segment.style?.token === 'danger')).toBe(true);
  });

  it('clips to the available preview width after the thinking marker', () => {
    const width = 18;
    const segments = thinkingPreviewSegments('this is a very long reasoning preview', width);
    const rendered = segments.map((segment) => segment.text).join('');

    expect(rendered.length).toBeLessThanOrEqual(width);
  });
});
