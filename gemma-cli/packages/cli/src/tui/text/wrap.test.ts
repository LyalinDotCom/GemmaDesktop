import { describe, expect, it } from 'vitest';
import { wrapMultiline, wrapPlain } from './wrap.js';
import { clip, clipStart } from './clip.js';

describe('wrapPlain', () => {
  it('returns the input when it fits in one line', () => {
    expect(wrapPlain('hello world', 20)).toEqual(['hello world']);
  });

  it('wraps at word boundaries', () => {
    expect(wrapPlain('the quick brown fox jumps', 12)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('hard-breaks words longer than the line', () => {
    expect(wrapPlain('superlongunbreakableword', 6)).toEqual(['superl', 'ongunb', 'reakab', 'leword']);
  });

  it('returns an empty line for empty input', () => {
    expect(wrapPlain('', 10)).toEqual(['']);
  });
});

describe('wrapMultiline', () => {
  it('preserves logical newlines', () => {
    expect(wrapMultiline('alpha\nbeta gamma', 12)).toEqual(['alpha', 'beta gamma']);
  });

  it('handles CRLF input', () => {
    expect(wrapMultiline('one\r\ntwo', 10)).toEqual(['one', 'two']);
  });
});

describe('clip', () => {
  it('returns the text unchanged when shorter than width', () => {
    expect(clip('abc', 5)).toBe('abc');
  });

  it('appends ellipsis when truncating', () => {
    expect(clip('abcdefgh', 6)).toBe('abc...');
  });

  it('clips raw bytes for very small widths', () => {
    expect(clip('abcdef', 2)).toBe('ab');
  });

  it('returns empty string for zero or negative widths', () => {
    expect(clip('abc', 0)).toBe('');
    expect(clip('abc', -1)).toBe('');
  });
});

describe('clipStart', () => {
  it('keeps tail with leading ellipsis when too long', () => {
    expect(clipStart('abcdefgh', 5)).toBe('…efgh');
  });

  it('returns the text unchanged when shorter than width', () => {
    expect(clipStart('abc', 10)).toBe('abc');
  });
});
