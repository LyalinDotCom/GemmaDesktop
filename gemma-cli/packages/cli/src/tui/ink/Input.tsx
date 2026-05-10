import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  value: string;
  cursor: number;
  width: number;
}

export function Input({ value, cursor, width }: Props): React.ReactElement {
  const viewport = inputViewport(value, cursor, Math.max(width - 6, 8));
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} width={width} flexDirection="column">
      {viewport.placeholder ? (
        <Text>
          <Text color="magentaBright" bold>{'> '}</Text>
          <Text dimColor italic>{viewport.text}</Text>
        </Text>
      ) : viewport.visibleLines.map((line, index) => (
        <Text key={`${viewport.visibleStart}:${index}`}>
          <Text color="magentaBright" bold>{index === 0 ? '> ' : '  '}</Text>
          <InputText
            line={line}
            cursorOffset={index === viewport.visibleCursorLine ? viewport.cursorOffset : undefined}
          />
        </Text>
      ))}
    </Box>
  );
}

function InputText({ line, cursorOffset }: { line: string; cursorOffset?: number }): React.ReactElement {
  if (cursorOffset === undefined) {
    return <Text color="whiteBright">{line}</Text>;
  }
  const before = line.slice(0, cursorOffset);
  const at = line[cursorOffset] ?? ' ';
  const after = line.slice(cursorOffset + 1);
  return (
    <>
      <Text color="whiteBright">{before}</Text>
      <Text inverse>{at}</Text>
      <Text color="whiteBright">{after}</Text>
    </>
  );
}

export interface InputViewport {
  text: string;
  visibleLines: string[];
  visibleStart: number;
  visibleCursorLine: number;
  cursorOffset: number;
  lineIndex: number;
  lineCount: number;
  placeholder: boolean;
}

interface WrappedInputLine {
  text: string;
  start: number;
  end: number;
}

export function inputViewport(value: string, cursor: number, width: number, maxVisibleLines = 5): InputViewport {
  const safeWidth = Math.max(width, 1);
  const safeVisibleLines = Math.max(1, maxVisibleLines);
  if (!value) {
    return {
      text: 'Send a message…',
      visibleLines: ['Send a message…'],
      visibleStart: 0,
      visibleCursorLine: 0,
      cursorOffset: 0,
      lineIndex: 0,
      lineCount: 1,
      placeholder: true
    };
  }
  const lines = wrapInput(value, safeWidth);
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const lineIndex = lineIndexForCursor(lines, safeCursor);
  const line = lines[lineIndex] ?? { text: '', start: safeCursor, end: safeCursor };
  const visibleCount = Math.min(lines.length, safeVisibleLines);
  const visibleStart = Math.min(Math.max(0, lineIndex - visibleCount + 1), Math.max(lines.length - visibleCount, 0));
  return {
    text: line.text,
    visibleLines: lines.slice(visibleStart, visibleStart + visibleCount).map((item) => item.text),
    visibleStart,
    visibleCursorLine: lineIndex - visibleStart,
    cursorOffset: Math.max(0, Math.min(safeCursor - line.start, line.text.length)),
    lineIndex,
    lineCount: lines.length,
    placeholder: false
  };
}

function wrapInput(value: string, width: number): WrappedInputLine[] {
  const safeWidth = Math.max(width, 1);
  const lines: WrappedInputLine[] = [];
  let offset = 0;
  const logicalLines = value.split('\n');
  for (const logicalLine of logicalLines) {
    if (logicalLine.length === 0) {
      lines.push({ text: '', start: offset, end: offset });
    } else {
      for (let localStart = 0; localStart < logicalLine.length; localStart += safeWidth) {
        const localEnd = Math.min(localStart + safeWidth, logicalLine.length);
        lines.push({
          text: logicalLine.slice(localStart, localEnd),
          start: offset + localStart,
          end: offset + localEnd
        });
      }
      if (logicalLine.length % safeWidth === 0) {
        lines.push({ text: '', start: offset + logicalLine.length, end: offset + logicalLine.length });
      }
    }
    offset += logicalLine.length + 1;
  }
  return lines;
}

function lineIndexForCursor(lines: WrappedInputLine[], cursor: number): number {
  const startingLine = lines.findIndex((line, index) => index > 0 && line.start === cursor);
  if (startingLine !== -1) {
    return startingLine;
  }
  const exactBlank = lines.findIndex((line) => line.start === cursor && line.end === cursor);
  if (exactBlank !== -1) {
    return exactBlank;
  }
  const index = lines.findIndex((line) => cursor >= line.start && cursor <= line.end);
  return index === -1 ? Math.max(lines.length - 1, 0) : index;
}
