import type { StyledSegment } from './types.js';

export function wrapStyled(segments: StyledSegment[], width: number): StyledSegment[][] {
  const safeWidth = Math.max(width, 1);
  const concatText = segments.map((segment) => segment.text).join('');
  if (concatText.length === 0) {
    return [[{ text: '', style: segments[0]?.style }]];
  }
  const styleAt = buildStyleIndex(segments);
  const breaks = computeWordBreaks(concatText, safeWidth);
  const lines: StyledSegment[][] = [];
  for (const [start, end] of breaks) {
    lines.push(sliceStyled(styleAt, segments, start, end));
  }
  return lines.length > 0 ? lines : [[{ text: '', style: segments[0]?.style }]];
}

function buildStyleIndex(segments: StyledSegment[]): Array<StyledSegment['style']> {
  const result: Array<StyledSegment['style']> = [];
  for (const segment of segments) {
    for (let index = 0; index < segment.text.length; index += 1) {
      result.push(segment.style);
    }
  }
  return result;
}

function computeWordBreaks(text: string, width: number): Array<[number, number]> {
  const breaks: Array<[number, number]> = [];
  let lineStart = 0;
  let cursor = 0;
  let lastBreak = -1;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '\n') {
      breaks.push([lineStart, cursor]);
      lineStart = cursor + 1;
      lastBreak = -1;
      cursor += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      lastBreak = cursor;
    }
    if (cursor - lineStart >= width) {
      if (lastBreak > lineStart) {
        breaks.push([lineStart, lastBreak]);
        lineStart = lastBreak + 1;
        lastBreak = -1;
      } else {
        breaks.push([lineStart, cursor]);
        lineStart = cursor;
        lastBreak = -1;
      }
      continue;
    }
    cursor += 1;
  }
  if (lineStart < text.length || breaks.length === 0) {
    breaks.push([lineStart, text.length]);
  }
  return breaks;
}

function sliceStyled(styleAt: Array<StyledSegment['style']>, segments: StyledSegment[], start: number, end: number): StyledSegment[] {
  const out: StyledSegment[] = [];
  let runStart = start;
  while (runStart < end) {
    let runEnd = runStart + 1;
    while (runEnd < end && stylesEqual(styleAt[runStart], styleAt[runEnd])) {
      runEnd += 1;
    }
    out.push({ text: sliceConcat(segments, runStart, runEnd), style: styleAt[runStart] });
    runStart = runEnd;
  }
  return out.length > 0 ? out : [{ text: '', style: segments[0]?.style }];
}

function sliceConcat(segments: StyledSegment[], start: number, end: number): string {
  let cursor = 0;
  let out = '';
  for (const segment of segments) {
    const segStart = cursor;
    const segEnd = cursor + segment.text.length;
    if (segEnd <= start) {
      cursor = segEnd;
      continue;
    }
    if (segStart >= end) break;
    const sliceStart = Math.max(start, segStart) - segStart;
    const sliceEnd = Math.min(end, segEnd) - segStart;
    out += segment.text.slice(sliceStart, sliceEnd);
    cursor = segEnd;
  }
  return out;
}

function stylesEqual(a: StyledSegment['style'], b: StyledSegment['style']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.token === b.token
    && Boolean(a.bold) === Boolean(b.bold)
    && Boolean(a.italic) === Boolean(b.italic)
    && Boolean(a.underline) === Boolean(b.underline)
    && Boolean(a.inverse) === Boolean(b.inverse)
    && Boolean(a.dim) === Boolean(b.dim);
}
