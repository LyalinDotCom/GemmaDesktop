import type { FileChange, FileChangeMeta, FileHunk } from 'gemma-cli-core';
import type { Style, StyleToken } from '../theme.js';
import { highlight } from '../markdown/syntax.js';
import { wrapStyled } from '../markdown/wrapStyled.js';
import type { StyledLine, StyledSegment } from '../markdown/types.js';
import { HISTORY_INDENT, indented } from './render.js';
import type { HistoryEntry, HistoryRenderOptions, RenderedLine } from './types.js';

export const PREVIEW_LINE_BUDGET = 12;

export function renderFileChangeEntry(entry: HistoryEntry, meta: FileChangeMeta, options: HistoryRenderOptions): RenderedLine[] {
  const out: RenderedLine[] = [];
  for (const [index, change] of meta.changes.entries()) {
    if (index > 0) out.push({ kind: entry.kind, line: { segments: [{ text: '' }] } });
    out.push(...renderChange(entry, change, options));
  }
  return out;
}

export function renderChange(entry: HistoryEntry, change: FileChange, options: HistoryRenderOptions): RenderedLine[] {
  const headerLine = renderChangeHeader(change);
  const out: RenderedLine[] = [{ kind: entry.kind, line: headerLine }];
  const bodyWidth = Math.max(options.width - HISTORY_INDENT, 8);
  const body = renderChangeBody(change, bodyWidth);
  for (const line of body) {
    out.push({ kind: entry.kind, line: indented(line, HISTORY_INDENT) });
  }
  return out;
}

export function renderChangeHeader(change: FileChange): StyledLine {
  const marker = markerFor(change.status);
  const label = labelFor(change.status);
  const color = colorFor(change.status);
  const segments: StyledSegment[] = [
    { text: `${marker} `, style: { token: color, bold: true } },
    { text: label, style: { token: color, bold: true } },
    { text: ' ', style: { token: 'muted' } },
    { text: change.path, style: { token: 'codeText', bold: true } }
  ];
  if (change.oldPath && change.oldPath !== change.path) {
    segments.push({ text: ' ← ', style: { token: 'muted' } });
    segments.push({ text: change.oldPath, style: { token: 'muted' } });
  }
  const stats = formatStats(change);
  if (stats) {
    segments.push({ text: '  ', style: { token: 'muted' } });
    segments.push({ text: stats, style: { token: 'muted' } });
  }
  return { segments };
}

function renderChangeBody(change: FileChange, width: number): StyledLine[] {
  if (change.status === 'deleted') {
    return [];
  }
  if (change.hunks && change.hunks.length > 0) {
    return renderHunks(change.hunks, change.language, width);
  }
  if (change.preview !== undefined) {
    return renderPreview(change.preview, change.language, width, change.status);
  }
  return [];
}

function renderHunks(hunks: FileHunk[], language: string | undefined, width: number): StyledLine[] {
  const out: StyledLine[] = [];
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) {
      out.push({ segments: [{ text: '⋮', style: { token: 'codeBar', dim: true } }] });
    }
    out.push(...renderHunkLines(hunk, language, width));
  }
  return out;
}

function renderHunkLines(hunk: FileHunk, language: string | undefined, width: number): StyledLine[] {
  const out: StyledLine[] = [];
  const gutter = Math.max(String(hunk.oldStart + hunk.oldLines.length).length, String(hunk.newStart + hunk.newLines.length).length);
  for (let i = 0; i < hunk.oldLines.length; i += 1) {
    out.push(...renderDiffLine('-', hunk.oldStart + i, gutter, hunk.oldLines[i]!, language, width, 'diffDel'));
  }
  for (let i = 0; i < hunk.newLines.length; i += 1) {
    out.push(...renderDiffLine('+', hunk.newStart + i, gutter, hunk.newLines[i]!, language, width, 'diffAdd'));
  }
  return out;
}

function renderPreview(content: string, language: string | undefined, width: number, status: FileChange['status']): StyledLine[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cleanLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const visible = cleanLines.slice(0, PREVIEW_LINE_BUDGET);
  const hidden = cleanLines.length - visible.length;
  const gutter = String(cleanLines.length).length;
  const sign = status === 'deleted' ? '-' : '+';
  const token: StyleToken = status === 'deleted' ? 'diffDel' : 'diffAdd';
  const out: StyledLine[] = [];
  for (let i = 0; i < visible.length; i += 1) {
    out.push(...renderDiffLine(sign, i + 1, gutter, visible[i]!, language, width, token));
  }
  if (hidden > 0) {
    out.push({
      segments: [
        { text: ' '.repeat(gutter + 3), style: { token: 'muted' } },
        { text: `… +${hidden} more line${hidden === 1 ? '' : 's'}`, style: { token: 'muted', italic: true } }
      ]
    });
  }
  return out;
}

function renderDiffLine(sign: '+' | '-' | ' ', lineNumber: number, gutter: number, content: string, language: string | undefined, width: number, token: StyleToken): StyledLine[] {
  const numberText = String(lineNumber).padStart(gutter, ' ');
  const prefixSegments: StyledSegment[] = [
    { text: ' ', style: { token: 'muted' } },
    { text: numberText, style: { token: 'codeBar' } },
    { text: ` ${sign} `, style: { token, bold: true } }
  ];
  const baseStyle: Style = { token };
  const codeSegments = highlightForDiff(content, language, baseStyle);
  const inner = Math.max(width - (gutter + 4), 8);
  const wrapped = wrapStyled(codeSegments, inner);
  return wrapped.map((segments, index) => {
    if (index === 0) return { segments: [...prefixSegments, ...segments] };
    return { segments: [{ text: ' '.repeat(gutter + 4), style: { token: 'muted' } }, ...segments] };
  });
}

function highlightForDiff(content: string, language: string | undefined, base: Style): StyledSegment[] {
  if (!content) return [{ text: '', style: base }];
  if (!language) return [{ text: content, style: base }];
  const tinted = highlight(language, content);
  return tinted.map((segment) => ({
    text: segment.text,
    style: {
      token: base.token,
      bold: segment.style?.token === 'syntaxKeyword' ? true : base.bold,
      italic: segment.style?.token === 'syntaxComment' ? true : base.italic
    }
  }));
}

function markerFor(status: FileChange['status']): string {
  if (status === 'created') return '✚';
  if (status === 'deleted') return '✖';
  if (status === 'renamed') return '↻';
  return '✎';
}

function labelFor(status: FileChange['status']): string {
  if (status === 'created') return 'created';
  if (status === 'overwritten') return 'overwrote';
  if (status === 'deleted') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'edited';
}

function colorFor(status: FileChange['status']): StyleToken {
  if (status === 'created') return 'success';
  if (status === 'deleted') return 'danger';
  if (status === 'overwritten' || status === 'renamed') return 'warning';
  return 'info';
}

function formatStats(change: FileChange): string | undefined {
  const parts: string[] = [];
  if (typeof change.linesAdded === 'number' && change.linesAdded > 0) parts.push(`+${change.linesAdded}`);
  if (typeof change.linesRemoved === 'number' && change.linesRemoved > 0) parts.push(`-${change.linesRemoved}`);
  if (parts.length === 0 && typeof change.bytesAfter === 'number') {
    parts.push(`${change.bytesAfter} bytes`);
  }
  return parts.length > 0 ? `(${parts.join(' ')})` : undefined;
}
