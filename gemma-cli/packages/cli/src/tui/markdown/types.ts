import type { Style } from '../theme.js';

export interface StyledSegment {
  text: string;
  style?: Style;
}

export interface StyledLine {
  segments: StyledSegment[];
}

export function plainText(line: StyledLine | StyledSegment[]): string {
  const segments = Array.isArray(line) ? line : line.segments;
  return segments.map((segment) => segment.text).join('');
}

export function emptyLine(): StyledLine {
  return { segments: [{ text: '' }] };
}
