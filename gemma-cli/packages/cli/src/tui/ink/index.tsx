import React from 'react';
import { render as renderInk } from 'ink';
import { App } from './App.js';
import type { TuiSession } from '../../tui.js';
import { formatDuration } from '../duration.js';

export async function runInkTui(session: TuiSession, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<void> {
  const app = renderInk(<App session={session} inputStream={input} output={output} />, {
    stdin: input,
    stdout: output as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false
  });

  try {
    await app.waitUntilExit();
  } catch (error) {
    output.write(formatExitMessage(session));
    throw error;
  }
  output.write(formatExitMessage(session));
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  boldCyan: '\x1b[1;36m',
  boldGreen: '\x1b[1;32m',
  boldYellow: '\x1b[1;33m'
};

export function formatExitMessage(session: TuiSession, color = true): string {
  return formatExitMessageAt(session, color, Date.now());
}

export function formatExitMessageAt(session: TuiSession, color = true, now = Date.now()): string {
  const sessionId = session.diagnostics?.session?.id;
  const c = color ? ANSI : { reset: '', dim: '', boldCyan: '', boldGreen: '', boldYellow: '' };
  const lines: string[] = [''];
  if (session.sessionStartedAt !== undefined) {
    lines.push(`${c.dim}Session duration:${c.reset} ${formatDuration(now - session.sessionStartedAt)}`);
  }
  if (sessionId) {
    lines.push(`${c.dim}Session saved:${c.reset} ${c.boldCyan}${sessionId}${c.reset}`);
    lines.push(`${c.dim}Resume with: ${c.reset}${c.boldGreen}gemma --resume ${sessionId}${c.reset}`);
    lines.push(`${c.dim}Or:          ${c.reset}${c.boldGreen}gemma --resume${c.reset}          ${c.dim}(most recent session)${c.reset}`);
  } else {
    lines.push(`${c.boldYellow}No diagnostic session was recorded for this run.${c.reset}`);
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}
