import { describe, expect, it } from 'vitest';
import { renderFileChangeEntry, renderChangeHeader } from './fileChange.js';
import { renderHistoryEntry } from './render.js';
import { plainText } from '../markdown/types.js';
import type { HistoryEntry } from './types.js';
import type { FileChangeMeta } from 'gemma-cli-core';

describe('renderChangeHeader', () => {
  it('renders a created header in success color with line count', () => {
    const header = renderChangeHeader({ path: 'foo.txt', status: 'created', linesAdded: 12 });
    const segments = header.segments;
    const label = segments.find((s) => s.text === 'created');
    expect(label?.style?.token).toBe('success');
    expect(label?.style?.bold).toBe(true);
    expect(plainText(header)).toContain('foo.txt');
    expect(plainText(header)).toContain('(+12)');
  });

  it('renders an updated header in info color with +/- stats', () => {
    const header = renderChangeHeader({ path: 'agent.ts', status: 'updated', linesAdded: 50, linesRemoved: 6 });
    const label = header.segments.find((s) => s.text === 'edited');
    expect(label?.style?.token).toBe('info');
    expect(plainText(header)).toMatch(/\(\+50 -6\)/);
  });

  it('renders a deleted header in danger color', () => {
    const header = renderChangeHeader({ path: 'old.txt', status: 'deleted' });
    const label = header.segments.find((s) => s.text === 'deleted');
    expect(label?.style?.token).toBe('danger');
  });

  it('renders an overwritten header in warning color', () => {
    const header = renderChangeHeader({ path: 'config.json', status: 'overwritten', linesAdded: 5, linesRemoved: 5 });
    const label = header.segments.find((s) => s.text === 'overwrote');
    expect(label?.style?.token).toBe('warning');
  });

  it('shows old path when renamed', () => {
    const header = renderChangeHeader({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' });
    expect(plainText(header)).toContain('new.txt');
    expect(plainText(header)).toContain('old.txt');
  });
});

describe('renderFileChangeEntry', () => {
  function entry(meta: FileChangeMeta, kind: HistoryEntry['kind'] = 'tool'): HistoryEntry {
    return { kind, text: 'tool body', meta: { fileChange: meta } };
  }
  const opts = { width: 80, separate: false };
  function render(meta: FileChangeMeta) {
    return renderFileChangeEntry(entry(meta), meta, opts);
  }

  it('renders a created file with green +-prefixed preview lines', () => {
    const lines = render({
      tool: 'write_file',
      changes: [{
        path: 'starship.txt',
        status: 'created',
        linesAdded: 2,
        preview: 'Beyond the stars\nWhere captains roam'
      }]
    });

    const allText = lines.map((l) => plainText(l.line)).join('\n');
    expect(allText).toContain('starship.txt');
    expect(allText).toMatch(/\+\s+Beyond the stars/);
    expect(allText).toMatch(/\+\s+Where captains roam/);
    const greenSegs = lines.flatMap((l) => l.line.segments).filter((s) => s.style?.token === 'diffAdd');
    expect(greenSegs.length).toBeGreaterThan(0);
  });

  it('truncates preview with "+ N more lines" when over budget', () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const lines = render({
      tool: 'write_file',
      changes: [{ path: 'big.txt', status: 'created', linesAdded: 30, preview: longContent }]
    });
    const last = plainText(lines[lines.length - 1]!.line);
    expect(last).toMatch(/\+\d+ more lines?/);
  });

  it('renders an edit hunk with both - and + lines colored', () => {
    const lines = render({
      tool: 'edit_file',
      changes: [{
        path: 'agent.ts',
        status: 'updated',
        linesAdded: 1,
        linesRemoved: 1,
        hunks: [{ oldStart: 10, newStart: 10, oldLines: ['  const old = true'], newLines: ['  const old = false'] }]
      }]
    });

    const allText = lines.map((l) => plainText(l.line)).join('\n');
    expect(allText).toMatch(/-\s+const old = true/);
    expect(allText).toMatch(/\+\s+const old = false/);
    const segs = lines.flatMap((l) => l.line.segments);
    expect(segs.some((s) => s.style?.token === 'diffDel')).toBe(true);
    expect(segs.some((s) => s.style?.token === 'diffAdd')).toBe(true);
  });

  it('renders a deleted file with header only and no body', () => {
    const lines = render({
      tool: 'apply_patch',
      changes: [{ path: 'old.txt', status: 'deleted' }]
    });
    expect(lines).toHaveLength(1);
    expect(plainText(lines[0]!.line)).toContain('deleted');
    expect(plainText(lines[0]!.line)).toContain('old.txt');
  });

  it('renders multiple files in one entry separated by blank lines', () => {
    const lines = render({
      tool: 'apply_patch',
      changes: [
        { path: 'a.ts', status: 'created', linesAdded: 1, preview: 'one' },
        { path: 'b.ts', status: 'updated', linesAdded: 1, linesRemoved: 1, hunks: [{ oldStart: 1, newStart: 1, oldLines: ['x'], newLines: ['y'] }] }
      ]
    });
    const allText = lines.map((l) => plainText(l.line)).join('\n');
    expect(allText).toContain('a.ts');
    expect(allText).toContain('b.ts');
  });
});

describe('renderHistoryEntry dispatch', () => {
  it('routes entries with fileChange meta to the diff renderer (no ⏺ tool header)', () => {
    const lines = renderHistoryEntry({
      kind: 'tool',
      text: 'write_file foo.txt\nok\nwrote and reread foo.txt (3 bytes)',
      meta: { fileChange: { tool: 'write_file', changes: [{ path: 'foo.txt', status: 'created', linesAdded: 1, preview: 'hi\n' }] } }
    }, { width: 80, separate: false });
    const allText = lines.map((l) => plainText(l.line)).join('\n');
    expect(allText).toContain('created');
    expect(allText).toContain('foo.txt');
    expect(allText).not.toContain('⏺ tool');
  });

  it('falls back to tool entry rendering when no fileChange meta', () => {
    const lines = renderHistoryEntry({
      kind: 'tool',
      text: 'list_tree .\nok\nfile listing'
    }, { width: 80, separate: false });
    const allText = lines.map((l) => plainText(l.line)).join('\n');
    expect(allText).toContain('⏺ tool');
  });
});
