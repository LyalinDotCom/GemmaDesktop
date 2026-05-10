import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../text/clip.js';
import type { TuiCommand } from '../../tui.js';

interface Props {
  suggestions: TuiCommand[];
  width: number;
}

export function Suggestions({ suggestions, width }: Props): React.ReactElement | null {
  if (suggestions.length === 0) return null;
  const innerWidth = Math.max(width - 2, 10);
  const nameWidth = Math.min(28, Math.max(Math.floor(innerWidth * 0.32), 18));
  return (
    <Box flexDirection="column">
      {suggestions.map((suggestion) => (
        <Text key={suggestion.name}>
          <Text>{'  '}</Text>
          <Text color="magentaBright">{clip(suggestion.name, nameWidth - 1).padEnd(nameWidth, ' ')}</Text>
          <Text dimColor>
            {' '}
            {clip(detailFor(suggestion), Math.max(innerWidth - nameWidth - 2, 10))}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function detailFor(suggestion: TuiCommand): string {
  return suggestion.parameters
    ? `${suggestion.description}  params: ${suggestion.parameters}`
    : suggestion.description;
}
