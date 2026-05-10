import { describe, expect, it } from 'vitest';
import { formatExitMessage, formatExitMessageAt } from './index.js';
import type { TuiSession } from '../../tui.js';

function sessionWith(sessionId?: string, sessionStartedAt?: number): TuiSession {
  return {
    sessionStartedAt,
    diagnostics: sessionId ? { session: { id: sessionId } } : undefined
  } as unknown as TuiSession;
}

describe('formatExitMessage', () => {
  it('shows the resume command and session id when diagnostics are present', () => {
    const text = formatExitMessage(sessionWith('20260503T010203Z-abc'), false);
    expect(text).toContain('Session saved: 20260503T010203Z-abc');
    expect(text).toContain('gemma --resume 20260503T010203Z-abc');
    expect(text).toMatch(/most recent session/);
  });

  it('falls back to a no-session message when diagnostics absent', () => {
    expect(formatExitMessage(sessionWith(), false)).toMatch(/No diagnostic session/);
  });

  it('shows wall-clock session duration when the session start time is available', () => {
    const text = formatExitMessageAt(sessionWith('id', 1_000), false, 3_724_000);
    expect(text).toContain('Session duration: 1h 2m 3s');
    expect(text).toContain('Session saved: id');
  });

  it('starts with a blank line so the message stands apart from the cleared TUI', () => {
    expect(formatExitMessage(sessionWith('id'), false).startsWith('\n')).toBe(true);
  });

  it('ends with a trailing blank line so the next shell prompt has breathing room', () => {
    expect(formatExitMessage(sessionWith('id'), false)).toMatch(/\n\n$/);
  });

  it('emits ANSI color codes by default (and none when color=false)', () => {
    const colored = formatExitMessage(sessionWith('id'));
    const plain = formatExitMessage(sessionWith('id'), false);
    expect(colored).toContain('\x1b[');
    expect(plain).not.toContain('\x1b[');
  });
});
