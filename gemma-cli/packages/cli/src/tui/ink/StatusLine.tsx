import React from 'react';
import { Text } from 'ink';
import { clip } from '../text/clip.js';
import { spinnerFrame } from './spinner.js';

interface Props {
  busy: boolean;
  flash?: string;
  lastStats?: string;
  activity?: string;
  elapsedMs?: number;
  spinnerIndex: number;
  width: number;
}

export function StatusLine({ busy, flash, lastStats, activity, elapsedMs, spinnerIndex, width }: Props): React.ReactElement {
  const innerWidth = Math.max(width - 2, 8);
  if (busy) {
    const label = activity ?? 'working';
    const elapsed = elapsedMs === undefined ? '' : ` · ${formatElapsed(elapsedMs)}`;
    const hint = ' · esc to cancel';
    const text = ` ${label}${elapsed}${hint}`;
    const trimmed = clip(text, Math.max(innerWidth - 2, 8));
    return (
      <Text>
        <Text>{'  '}</Text>
        <Text color="cyanBright">{spinnerFrame(spinnerIndex)}</Text>
        <Text dimColor>{trimmed}</Text>
      </Text>
    );
  }
  const text = flash ?? lastStats ?? 'Ready.';
  return (
    <Text dimColor>
      <Text>{'  '}</Text>
      {clip(text, innerWidth)}
    </Text>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
