import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../text/clip.js';
import type { WorkspacePermissionRequest } from '@gemma-sdk/agent';

interface Props {
  request: WorkspacePermissionRequest;
  width: number;
}

export interface PermissionPanelLayout {
  title: string;
  tool: string;
  workspace: string;
  reason: string;
  paths: string;
  prompt: string;
}

export function permissionPanelLayout(request: WorkspacePermissionRequest, width: number): PermissionPanelLayout {
  const innerWidth = Math.max(width - 8, 24);
  const pathText = request.paths.length > 0 ? request.paths.join(', ') : request.workspace;
  return {
    title: clip('ACTION REQUIRED: outside-workspace access', innerWidth),
    tool: clip(`Tool: ${request.tool}`, innerWidth),
    workspace: clip(`Workspace: ${request.workspace}`, innerWidth),
    reason: clip(`Reason: ${request.reason}`, innerWidth),
    paths: clip(`Path: ${pathText}`, innerWidth),
    prompt: clip('[Y] Allow once    [N/Esc/Enter] Deny', innerWidth)
  };
}

export function PermissionPanel({ request, width }: Props): React.ReactElement {
  const layout = permissionPanelLayout(request, width);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="redBright" paddingX={2} paddingY={1}>
      <Text>
        <Text backgroundColor="yellowBright" color="black" bold>{` ${layout.title} `}</Text>
      </Text>
      <Text color="whiteBright" bold>{layout.tool}</Text>
      <Text dimColor>{layout.workspace}</Text>
      <Text color="yellowBright">{layout.reason}</Text>
      <Text color="cyanBright">{layout.paths}</Text>
      <Text>
        <Text backgroundColor="green" color="black" bold> Y </Text>
        <Text bold> Allow once   </Text>
        <Text backgroundColor="red" color="whiteBright" bold> N </Text>
        <Text bold> Deny </Text>
        <Text dimColor>  Esc/Enter denies</Text>
      </Text>
    </Box>
  );
}
