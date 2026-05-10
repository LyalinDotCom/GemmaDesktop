import { describe, expect, it } from 'vitest';
import { renderHistoryEntry, renderHistoryEntries, HISTORY_INDENT } from './render.js';
import { plainText } from '../markdown/types.js';
import type { HistoryEntry } from './types.js';

describe('renderHistoryEntry', () => {
  it('renders assistant entries with no role label', () => {
    const entry: HistoryEntry = { kind: 'assistant', text: 'hello world' };
    const lines = renderHistoryEntry(entry, { width: 40, separate: false });
    const allText = lines.map((line) => plainText(line.line)).join('\n');
    expect(allText).not.toMatch(/gemma/i);
    expect(allText).toContain('hello world');
  });

  it('renders user entries with no role label but with magenta body styling', () => {
    const entry: HistoryEntry = { kind: 'user', text: 'tell me about TUIs' };
    const lines = renderHistoryEntry(entry, { width: 40, separate: false });
    const allText = lines.map((line) => plainText(line.line)).join('\n');
    expect(allText).not.toMatch(/\byou\b/);
    const bodySegments = lines.flatMap((line) => line.line.segments);
    const body = bodySegments.find((segment) => segment.text.includes('tell me about TUIs'));
    expect(body?.style?.token).toBe('roleUser');
  });

  it('indents the body by HISTORY_INDENT spaces', () => {
    const entry: HistoryEntry = { kind: 'assistant', text: 'hello' };
    const lines = renderHistoryEntry(entry, { width: 40, separate: false });
    const bodyLine = lines[0]?.line;
    expect(bodyLine?.segments[0]?.text).toBe(' '.repeat(HISTORY_INDENT));
    expect(plainText(bodyLine!).trimStart()).toBe('hello');
  });

  it('formats markdown bold inside assistant body', () => {
    const entry: HistoryEntry = { kind: 'assistant', text: 'this is **strong** text' };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const bodySegments = lines.flatMap((line) => line.line.segments);
    const strong = bodySegments.find((segment) => segment.text === 'strong');
    expect(strong?.style?.bold).toBe(true);
  });

  it('renders fenced code with syntax highlighting in assistant body', () => {
    const entry: HistoryEntry = { kind: 'assistant', text: '```ts\nconst x = 1\n```' };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const segments = lines.flatMap((line) => line.line.segments);
    const constSegment = segments.find((segment) => segment.text === 'const');
    expect(constSegment?.style?.token).toBe('syntaxKeyword');
    const xSegment = segments.find((segment) => segment.text === '1');
    expect(xSegment?.style?.token).toBe('syntaxNumber');
  });

  it('renders thinking entry body in italic with the muted thinking color', () => {
    const entry: HistoryEntry = { kind: 'thinking', text: 'reasoning about colors' };
    const lines = renderHistoryEntry(entry, { width: 40, separate: false });
    const bodySegment = lines[1]?.line.segments.find((segment) => segment.text.includes('reasoning'));
    expect(bodySegment?.style?.italic).toBe(true);
    expect(bodySegment?.style?.token).toBe('roleThinking');
    expect(bodySegment?.style?.dim).toBeFalsy();
  });

  it('renders a tool entry as a one-line summary by default', () => {
    const entry: HistoryEntry = { kind: 'tool', text: 'write_file app/index.html\nok\nbytes: 11' };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const header = plainText(lines[0]!.line);
    expect(header).toContain('⏺');
    expect(header).toContain('tool');
    expect(header).toContain('write_file app/index.html');
    expect(header).toContain('ok');
    const okSegment = lines[0]?.line.segments.find((segment) => segment.text === 'ok');
    expect(okSegment?.style?.token).toBe('success');
  });

  it('marks tool failure header in danger', () => {
    const entry: HistoryEntry = { kind: 'tool', text: 'edit_file foo\nfailed\nno match' };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const failedSegment = lines[0]?.line.segments.find((segment) => segment.text === 'failed');
    expect(failedSegment?.style?.token).toBe('danger');
  });

  it('renders steering notices in muted styling instead of danger', () => {
    const entry: HistoryEntry = {
      kind: 'notice',
      text: 'finalize_build\nnotice\nRun the command first, or mark validation blocked.'
    };
    const lines = renderHistoryEntry(entry, { width: 80, separate: false });
    const noticeSegment = lines[0]?.line.segments.find((segment) => segment.text.includes('notice'));
    const bodySegment = lines.flatMap((line) => line.line.segments).find((segment) => segment.text.includes('Run the command'));
    expect(noticeSegment?.style?.token).toBe('muted');
    expect(lines[0]?.line.segments.find((segment) => segment.text.includes('finalize_build'))?.style?.token).toBe('muted');
    expect(bodySegment?.style?.token).toBe('muted');
    expect(lines.flatMap((line) => line.line.segments).some((segment) => segment.style?.token === 'danger')).toBe(false);
  });

  it('renders the startup disclaimer as a yellow one-line notice', () => {
    const entry: HistoryEntry = {
      kind: 'disclaimer',
      text: 'Gemma CLI is an experimental fan project. Use at your own risk.'
    };
    const lines = renderHistoryEntry(entry, { width: 100, separate: false });
    const text = plainText(lines[0]!.line);
    const segments = lines[0]!.line.segments;

    expect(lines).toHaveLength(1);
    expect(text).toContain('notice');
    expect(text).toContain('Gemma CLI is an experimental fan project');
    expect(segments.find((segment) => segment.text.includes('notice'))?.style?.token).toBe('warning');
    expect(segments.find((segment) => segment.text.includes('Gemma CLI is an experimental fan project'))?.style?.token).toBe('warning');
  });

  it('collapses long tool output and shows hidden line count', () => {
    const body = ['ok', ...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)].join('\n');
    const entry: HistoryEntry = { kind: 'tool', text: `read_file foo.txt\n${body}` };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const hiddenLine = lines.find((line) => plainText(line.line).includes('+'));
    expect(plainText(hiddenLine!.line)).toContain('more line');
  });

  it('does not collapse command (slash output) entries even when long', () => {
    const body = ['Stats', ...Array.from({ length: 20 }, (_, index) => `field ${index + 1}: value`)].join('\n');
    const entry: HistoryEntry = { kind: 'command', text: body };
    const lines = renderHistoryEntry(entry, { width: 80, separate: false });
    const last = plainText(lines[lines.length - 1]!.line);
    expect(last).toContain('field 20: value');
    expect(lines.some((line) => plainText(line.line).includes('more line'))).toBe(false);
  });

  it('expands error history without collapsing', () => {
    const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const entry: HistoryEntry = { kind: 'error', text: `failure title\n${body}` };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const last = plainText(lines[lines.length - 1]!.line);
    expect(last).toContain('line 12');
  });

  it('highlights shell command body with $ prefix', () => {
    const entry: HistoryEntry = { kind: 'command', text: '$ npm test\n$ npm test\nrunning tests' };
    const lines = renderHistoryEntry(entry, { width: 60, separate: false });
    const dollarSegment = lines.flatMap((line) => line.line.segments).find((segment) => segment.text === '$ ');
    expect(dollarSegment?.style?.bold).toBe(true);
  });
});

describe('renderHistoryEntries', () => {
  it('separates entries after the first one with a blank line', () => {
    const lines = renderHistoryEntries([
      { kind: 'user', text: 'a' },
      { kind: 'assistant', text: 'b' }
    ], { width: 40 });
    const blankIndex = lines.findIndex((line, index) => index > 0 && plainText(line.line) === '');
    expect(blankIndex).toBeGreaterThan(0);
  });
});
