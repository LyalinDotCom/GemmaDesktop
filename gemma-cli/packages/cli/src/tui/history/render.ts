import type { Style, StyleToken } from '../theme.js';
import { renderBlock } from '../markdown/block.js';
import { wrapStyled } from '../markdown/wrapStyled.js';
import { emptyLine, type StyledLine, type StyledSegment } from '../markdown/types.js';
import { renderToolEntry } from './tool.js';
import { renderFileChangeEntry } from './fileChange.js';
import type { HistoryEntry, HistoryKind, HistoryRenderOptions, RenderedLine } from './types.js';

export const HISTORY_INDENT = 2;

interface KindMeta {
  label: string;
  marker: string;
  labelToken: StyleToken;
  bodyToken: StyleToken;
  titleToken?: StyleToken;
  italicBody?: boolean;
  dimBody?: boolean;
}

const META: Record<HistoryKind, KindMeta> = {
  user: { label: 'you', marker: '›', labelToken: 'roleUser', bodyToken: 'roleUser' },
  assistant: { label: 'gemma', marker: '•', labelToken: 'roleAssistant', bodyToken: 'default' },
  thinking: { label: 'thinking', marker: '◌', labelToken: 'roleThinking', bodyToken: 'roleThinking', italicBody: true },
  tool: { label: 'tool', marker: '⏺', labelToken: 'roleTool', bodyToken: 'default' },
  command: { label: 'shell', marker: '$', labelToken: 'roleCommand', bodyToken: 'codeText' },
  settings: { label: 'settings', marker: '◆', labelToken: 'roleSettings', bodyToken: 'default' },
  status: { label: 'status', marker: '◆', labelToken: 'roleStatus', bodyToken: 'default' },
  disclaimer: { label: 'notice', marker: '◆', labelToken: 'warning', bodyToken: 'warning', titleToken: 'warning' },
  notice: { label: 'notice', marker: '◆', labelToken: 'muted', bodyToken: 'muted', dimBody: true },
  error: { label: 'error', marker: '!', labelToken: 'roleError', bodyToken: 'roleError' }
};

export function renderHistoryEntry(entry: HistoryEntry, options: HistoryRenderOptions): RenderedLine[] {
  const meta = META[entry.kind];
  const out: RenderedLine[] = [];
  if (options.separate) {
    out.push({ kind: entry.kind, line: emptyLine() });
  }

  if (entry.meta?.fileChange) {
    return [...out, ...renderFileChangeEntry(entry, entry.meta.fileChange, options)];
  }

  if (entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'disclaimer' || entry.kind === 'notice' || entry.kind === 'error') {
    return [...out, ...renderToolEntry(entry, meta, options)];
  }

  if (entry.kind !== 'assistant' && entry.kind !== 'user') {
    out.push({
      kind: entry.kind,
      line: {
        segments: [
          { text: `${meta.marker} `, style: { token: meta.labelToken, bold: true } },
          { text: meta.label, style: { token: meta.labelToken, bold: true } }
        ]
      }
    });
  }

  const baseStyle: Style = {
    token: meta.bodyToken,
    italic: meta.italicBody,
    dim: meta.dimBody
  };
  const bodyWidth = Math.max(options.width - HISTORY_INDENT, 4);
  const bodyLines = renderBlock(entry.text, { width: bodyWidth, base: baseStyle });
  for (const line of bodyLines) {
    out.push({
      kind: entry.kind,
      line: indented(line, HISTORY_INDENT)
    });
  }
  return out;
}

export function renderHistoryEntries(entries: HistoryEntry[], options: { width: number }): RenderedLine[] {
  const out: RenderedLine[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    out.push(...renderHistoryEntry(entry, { width: options.width, separate: index > 0 }));
  }
  return out;
}

export function indented(line: StyledLine, columns: number): StyledLine {
  if (columns <= 0) return line;
  return {
    segments: [{ text: ' '.repeat(columns) }, ...line.segments]
  };
}

export function styledLineForText(text: string, style: Style | undefined, width: number): StyledLine[] {
  const segments: StyledSegment[] = [{ text, style }];
  return wrapStyled(segments, width).map((line) => ({ segments: line }));
}
