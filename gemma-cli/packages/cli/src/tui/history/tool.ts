import { wrapStyled } from '../markdown/wrapStyled.js';
import { highlight } from '../markdown/syntax.js';
import { emptyLine, type StyledLine, type StyledSegment } from '../markdown/types.js';
import type { Style, StyleToken } from '../theme.js';
import { HISTORY_INDENT, indented } from './render.js';
import type { HistoryEntry, HistoryRenderOptions, RenderedLine } from './types.js';

interface ToolMeta {
  label: string;
  marker: string;
  labelToken: StyleToken;
  bodyToken: StyleToken;
  titleToken?: StyleToken;
  italicBody?: boolean;
  dimBody?: boolean;
}

type ToolStatus = 'ok' | 'failed' | 'running' | 'notice';

const COLLAPSE_THRESHOLD_OK = 4;
const COLLAPSE_THRESHOLD_FAIL = 24;

export function renderToolEntry(entry: HistoryEntry, meta: ToolMeta, options: HistoryRenderOptions): RenderedLine[] {
  const { title, body } = splitTitleAndBody(entry.text);
  const status = inferStatus(entry, body);
  const trimmedBody = stripStatusLine(body, status);
  const headerLine = renderHeader(meta, title, status, options.width);
  const lines: RenderedLine[] = [{ kind: entry.kind, line: headerLine }];

  if (!trimmedBody) return lines;

  const bodyWidth = Math.max(options.width - HISTORY_INDENT, 4);
  const bodyLines = renderBody(entry, trimmedBody, bodyWidth);
  const limit = collapseLimitFor(entry, status);
  const visible = bodyLines.slice(0, limit);
  const hidden = bodyLines.length - visible.length;
  for (const line of visible) {
    lines.push({
      kind: entry.kind,
      line: indented(line, HISTORY_INDENT)
    });
  }
  if (hidden > 0) {
    lines.push({
      kind: entry.kind,
      line: indented({
        segments: [
          { text: `… +${hidden} more line${hidden === 1 ? '' : 's'}`, style: { token: 'muted', italic: true } }
        ]
      }, HISTORY_INDENT)
    });
  }
  return lines;
}

function collapseLimitFor(entry: HistoryEntry, status: ToolStatus | undefined): number {
  if (entry.kind !== 'tool') return Number.POSITIVE_INFINITY;
  if (status === 'failed' || entry.kind === ('error' as HistoryEntry['kind'])) return COLLAPSE_THRESHOLD_FAIL;
  return COLLAPSE_THRESHOLD_OK;
}

function stripStatusLine(body: string, status: ToolStatus | undefined): string {
  if (!status || !body) return body;
  const lines = body.split('\n');
  const first = lines[0]?.trim().toLowerCase();
  if (first === status || first === 'completed') {
    return lines.slice(1).join('\n').trimStart();
  }
  return body;
}

function renderHeader(meta: ToolMeta, title: string, status: ToolStatus | undefined, width: number): StyledLine {
  const segments: StyledSegment[] = [
    { text: `${meta.marker} `, style: { token: meta.labelToken, bold: true } },
    { text: meta.label, style: { token: meta.labelToken, bold: true } }
  ];
  if (title) {
    segments.push({ text: ' ', style: { token: 'muted' } });
    segments.push({ text: title, style: { token: status === 'notice' ? 'muted' : (meta.titleToken ?? 'codeText') } });
  }
  if (status) {
    segments.push({ text: '  · ', style: { token: 'muted' } });
    segments.push({ text: status, style: statusStyle(status) });
  }
  const wrapped = wrapStyled(segments, Math.max(width, 8));
  return { segments: wrapped[0]! };
}

function renderBody(entry: HistoryEntry, body: string, width: number): StyledLine[] {
  const lines: StyledLine[] = [];
  const fenced = entry.kind === 'command' ? splitCommandBody(body) : undefined;
  if (fenced) {
    for (const line of fenced) {
      lines.push(line);
    }
    return wrapAllStyled(lines, width);
  }
  const useSyntax = entry.kind === 'command';
  const language = useSyntax ? 'sh' : undefined;
  const segments = useSyntax ? highlight(language, body) : plainBodySegments(body, entry);
  for (const physicalLine of splitStyledByNewline(segments)) {
    const wrapped = wrapStyled(physicalLine, width);
    for (const wrappedLine of wrapped) {
      lines.push({ segments: wrappedLine });
    }
  }
  return lines.length > 0 ? lines : [emptyLine()];
}

function wrapAllStyled(lines: StyledLine[], width: number): StyledLine[] {
  const out: StyledLine[] = [];
  for (const line of lines) {
    const wrapped = wrapStyled(line.segments, width);
    for (const segments of wrapped) {
      out.push({ segments });
    }
  }
  return out;
}

function plainBodySegments(body: string, entry: HistoryEntry): StyledSegment[] {
  const baseStyle: Style = entry.kind === 'error'
    ? { token: 'roleError' }
    : entry.kind === 'disclaimer'
      ? { token: 'warning' }
    : entry.kind === 'notice'
      ? { token: 'muted', dim: true }
    : entry.kind === 'tool'
      ? { token: 'codeText', dim: true }
      : { token: 'codeText' };
  return [{ text: body, style: baseStyle }];
}

function splitCommandBody(body: string): StyledLine[] | undefined {
  const lines = body.split('\n');
  if (lines.length === 0) return undefined;
  const first = lines[0]!;
  const command = first.match(/^\$\s+(.+)$/);
  if (!command) return undefined;
  const result: StyledLine[] = [];
  result.push({
    segments: [
      { text: '$ ', style: { token: 'accent', bold: true } },
      { text: command[1]!, style: { token: 'codeText', bold: true } }
    ]
  });
  const rest = lines.slice(1).join('\n');
  if (rest) {
    const segments = highlight('sh', rest);
    for (const physicalLine of splitStyledByNewline(segments)) {
      result.push({ segments: physicalLine });
    }
  }
  return result;
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

function splitTitleAndBody(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return {
    title: lines[0]?.trim() ?? '',
    body: lines.slice(1).join('\n').trimEnd()
  };
}

function inferStatus(entry: HistoryEntry, body: string): ToolStatus | undefined {
  if (entry.kind === 'error') return 'failed';
  if (entry.kind === 'notice') return 'notice';
  if (entry.kind === 'disclaimer') return undefined;
  if (entry.kind !== 'tool') return undefined;
  const firstLine = body.split('\n', 1)[0]?.trim().toLowerCase();
  if (firstLine === 'ok' || firstLine === 'completed') return 'ok';
  if (firstLine === 'failed') return 'failed';
  if (firstLine === 'running') return 'running';
  if (firstLine === 'notice') return 'notice';
  return undefined;
}

function statusStyle(status: ToolStatus): Style {
  if (status === 'ok') return { token: 'success', bold: true };
  if (status === 'failed') return { token: 'danger', bold: true };
  if (status === 'notice') return { token: 'muted' };
  return { token: 'warning', italic: true };
}
