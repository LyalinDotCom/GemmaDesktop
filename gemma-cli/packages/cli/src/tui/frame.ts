import type { TuiCommand, TuiSession } from '../tui.js';
import { styleToAnsi, type Style } from './theme.js';
import { renderHistoryEntries, HISTORY_INDENT } from './history/render.js';
import type { HistoryEntry, RenderedLine } from './history/types.js';
import type { StyledLine } from './markdown/types.js';
import { plainText } from './markdown/types.js';
import { clip } from './text/clip.js';
import { modelProfileLabel } from './modelProfileLabel.js';
import { cliVersion } from '../version.js';
import { modelDisplayName } from './modelDisplayName.js';
import { tokenRateLabel } from './tokenRate.js';

export interface FrameOptions {
  width?: number;
  height?: number;
  color?: boolean;
}

export function renderTuiFrame(session: TuiSession, options: FrameOptions = {}): string {
  const width = Math.max(options.width ?? process.stdout.columns ?? 88, 48);
  const height = Math.max(options.height ?? process.stdout.rows ?? 24, 12);
  const color = options.color ?? true;
  const minHistoryRows = 3;
  const maxSuggestionRows = Math.max(0, height - 6 - minHistoryRows);
  const suggestions = (session.commandSuggestions ?? []).slice(0, Math.min(8, maxSuggestionRows));
  const reservedRows = 6 + suggestions.length;
  const historyHeight = Math.max(height - reservedRows, 3);

  const renderedHistory = renderHistoryEntries(session.history as HistoryEntry[], { width });
  const historyTextLines = applyScroll(renderedHistory, session, historyHeight, width, color);

  const padCount = Math.max(historyHeight - historyTextLines.length, 0);
  const blanks = Array.from({ length: padCount }, () => '');

  const margin = '  ';
  const inner = width - margin.length;
  const lines = [
    ...sessionBanner(session, width, color),
    ...blanks,
    ...historyTextLines,
    ...suggestions.map((suggestion) => `${margin}${suggestionLine(suggestion, inner, color)}`),
    `${margin}${statusLine(session, inner, color)}`,
    ...inputBox(session, width, color),
    footerLine(session, width, color)
  ];
  return lines.join('\n');
}

export function visibleHistoryEntries(session: TuiSession, maxLines: number): HistoryEntry[] {
  const entries = session.history as HistoryEntry[];
  const allLines = renderHistoryEntries(entries, { width: 88 });
  const maxOffset = Math.max(0, allLines.length - maxLines);
  session.scrollOffset = Math.min(Math.max(session.scrollOffset, 0), maxOffset);
  const end = entries.length - session.scrollOffset;
  const start = Math.max(0, end - maxLines);
  return entries.slice(start, end);
}

export function visibleHistoryLines(session: TuiSession, maxLines: number, width: number): Array<{ kind: RenderedLine['kind']; text: string }> {
  const allLines = renderHistoryEntries(session.history as HistoryEntry[], { width: Math.max(width - HISTORY_INDENT, 20) });
  const maxOffset = Math.max(0, allLines.length - maxLines);
  session.scrollOffset = Math.min(Math.max(session.scrollOffset, 0), maxOffset);
  const end = allLines.length - session.scrollOffset;
  const start = Math.max(0, end - maxLines);
  return allLines.slice(start, end).map((line) => ({ kind: line.kind, text: plainText(line.line) }));
}

export function historyEntryLines(entry: HistoryEntry, width: number, separate: boolean): Array<{ kind: RenderedLine['kind']; text: string }> {
  const rendered = renderHistoryEntries([entry], { width });
  const lines = rendered.map((line) => ({ kind: line.kind, text: plainText(line.line) }));
  return separate ? [{ kind: lines[0]?.kind ?? entry.kind, text: '' }, ...lines] : lines;
}

export function historyEntryStyled(entry: HistoryEntry, width: number, separate: boolean): RenderedLine[] {
  const rendered = renderHistoryEntries([entry], { width });
  return separate ? [{ kind: entry.kind, line: { segments: [{ text: '' }] } }, ...rendered] : rendered;
}

export function maxScrollOffset(session: TuiSession, maxLines = 8): number {
  const allLines = renderHistoryEntries(session.history as HistoryEntry[], { width: 88 });
  return Math.max(0, allLines.length - maxLines);
}

export function formatSettings(session: TuiSession): string {
  return [
    'Settings',
    `provider: ${session.provider}`,
    `model: ${session.runtime.model}`,
    `ollamaUrl: ${session.ollamaUrl ?? 'http://127.0.0.1:11434'}`,
    `lmStudioUrl: ${session.lmStudioUrl ?? 'http://127.0.0.1:1234'}`,
    `geminiApiBaseUrl: ${session.geminiApiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}`,
    `cwd: ${session.runtime.cwd}`,
    `maxTurns: ${formatMaxTurns(session.runtime.maxTurns)}`,
    `skills: ${session.runtime.skills.map((skill) => skill.name).join(', ') || 'none'}`,
    `history: ${session.history.length} entries`
  ].join('\n');
}

function formatMaxTurns(maxTurns: number | undefined): string {
  return maxTurns === undefined ? 'unlimited' : String(maxTurns);
}

export function inputPrompt(session: TuiSession): string {
  return `[${session.runtime.model}] > `;
}

function sessionBanner(session: TuiSession, width: number, color: boolean): string[] {
  const titleSegments: Array<{ text: string; style?: Style }> = [
    { text: `Gemma CLI v${cliVersion()}`, style: { token: 'roleHeader', bold: true } },
    { text: '  ', style: { token: 'muted' } },
    { text: modelDisplayName(session.runtime.model), style: { token: 'muted' } },
    { text: '  ·  ', style: { token: 'muted' } },
    { text: `${session.runtime.skills.length} skills`, style: { token: 'muted' } },
    { text: '  ·  ', style: { token: 'muted' } },
    { text: session.provider, style: { token: 'muted' } }
  ];
  return [renderStyledText(titleSegments, width, color)];
}

function applyScroll(rendered: RenderedLine[], session: TuiSession, maxLines: number, width: number, color: boolean): string[] {
  const maxOffset = Math.max(0, rendered.length - maxLines);
  session.scrollOffset = Math.min(Math.max(session.scrollOffset, 0), maxOffset);
  const end = rendered.length - session.scrollOffset;
  const start = Math.max(0, end - maxLines);
  return rendered.slice(start, end).map((line) => `  ${renderStyledText(line.line.segments, Math.max(width - 2, 1), color)}`);
}

function statusLine(session: TuiSession, width: number, color: boolean): string {
  const text = session.flash ?? session.lastStats ?? 'Ready.';
  return renderStyledText([{ text: clip(text, width), style: { token: 'muted' } }], width, color);
}

function inputBox(session: TuiSession, width: number, color: boolean): string[] {
  const innerWidth = Math.max(width - 4, 8);
  const buffer = session.inputBuffer && session.inputBuffer.length > 0
    ? clip(session.inputBuffer, innerWidth)
    : 'Send a message…';
  const segments: Array<{ text: string; style?: Style }> = [
    { text: '> ', style: { token: 'accent', bold: true } },
    { text: buffer, style: session.inputBuffer ? { token: 'codeText' } : { token: 'muted', italic: true } }
  ];
  const inner = renderStyledText(segments, innerWidth, color);
  return roundedBox(inner, width, color);
}

function footerLine(session: TuiSession, width: number, color: boolean): string {
  const cwd = session.runtime.cwd.replace(process.env.HOME ?? '', '~');
  const model = session.runtime.model;
  const context = contextLabel(session);
  const tokenRate = session.agentRunning && session.liveTokenRate ? tokenRateLabel(session.liveTokenRate) : undefined;
  const rightParts = [modelProfileLabel(model), model, context, tokenRate].filter((value): value is string => Boolean(value));
  const rightText = rightParts.join('  ·  ');
  const leftBudget = Math.max(width - rightText.length - 2, 8);
  const left = clip(cwd, leftBudget);
  const padding = ' '.repeat(Math.max(width - left.length - rightText.length, 1));
  const segments: Array<{ text: string; style?: Style }> = [{ text: `${left}${padding}`, style: { token: 'muted' } }];
  for (const [index, part] of rightParts.entries()) {
    if (index > 0) {
      segments.push({ text: '  ·  ', style: { token: 'muted' } });
    }
    segments.push({ text: part, style: footerPartStyle(part, context, tokenRate) });
  }
  return renderStyledText(segments, width, color);
}

function footerPartStyle(part: string, context: string, tokenRate: string | undefined): Style {
  if (part === context) {
    return { token: context === 'n/a' ? 'warning' : 'success', bold: context !== 'n/a' };
  }
  if (part === tokenRate) {
    return { token: 'warning', bold: true };
  }
  return { token: 'muted' };
}

function suggestionLine(suggestion: TuiCommand, width: number, color: boolean): string {
  const nameWidth = Math.min(28, Math.max(Math.floor(width * 0.32), 18));
  const detail = suggestion.parameters
    ? `${suggestion.description}  params: ${suggestion.parameters}`
    : suggestion.description;
  const segments = [
    { text: clip(suggestion.name, nameWidth - 1).padEnd(nameWidth, ' '), style: { token: 'accent' as const } },
    { text: ` ${clip(detail, Math.max(width - nameWidth - 2, 10))}`, style: { token: 'muted' as const } }
  ];
  return renderStyledText(segments, width, color);
}

function renderStyledText(segments: Array<{ text: string; style?: Style }>, width: number, color: boolean): string {
  const parts: string[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const remaining = Math.max(width - used, 0);
    const text = segment.text.length <= remaining ? segment.text : segment.text.slice(0, remaining);
    parts.push(styleToAnsi(text, segment.style, color));
    used += text.length;
  }
  return parts.join('');
}

function roundedBox(content: string, width: number, color: boolean): string[] {
  const innerWidth = Math.max(width - 2, 1);
  const top = styleToAnsi(`╭${'─'.repeat(innerWidth)}╮`, { token: 'codeBar' }, color);
  const bottom = styleToAnsi(`╰${'─'.repeat(innerWidth)}╯`, { token: 'codeBar' }, color);
  const plainLength = stripAnsi(content).length;
  const padded = `${content}${' '.repeat(Math.max(innerWidth - plainLength, 0))}`;
  const left = styleToAnsi('│', { token: 'codeBar' }, color);
  const right = styleToAnsi('│', { token: 'codeBar' }, color);
  return [top, `${left}${padded}${right}`, bottom];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function renderStyledLineToText(line: StyledLine, width: number, color: boolean): string {
  return renderStyledText(line.segments, width, color);
}

function contextLabel(session: TuiSession): string {
  const total = session.runtime.contextTokens;
  if (!total) {
    return 'n/a';
  }
  const systemTokens = session.runtime.systemPromptTokens ?? 0;
  const runtimeHistoryChars = (session.runtime.history ?? []).reduce((sum, message) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.type === 'text' ? part.text : `[${part.type}:${part.url}]`).join('\n');
    return sum + text.length;
  }, 0);
  const visibleHistoryChars = session.history.reduce((sum, entry) => sum + entry.text.length, 0);
  const usedTokens = systemTokens + Math.ceil(Math.max(runtimeHistoryChars, visibleHistoryChars) / 4);
  const percent = Math.max(1, Math.ceil((usedTokens / total) * 100));
  const loaded = session.runtime.loadedContextTokens;
  return `~${percent}% used (${formatContextTokens(loaded ?? total)})`;
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}k`;
  }
  if (tokens >= 1000 && tokens % 1000 === 0) {
    return `${tokens / 1000}k`;
  }
  return String(tokens);
}
