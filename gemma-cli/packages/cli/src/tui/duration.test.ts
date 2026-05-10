import { describe, expect, it } from 'vitest';
import { formatClockDuration, formatDuration, runCompletionMessage } from './duration.js';

describe('duration formatting', () => {
  it('formats compact human durations for stats and exit output', () => {
    expect(formatDuration(842)).toBe('842ms');
    expect(formatDuration(1_200)).toBe('1.2s');
    expect(formatDuration(62_000)).toBe('1m 2s');
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
  });

  it('formats run completion durations as clock text', () => {
    expect(formatClockDuration(12_000)).toBe('0:12');
    expect(formatClockDuration(62_000)).toBe('1:02');
    expect(formatClockDuration(3_723_000)).toBe('1:02:03');
  });

  it('uses the requested parenthesized run completion shape', () => {
    expect(runCompletionMessage('completed', 12_000)).toBe('run complete (0:12)');
    expect(runCompletionMessage('incomplete', 62_000)).toBe('run incomplete (1:02)');
  });
});
