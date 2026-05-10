import React from 'react';
import type { StyledSegment } from '../markdown/types.js';
import { StyledTextLine } from './StyledText.js';
import { thinkingSnippet } from './streamPrompt.js';

interface Props {
  text: string;
  width: number;
}

const PREFIX = '  ◌ ';
const BASE_STYLE = { token: 'roleThinking' as const, italic: true };
const KEYWORD_RE = /\b(?:analyze|analysis|build|check|command|edit|error|file|final|fix|inspect|next|patch|plan|read|result|run|test|tool|validate|validation|verify|write)\b/i;

export function ThinkingPreview({ text, width }: Props): React.ReactElement {
  return <StyledTextLine line={{ segments: thinkingPreviewSegments(text, width) }} />;
}

export function thinkingPreviewSegments(text: string, width: number): StyledSegment[] {
  const bodyWidth = Math.max(width - PREFIX.length, 1);
  const snippet = thinkingSnippet(text, bodyWidth);
  return [
    { text: PREFIX, style: { token: 'roleThinking', bold: true } },
    ...highlightThinkingSnippet(snippet)
  ];
}

function highlightThinkingSnippet(text: string): StyledSegment[] {
  const out: StyledSegment[] = [];
  const tokenRe = /`[^`]*`|"[^"]*"|\b\d+[.)]|\b[\w-]+\b|\s+|./g;
  for (const match of text.matchAll(tokenRe)) {
    const token = match[0];
    if (/^`[^`]*`$/.test(token) || /^"[^"]*"$/.test(token)) {
      out.push({ text: token, style: { token: 'inlineCode' } });
    } else if (/^\b\d+[.)]$/.test(token)) {
      out.push({ text: token, style: { token: 'accent', bold: true } });
    } else if (/^(?:error|failed|failure|bug|missing)$/i.test(token)) {
      out.push({ text: token, style: { token: 'danger', bold: true } });
    } else if (KEYWORD_RE.test(token)) {
      out.push({ text: token, style: { token: 'info', bold: true, italic: true } });
    } else {
      out.push({ text: token, style: BASE_STYLE });
    }
  }
  return mergeSegments(out);
}

function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
  const out: StyledSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, segment.style)) {
      last.text += segment.text;
    } else {
      out.push(segment);
    }
  }
  return out;
}

function sameStyle(a: StyledSegment['style'], b: StyledSegment['style']): boolean {
  return a?.token === b?.token
    && Boolean(a?.bold) === Boolean(b?.bold)
    && Boolean(a?.italic) === Boolean(b?.italic)
    && Boolean(a?.underline) === Boolean(b?.underline)
    && Boolean(a?.inverse) === Boolean(b?.inverse)
    && Boolean(a?.dim) === Boolean(b?.dim);
}
