import { describe, expect, it } from 'vitest';
import { parseInline } from './inline.js';
import { renderBlock } from './block.js';
import { wrapStyled } from './wrapStyled.js';
import { highlight } from './syntax.js';
import { parseTable, renderTable } from './table.js';
import { plainText, type StyledLine, type StyledSegment } from './types.js';

function find(segments: StyledSegment[], text: string): StyledSegment | undefined {
  return segments.find((segment) => segment.text === text);
}

function flatten(lines: StyledLine[]): string[] {
  return lines.map((line) => plainText(line));
}

describe('parseInline', () => {
  it('marks **bold** as bold', () => {
    const segments = parseInline('a **strong** b');
    const strong = find(segments, 'strong');
    expect(strong?.style?.bold).toBe(true);
    expect(plainText(segments)).toBe('a strong b');
  });

  it('marks *emphasis* and _emphasis_ as italic', () => {
    expect(find(parseInline('one *italic* two'), 'italic')?.style?.italic).toBe(true);
    expect(find(parseInline('one _italic_ two'), 'italic')?.style?.italic).toBe(true);
  });

  it('marks `inline code` with the inlineCode token', () => {
    const segments = parseInline('use `npm test` here');
    expect(find(segments, 'npm test')?.style?.token).toBe('inlineCode');
  });

  it('renders [label](url) as a link plus url annotation', () => {
    const segments = parseInline('see [docs](https://example.com)');
    const label = find(segments, 'docs');
    expect(label?.style?.token).toBe('link');
    expect(label?.style?.underline).toBe(true);
    const annotation = segments.find((segment) => segment.text.includes('https://example.com'));
    expect(annotation?.style?.token).toBe('muted');
  });

  it('handles nested bold inside italic', () => {
    const segments = parseInline('*soft **hard** soft*');
    const both = segments.find((segment) => segment.text === 'hard');
    expect(both?.style?.italic).toBe(true);
    expect(both?.style?.bold).toBe(true);
  });

  it('preserves the base style on plain runs', () => {
    const segments = parseInline('plain', { token: 'roleAssistant' });
    expect(segments[0]?.style?.token).toBe('roleAssistant');
  });
});

describe('wrapStyled', () => {
  it('wraps at word boundaries while preserving styles', () => {
    const lines = wrapStyled([
      { text: 'alpha ' },
      { text: 'beta', style: { bold: true } },
      { text: ' gamma delta' }
    ], 12);
    expect(lines.length).toBeGreaterThan(1);
    const beta = lines.flatMap((line) => line.find((segment) => segment.text === 'beta'));
    expect(beta.find(Boolean)?.style?.bold).toBe(true);
  });

  it('keeps newlines as separate physical lines', () => {
    const lines = wrapStyled([{ text: 'one\ntwo' }], 80);
    expect(lines.map((line) => line.map((segment) => segment.text).join(''))).toEqual(['one', 'two']);
  });
});

describe('highlight', () => {
  it('marks JSON keys with the syntaxAttr token', () => {
    const segments = highlight('json', '{"name": 1}');
    expect(find(segments, '"name"')?.style?.token).toBe('syntaxAttr');
    expect(find(segments, '1')?.style?.token).toBe('syntaxNumber');
  });

  it('marks ts keywords and strings', () => {
    const segments = highlight('ts', "const x = 'hi'");
    expect(find(segments, 'const')?.style?.token).toBe('syntaxKeyword');
    const stringSegment = segments.find((segment) => segment.text.includes("'hi'"));
    expect(stringSegment?.style?.token).toBe('syntaxString');
  });

  it('marks diff add/del lines', () => {
    const segments = highlight('diff', '--- a\n+++ b\n-old\n+new');
    expect(segments.some((segment) => segment.style?.token === 'diffAdd' && segment.text.includes('+new'))).toBe(true);
    expect(segments.some((segment) => segment.style?.token === 'diffDel' && segment.text.includes('-old'))).toBe(true);
    expect(segments.some((segment) => segment.style?.token === 'diffMeta' && segment.text.includes('---'))).toBe(true);
  });

  it('falls back to plain code text for unknown languages', () => {
    const segments = highlight('mystery', 'plain');
    expect(segments[0]?.style?.token).toBe('codeText');
  });

  it('marks shell builtins and flags', () => {
    const segments = highlight('sh', 'npm test --watch');
    expect(find(segments, 'npm')?.style?.token).toBe('syntaxBuiltin');
    expect(find(segments, '--watch')?.style?.token).toBe('syntaxNumber');
  });
});

describe('parseTable', () => {
  it('detects header + alignment row + body', () => {
    const result = parseTable([
      '| Name | Age |',
      '| :--- | --: |',
      '| Bob  | 30  |',
      '| Sue  | 41  |'
    ], 0);
    expect(result?.consumed).toBe(4);
    expect(result?.table.header).toEqual(['Name', 'Age']);
    expect(result?.table.alignments).toEqual(['left', 'right']);
    expect(result?.table.rows).toEqual([['Bob', '30'], ['Sue', '41']]);
  });

  it('returns undefined when separator row is missing', () => {
    const result = parseTable(['| Name |', 'plain'], 0);
    expect(result).toBeUndefined();
  });
});

describe('renderTable', () => {
  it('produces header, separator, and aligned rows', () => {
    const lines = renderTable({
      header: ['Name', 'Age'],
      alignments: ['left', 'right'],
      rows: [['Bob', '30']]
    }, 40);
    const texts = flatten(lines);
    expect(texts[0]).toMatch(/Name\s+│\s+Age/);
    expect(texts[1]).toContain('─┼─');
    expect(texts[2]).toMatch(/Bob\s+│\s+30/);
  });
});

describe('renderBlock', () => {
  it('renders a heading with bold styling', () => {
    const lines = renderBlock('# Plan', { width: 40 });
    const planSegment = lines[0]?.segments.find((segment) => segment.text.includes('Plan'));
    expect(planSegment?.style?.bold).toBe(true);
  });

  it('renders unordered list bullets with accent token', () => {
    const lines = renderBlock('- one\n- two', { width: 40 });
    const bullet = lines[0]?.segments.find((segment) => segment.text.includes('• '));
    expect(bullet?.style?.token).toBe('accent');
    expect(plainText(lines[1]!)).toContain('• two');
  });

  it('renders ordered list numbers with accent token', () => {
    const lines = renderBlock('1. first\n2. second', { width: 40 });
    expect(lines[0]?.segments.find((segment) => segment.text.startsWith('1. '))?.style?.token).toBe('accent');
    expect(plainText(lines[1]!)).toContain('2. second');
  });

  it('renders code fences with header bar, body lines, and footer bar', () => {
    const lines = renderBlock('```ts\nconst x = 1\n```', { width: 40 });
    expect(plainText(lines[0]!)).toBe('┌─ ts');
    expect(plainText(lines[lines.length - 1]!)).toBe('└─');
    const body = lines.slice(1, -1);
    expect(body.length).toBeGreaterThan(0);
    const constSegment = body.flatMap((line) => line.segments).find((segment) => segment.text === 'const');
    expect(constSegment?.style?.token).toBe('syntaxKeyword');
  });

  it('renders quotes with italic muted style and a vertical bar', () => {
    const lines = renderBlock('> a quote', { width: 40 });
    const bar = lines[0]?.segments.find((segment) => segment.text === '│ ');
    expect(bar?.style?.token).toBe('codeBar');
    const body = lines[0]?.segments.find((segment) => segment.text.includes('a quote'));
    expect(body?.style?.italic).toBe(true);
  });

  it('renders horizontal rules', () => {
    const lines = renderBlock('---', { width: 8 });
    expect(plainText(lines[0]!)).toBe('────────');
  });

  it('renders a markdown table inline', () => {
    const lines = renderBlock('| Name | Age |\n| --- | --- |\n| Bob | 30 |', { width: 40 });
    const headerText = plainText(lines[0]!);
    expect(headerText).toContain('Name');
    expect(headerText).toContain('Age');
    expect(plainText(lines[2]!)).toContain('Bob');
  });

  it('renders bold inline inside paragraphs', () => {
    const lines = renderBlock('this is **strong** text', { width: 40 });
    const strong = lines[0]?.segments.find((segment) => segment.text === 'strong');
    expect(strong?.style?.bold).toBe(true);
  });
});
