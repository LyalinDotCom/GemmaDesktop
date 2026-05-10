import type { Style } from '../theme.js';
import { withStyle } from '../theme.js';
import { parseInline } from './inline.js';
import { wrapStyled } from './wrapStyled.js';
import { highlight } from './syntax.js';
import { parseTable, renderTable } from './table.js';
import type { StyledLine, StyledSegment } from './types.js';
import { emptyLine } from './types.js';

export interface BlockOptions {
  width: number;
  base?: Style;
}

export function renderBlock(text: string, options: BlockOptions): StyledLine[] {
  const width = Math.max(options.width, 4);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: StyledLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      const block = consumeFence(lines, index, fence[1] ?? '', width);
      out.push(...block.lines);
      index = block.next;
      continue;
    }
    const tableMatch = parseTable(lines, index);
    if (tableMatch) {
      out.push(...renderTable(tableMatch.table, width, options.base));
      index += tableMatch.consumed;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ segments: [{ text: '─'.repeat(width), style: { token: 'muted' } }] });
      index += 1;
      continue;
    }
    out.push(...renderBlockLine(line, options.base, width));
    index += 1;
  }
  return out;
}

function consumeFence(lines: string[], start: number, lang: string, width: number): { lines: StyledLine[]; next: number } {
  const out: StyledLine[] = [];
  const langLabel = lang ? ` ${lang}` : '';
  out.push({ segments: [{ text: `┌─${langLabel}`, style: { token: 'codeBar' } }] });
  let cursor = start + 1;
  const codeLines: string[] = [];
  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (/^\s*```\s*$/.test(line)) {
      break;
    }
    codeLines.push(line);
    cursor += 1;
  }
  const codeText = codeLines.join('\n');
  const highlighted = highlight(lang, codeText);
  for (const physical of splitStyledByNewline(highlighted)) {
    const wrapped = wrapStyled(physical, Math.max(width - 2, 4));
    for (const wrappedLine of wrapped) {
      out.push({
        segments: [
          { text: '│ ', style: { token: 'codeBar' } },
          ...wrappedLine
        ]
      });
    }
  }
  out.push({ segments: [{ text: '└─', style: { token: 'codeBar' } }] });
  return { lines: out, next: cursor + 1 };
}

function splitStyledByNewline(segments: StyledSegment[]): StyledSegment[][] {
  const lines: StyledSegment[][] = [];
  let current: StyledSegment[] = [];
  for (const segment of segments) {
    const parts = segment.text.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        lines.push(current);
        current = [];
      }
      if (parts[index]) {
        current.push({ text: parts[index]!, style: segment.style });
      }
    }
  }
  lines.push(current);
  return lines.map((line) => line.length > 0 ? line : [{ text: '' }]);
}

function renderBlockLine(rawLine: string, base: Style | undefined, width: number): StyledLine[] {
  if (rawLine.trim() === '') {
    return [emptyLine()];
  }

  const heading = rawLine.match(/^\s*(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1]!.length;
    const inner = parseInline(heading[2]!, withStyle(base, { bold: true, token: level <= 2 ? 'roleHeader' : base?.token ?? 'default' }));
    return wrapStyledLines(inner, width);
  }

  const unordered = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    const indent = unordered[1] ?? '';
    const inner = parseInline(unordered[2]!, base);
    return wrapStyledLines([
      { text: `${indent}• `, style: { token: 'accent' } },
      ...inner
    ], width);
  }

  const ordered = rawLine.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (ordered) {
    const indent = ordered[1] ?? '';
    const number = ordered[2]!;
    const inner = parseInline(ordered[3]!, base);
    return wrapStyledLines([
      { text: `${indent}${number}. `, style: { token: 'accent' } },
      ...inner
    ], width);
  }

  const quote = rawLine.match(/^\s*>\s?(.*)$/);
  if (quote) {
    const inner = parseInline(quote[1] ?? '', withStyle(base, { italic: true, token: 'muted' }));
    return wrapStyledLines([
      { text: '│ ', style: { token: 'codeBar' } },
      ...inner
    ], width);
  }

  const inline = parseInline(rawLine, base);
  return wrapStyledLines(inline, width);
}

function wrapStyledLines(segments: StyledSegment[], width: number): StyledLine[] {
  return wrapStyled(segments, width).map((line) => ({ segments: line }));
}
