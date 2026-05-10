import React from 'react';
import { Box, Text } from 'ink';
import { cliVersion } from '../../version.js';
import { modelDisplayName } from '../modelDisplayName.js';

interface Props {
  model: string;
  provider: string;
  skills: number;
}

export function Banner({ model, provider, skills }: Props): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text bold color="whiteBright">{`Gemma CLI v${cliVersion()} `}</Text>
      <Text dimColor>{`${modelDisplayName(model)}  ·  ${skills} skill${skills === 1 ? '' : 's'}  ·  ${provider}`}</Text>
    </Box>
  );
}
