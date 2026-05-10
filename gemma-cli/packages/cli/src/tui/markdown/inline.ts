import type { Style } from '../theme.js';
import { withStyle } from '../theme.js';
import type { StyledSegment } from './types.js';

interface Match {
  start: number;
  end: number;
  inner: string;
  apply: (innerSegments: StyledSegment[]) => StyledSegment[];
}

export function parseInline(text: string, base?: Style): StyledSegment[] {
  if (!text) {
    return [{ text: '', style: base }];
  }
  const segments: StyledSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const match = nextInlineMatch(text, cursor);
    if (!match) {
      segments.push({ text: text.slice(cursor), style: base });
      break;
    }
    if (match.start > cursor) {
      segments.push({ text: text.slice(cursor, match.start), style: base });
    }
    const innerSegments = parseInline(match.inner, base);
    segments.push(...match.apply(innerSegments));
    cursor = match.end;
  }
  return mergeSegments(segments);
}

function nextInlineMatch(text: string, from: number): Match | undefined {
  let best: Match | undefined;
  for (const find of FINDERS) {
    const candidate = find(text, from);
    if (!candidate) continue;
    if (!best || candidate.start < best.start) {
      best = candidate;
    }
  }
  return best;
}

type Finder = (text: string, from: number) => Match | undefined;

const FINDERS: Finder[] = [
  findInlineCode,
  findStrong,
  findEmphasis,
  findStrikethrough,
  findLink
];

function findInlineCode(text: string, from: number): Match | undefined {
  const start = text.indexOf('`', from);
  if (start === -1) return undefined;
  let tickCount = 0;
  while (text[start + tickCount] === '`') tickCount += 1;
  const opener = '`'.repeat(tickCount);
  const closer = text.indexOf(opener, start + tickCount);
  if (closer === -1) return undefined;
  const inner = text.slice(start + tickCount, closer);
  return {
    start,
    end: closer + tickCount,
    inner,
    apply: () => [{ text: inner, style: { token: 'inlineCode' } }]
  };
}

function findStrong(text: string, from: number): Match | undefined {
  return findDelimited(text, from, '**');
}

function findEmphasis(text: string, from: number): Match | undefined {
  const star = findDelimited(text, from, '*');
  const under = findDelimitedSingle(text, from, '_');
  if (!star) return under;
  if (!under) return star;
  return star.start <= under.start ? star : under;
}

function findStrikethrough(text: string, from: number): Match | undefined {
  return findDelimited(text, from, '~~');
}

function findDelimited(text: string, from: number, delimiter: string): Match | undefined {
  const opener = text.indexOf(delimiter, from);
  if (opener === -1) return undefined;
  const innerStart = opener + delimiter.length;
  if (text[innerStart] === ' ' || innerStart >= text.length) return undefined;
  const closer = findClosing(text, innerStart, delimiter);
  if (closer === -1) return undefined;
  const inner = text.slice(innerStart, closer);
  return {
    start: opener,
    end: closer + delimiter.length,
    inner,
    apply: (innerSegments) => innerSegments.map((segment) => ({
      text: segment.text,
      style: withStyle(segment.style, weightFor(delimiter))
    }))
  };
}

function findDelimitedSingle(text: string, from: number, delimiter: '_'): Match | undefined {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== delimiter) continue;
    const before = text[index - 1] ?? ' ';
    const after = text[index + 1] ?? ' ';
    if (/\w/.test(before) && /\w/.test(after)) continue;
    const innerStart = index + 1;
    const closer = findClosingUnderscore(text, innerStart);
    if (closer === -1) continue;
    const inner = text.slice(innerStart, closer);
    return {
      start: index,
      end: closer + 1,
      inner,
      apply: (innerSegments) => innerSegments.map((segment) => ({
        text: segment.text,
        style: withStyle(segment.style, { italic: true })
      }))
    };
  }
  return undefined;
}

function findClosing(text: string, from: number, delimiter: string): number {
  let cursor = from;
  while (cursor < text.length) {
    const at = text.indexOf(delimiter, cursor);
    if (at === -1) return -1;
    if (text[at - 1] === '\\') {
      cursor = at + delimiter.length;
      continue;
    }
    if (delimiter === '*' && text[at + 1] === '*') {
      const skipPast = skipBoldRun(text, at);
      if (skipPast !== -1) {
        cursor = skipPast;
        continue;
      }
      cursor = at + 1;
      continue;
    }
    return at;
  }
  return -1;
}

function skipBoldRun(text: string, openerStart: number): number {
  if (text[openerStart] !== '*' || text[openerStart + 1] !== '*') return -1;
  const innerStart = openerStart + 2;
  const closer = text.indexOf('**', innerStart);
  if (closer === -1) return -1;
  return closer + 2;
}

function findClosingUnderscore(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== '_') continue;
    const before = text[index - 1] ?? '';
    const after = text[index + 1] ?? ' ';
    if (/\w/.test(before) && /\w/.test(after)) continue;
    return index;
  }
  return -1;
}

function findLink(text: string, from: number): Match | undefined {
  const open = text.indexOf('[', from);
  if (open === -1) return undefined;
  const labelEnd = text.indexOf(']', open + 1);
  if (labelEnd === -1) return undefined;
  if (text[labelEnd + 1] !== '(') return undefined;
  const urlEnd = text.indexOf(')', labelEnd + 2);
  if (urlEnd === -1) return undefined;
  const label = text.slice(open + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd);
  return {
    start: open,
    end: urlEnd + 1,
    inner: label,
    apply: (innerSegments) => {
      const styled = innerSegments.map((segment) => ({
        text: segment.text,
        style: withStyle(segment.style, { token: 'link', underline: true })
      }));
      const trailing: StyledSegment = { text: ` (${url})`, style: { token: 'muted' } };
      return [...styled, trailing];
    }
  };
}

function weightFor(delimiter: string): Partial<Style> {
  if (delimiter === '**') return { bold: true };
  if (delimiter === '*') return { italic: true };
  if (delimiter === '~~') return { dim: true };
  return {};
}

function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
  const out: StyledSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && stylesEqual(last.style, segment.style)) {
      last.text += segment.text;
    } else {
      out.push({ ...segment });
    }
  }
  return out.length > 0 ? out : [{ text: '', style: segments[0]?.style }];
}

function stylesEqual(a: Style | undefined, b: Style | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.token === b.token
    && Boolean(a.bold) === Boolean(b.bold)
    && Boolean(a.italic) === Boolean(b.italic)
    && Boolean(a.underline) === Boolean(b.underline)
    && Boolean(a.inverse) === Boolean(b.inverse)
    && Boolean(a.dim) === Boolean(b.dim);
}
