import { describe, expect, it } from 'vitest';
import { buildStaticHistoryItems, buildStaticHistoryState, didClearHistory, staticHistoryRenderKey } from './StaticHistory.js';
import type { TuiSession } from '../../tui.js';
import { cliVersion } from '../../version.js';

function sessionWith(historyLength: number): TuiSession {
  return {
    provider: 'lmstudio',
    runtime: { model: 'gemma-4-31b-it-mlx', skills: [] },
    history: Array.from({ length: historyLength }, () => ({ kind: 'assistant' as const, text: 'x' })),
    scrollOffset: 0
  } as unknown as TuiSession;
}

describe('didClearHistory', () => {
  it('returns true when history empties and we had emitted items', () => {
    expect(didClearHistory(sessionWith(0), 5, 12)).toBe(true);
  });

  it('returns true when history shrinks below previous length', () => {
    expect(didClearHistory(sessionWith(2), 5, 12)).toBe(true);
  });

  it('returns false when history grows', () => {
    expect(didClearHistory(sessionWith(7), 5, 12)).toBe(false);
  });

  it('returns false when history stays the same', () => {
    expect(didClearHistory(sessionWith(5), 5, 12)).toBe(false);
  });

  it('returns false on initial state with empty history and no emitted lines', () => {
    expect(didClearHistory(sessionWith(0), 0, 0)).toBe(false);
  });
});

describe('buildStaticHistoryItems', () => {
  it('shows the CLI version in the banner', () => {
    const items = buildStaticHistoryItems(sessionWith(0), 80);

    expect(items.some((item) => lineText(item).includes(`Gemma CLI v${cliVersion()}`))).toBe(true);
  });

  it('gives appended assistant output unique item ids after a user prompt', () => {
    const session = sessionWith(0);
    session.history = [{ kind: 'user', text: 'hello' }];

    const before = buildStaticHistoryItems(session, 80);
    session.history.push({ kind: 'assistant', text: 'Hello! How can I help?' });
    const after = buildStaticHistoryItems(session, 80);
    const beforeIds = new Set(before.map((item) => item.id));
    const newItems = after.filter((item) => !beforeIds.has(item.id));

    expect(newItems.map((item) => item.id)).toContain('history:0:1:1');
    expect(newItems.some((item) => lineText(item).includes('Hello! How can I help?'))).toBe(true);
    expect(new Set(after.map((item) => item.id)).size).toBe(after.length);
  });

  it('scopes static item ids by clear revision', () => {
    const session = sessionWith(0);
    session.historyRevision = 3;
    session.history = [{ kind: 'user', text: 'after clear' }];

    expect(buildStaticHistoryItems(session, 80).map((item) => item.id)).toContain('history:3:0:0');
  });

  it('keeps completed history static instead of clipping it to the live viewport', () => {
    const session = sessionWith(0);
    session.history = [
      { kind: 'user', text: 'one' },
      { kind: 'assistant', text: 'two' },
      { kind: 'user', text: 'three' },
      { kind: 'assistant', text: 'four' }
    ];

    const items = buildStaticHistoryItems(session, 80, 6);

    expect(items.length).toBeGreaterThan(6);
    expect(items.some((item) => lineText(item).includes('one'))).toBe(true);
    expect(items.some((item) => lineText(item).includes('four'))).toBe(true);
  });

  it('keeps a completed assistant answer visible in the transcript viewport', () => {
    const session = sessionWith(0);
    session.history = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: "Hello! I'm Gemma CLI. How can I help you with your project today?" }
    ];

    const items = buildStaticHistoryItems(session, 80, 10);

    expect(items.some((item) => lineText(item).includes("Hello! I'm Gemma CLI"))).toBe(true);
  });

  it('keeps pending tool starts live until their final result is known', () => {
    const session = sessionWith(0);
    session.history = [
      { kind: 'user', text: 'build' },
      { kind: 'tool', text: 'exec_command npm test\nrunning', meta: { pending: true } },
      { kind: 'assistant', text: 'waiting' }
    ];

    const state = buildStaticHistoryState(session, 80);

    expect(state.staticItems.some((item) => lineText(item).includes('build'))).toBe(true);
    expect(state.staticItems.some((item) => lineText(item).includes('exec_command'))).toBe(false);
    expect(state.liveItems.some((item) => lineText(item).includes('exec_command'))).toBe(true);
    expect(state.liveItems.some((item) => lineText(item).includes('waiting'))).toBe(true);
  });

  it('moves a completed tool result into static history after pending clears', () => {
    const session = sessionWith(0);
    session.history = [
      { kind: 'user', text: 'build' },
      { kind: 'tool', text: 'exec_command npm test\nok\npassed' }
    ];

    const state = buildStaticHistoryState(session, 80);

    expect(state.staticItems.some((item) => lineText(item).includes('exec_command'))).toBe(true);
    expect(state.liveItems).toHaveLength(0);
  });
});

describe('staticHistoryRenderKey', () => {
  it('changes when clear revision or terminal refresh key changes', () => {
    const session = sessionWith(0);

    expect(staticHistoryRenderKey(session, 0)).toBe('static-history-0:0');
    expect(staticHistoryRenderKey(session, 1)).toBe('static-history-0:1');

    session.historyRevision = 2;
    expect(staticHistoryRenderKey(session, 1)).toBe('static-history-2:1');
  });
});

function lineText(item: ReturnType<typeof buildStaticHistoryItems>[number]): string {
  return item.line.line.segments.map((segment) => segment.text).join('');
}
