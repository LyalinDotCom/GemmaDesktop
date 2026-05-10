import type { Style } from '../theme.js';
import { parseInline } from './inline.js';
import type { StyledLine, StyledSegment } from './types.js';

export interface ParsedTable {
  header: string[];
  rows: string[][];
  alignments: Array<'left' | 'center' | 'right'>;
}

export function parseTable(lines: string[], from: number): { table: ParsedTable; consumed: number } | undefined {
  const headerLine = lines[from];
  const separatorLine = lines[from + 1];
  if (!headerLine || !separatorLine) return undefined;
  if (!isTableRow(headerLine) || !isSeparatorRow(separatorLine)) return undefined;

  const header = splitRow(headerLine);
  const alignments = parseAlignments(splitRow(separatorLine));
  if (alignments.length !== header.length) return undefined;

  const rows: string[][] = [];
  let cursor = from + 2;
  while (cursor < lines.length) {
    const candidate = lines[cursor];
    if (!candidate || !isTableRow(candidate)) break;
    const cells = splitRow(candidate);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    cursor += 1;
  }

  return { table: { header, rows, alignments }, consumed: cursor - from };
}

export function renderTable(table: ParsedTable, width: number, base?: Style): StyledLine[] {
  const widths = computeColumnWidths(table, width);
  const headerLine = renderRow(table.header, widths, table.alignments, { ...base, bold: true });
  const separator = renderSeparator(widths);
  const rowLines = table.rows.map((row) => renderRow(row, widths, table.alignments, base));
  return [headerLine, separator, ...rowLines];
}

function renderRow(row: string[], widths: number[], alignments: ParsedTable['alignments'], base: Style | undefined): StyledLine {
  const segments: StyledSegment[] = [];
  for (let index = 0; index < widths.length; index += 1) {
    if (index > 0) {
      segments.push({ text: ' │ ', style: { token: 'codeBar' } });
    }
    const cellText = row[index] ?? '';
    const inline = parseInline(cellText, base);
    const padded = padInline(inline, widths[index]!, alignments[index] ?? 'left');
    segments.push(...padded);
  }
  return { segments };
}

function renderSeparator(widths: number[]): StyledLine {
  const segments: StyledSegment[] = [];
  for (let index = 0; index < widths.length; index += 1) {
    if (index > 0) {
      segments.push({ text: '─┼─', style: { token: 'codeBar' } });
    }
    segments.push({ text: '─'.repeat(widths[index]!), style: { token: 'codeBar' } });
  }
  return { segments };
}

function padInline(segments: StyledSegment[], width: number, align: 'left' | 'center' | 'right'): StyledSegment[] {
  const text = segments.map((segment) => segment.text).join('');
  const pad = Math.max(width - text.length, 0);
  if (pad === 0) {
    return clipSegments(segments, width);
  }
  if (align === 'right') {
    return [{ text: ' '.repeat(pad) }, ...segments];
  }
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return [{ text: ' '.repeat(left) }, ...segments, { text: ' '.repeat(right) }];
  }
  return [...segments, { text: ' '.repeat(pad) }];
}

function clipSegments(segments: StyledSegment[], width: number): StyledSegment[] {
  if (width <= 0) return [{ text: '' }];
  const out: StyledSegment[] = [];
  let remaining = width;
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (segment.text.length <= remaining) {
      out.push(segment);
      remaining -= segment.text.length;
    } else {
      out.push({ text: segment.text.slice(0, Math.max(remaining - 1, 0)) + '…', style: segment.style });
      remaining = 0;
    }
  }
  return out;
}

function computeColumnWidths(table: ParsedTable, width: number): number[] {
  const colCount = table.header.length;
  const naturalWidths = table.header.map((cell, index) => {
    const headerLen = cell.length;
    const bodyLen = table.rows.reduce((max, row) => Math.max(max, (row[index] ?? '').length), 0);
    return Math.max(headerLen, bodyLen, 1);
  });
  const separatorChars = (colCount - 1) * 3;
  const total = naturalWidths.reduce((sum, value) => sum + value, 0) + separatorChars;
  if (total <= width) return naturalWidths;
  const minPerCol = 4;
  const available = Math.max(width - separatorChars, colCount * minPerCol);
  const ratio = available / Math.max(naturalWidths.reduce((sum, value) => sum + value, 0), 1);
  return naturalWidths.map((value) => Math.max(minPerCol, Math.floor(value * ratio)));
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function isSeparatorRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  return splitRow(line).every((cell) => /^:?-+:?$/.test(cell));
}

function parseAlignments(cells: string[]): ParsedTable['alignments'] {
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}
