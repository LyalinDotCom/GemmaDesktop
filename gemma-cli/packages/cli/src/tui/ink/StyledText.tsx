import React from 'react';
import { Text } from 'ink';
import type { StyledLine, StyledSegment } from '../markdown/types.js';
import { styleToInk } from '../theme.js';

interface Props {
  line: StyledLine;
  prefix?: string;
}

export function StyledTextLine({ line, prefix }: Props): React.ReactElement {
  return (
    <Text>
      {prefix}
      {line.segments.map((segment, index) => (
        <SegmentText key={index} segment={segment} />
      ))}
    </Text>
  );
}

function SegmentText({ segment }: { segment: StyledSegment }): React.ReactElement {
  const props = styleToInk(segment.style);
  return <Text {...props}>{segment.text}</Text>;
}
