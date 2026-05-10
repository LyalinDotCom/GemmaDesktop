import { describe, expect, it } from 'vitest';
import { inputViewport } from './Input.js';

describe('Ink input viewport', () => {
  it('shows the wrapped line containing the cursor instead of the first line forever', () => {
    expect(inputViewport('abcdefghi', 8, 4)).toMatchObject({
      text: 'i',
      visibleLines: ['abcd', 'efgh', 'i'],
      visibleStart: 0,
      visibleCursorLine: 2,
      cursorOffset: 0,
      lineIndex: 2,
      lineCount: 3,
      placeholder: false
    });
  });

  it('expands hard-newline input while it fits within five visible lines', () => {
    expect(inputViewport('first\nsecond', 7, 10)).toMatchObject({
      text: 'second',
      visibleLines: ['first', 'second'],
      visibleStart: 0,
      visibleCursorLine: 1,
      cursorOffset: 1,
      lineIndex: 1,
      lineCount: 2,
      placeholder: false
    });
  });

  it('limits visible input to five lines and keeps the cursor line visible', () => {
    expect(inputViewport('one\ntwo\nthree\nfour\nfive\nsix', 27, 20)).toMatchObject({
      text: 'six',
      visibleLines: ['two', 'three', 'four', 'five', 'six'],
      visibleStart: 1,
      visibleCursorLine: 4,
      lineIndex: 5,
      lineCount: 6,
      placeholder: false
    });
  });

  it('uses placeholder text only for empty input', () => {
    expect(inputViewport('', 0, 20)).toMatchObject({
      text: 'Send a message…',
      visibleLines: ['Send a message…'],
      cursorOffset: 0,
      placeholder: true
    });
  });
});
