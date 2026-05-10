import React from 'react';
import { Box, Static } from 'ink';
import { historyEntryStyled } from '../frame.js';
import type { TuiSession } from '../../tui.js';
import type { HistoryEntry } from '../history/types.js';
import type { RenderedLine } from '../history/types.js';
import { StyledTextLine } from './StyledText.js';
import { cliVersion } from '../../version.js';
import { modelDisplayName } from '../modelDisplayName.js';

interface StaticItem {
  id: string;
  line: RenderedLine;
}

interface Props {
  session: TuiSession;
  width: number;
  height?: number;
  redrawTick: number;
  staticKey?: number;
}

export function StaticHistory({ session, width, height, redrawTick, staticKey = 0 }: Props): React.ReactElement {
  void redrawTick;
  void height;
  const { staticItems, liveItems } = buildStaticHistoryState(session, width);

  return (
    <>
      <Static key={staticHistoryRenderKey(session, staticKey)} items={staticItems}>
        {(item) => <HistoryLine key={item.id} item={item} />}
      </Static>
      {liveItems.length > 0 && (
        <Box flexDirection="column">
          {liveItems.map((item) => <HistoryLine key={item.id} item={item} />)}
        </Box>
      )}
    </>
  );
}

export function staticHistoryRenderKey(session: TuiSession, staticKey = 0): string {
  return `static-history-${session.historyRevision ?? 0}:${staticKey}`;
}

export function didClearHistory(session: TuiSession, previousLength: number, emittedCount: number): boolean {
  if (session.history.length === 0 && (previousLength > 0 || emittedCount > 0)) {
    return true;
  }
  return session.history.length < previousLength;
}

export function buildStaticHistoryItems(session: TuiSession, width: number, height?: number): StaticItem[] {
  void height;
  return buildStaticHistoryState(session, width).staticItems;
}

export function buildStaticHistoryState(session: TuiSession, width: number): { staticItems: StaticItem[]; liveItems: StaticItem[] } {
  const header: StaticItem[] = [];
  const revision = session.historyRevision ?? 0;
  header.push({ id: `header:${revision}:banner`, line: bannerLine(session) });
  header.push({ id: `header:${revision}:divider`, line: { kind: 'header', line: dividerLine(width) } });
  header.push({ id: `header:${revision}:spacer`, line: { kind: 'header', line: { segments: [{ text: '' }] } } });

  const stableCount = stableHistoryCount(session.history);
  const staticHistory = buildHistoryItems(session, width, 0, stableCount);
  const liveItems = buildHistoryItems(session, width, stableCount, session.history.length);

  return {
    staticItems: [...header, ...staticHistory],
    liveItems
  };
}

function buildHistoryItems(session: TuiSession, width: number, startIndex: number, endIndex: number): StaticItem[] {
  const history: StaticItem[] = [];
  const revision = session.historyRevision ?? 0;
  const contentWidth = Math.max(width - 2, 20);
  let lastUserKind: string | undefined = startIndex > 0 ? session.history[startIndex - 1]?.kind : undefined;
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = session.history[index];
    if (!entry) continue;
    const isNewTurn = entry.kind === 'user' && lastUserKind !== undefined;
    if (isNewTurn) {
      history.push({ id: `history:${revision}:${index}:turn-divider`, line: { kind: entry.kind, line: dividerLine(width) } });
    }
    const separate = !isNewTurn && index > 0;
    const lines = historyEntryStyled(entry, contentWidth, separate);
    for (const [lineIndex, line] of lines.entries()) {
      history.push({ id: `history:${revision}:${index}:${lineIndex}`, line });
    }
    lastUserKind = entry.kind;
  }
  return history;
}

function stableHistoryCount(history: HistoryEntry[]): number {
  const firstPending = history.findIndex((entry) => entry.meta?.pending === true);
  return firstPending === -1 ? history.length : firstPending;
}

function HistoryLine({ item }: { item: StaticItem }): React.ReactElement {
  return (
    <StyledTextLine
      prefix={item.line.kind === 'header' ? '' : '  '}
      line={item.line.line.segments.length === 0 || (item.line.line.segments.length === 1 && item.line.line.segments[0]!.text === '')
        ? { segments: [{ text: ' ' }] }
        : item.line.line}
    />
  );
}

function bannerLine(session: TuiSession): RenderedLine {
  return {
    kind: 'header',
    line: {
      segments: [
        { text: `Gemma CLI v${cliVersion()} `, style: { token: 'roleHeader', bold: true } },
        { text: `${modelDisplayName(session.runtime.model)}  ·  ${session.runtime.skills.length} skill${session.runtime.skills.length === 1 ? '' : 's'}  ·  ${session.provider}`, style: { token: 'muted' } }
      ]
    }
  };
}

function dividerLine(width: number): { segments: { text: string; style: { token: 'codeBar'; dim: true } }[] } {
  return {
    segments: [{ text: '─'.repeat(Math.max(width, 8)), style: { token: 'codeBar' as const, dim: true } }]
  };
}
