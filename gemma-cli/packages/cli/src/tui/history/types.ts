import type { FileChangeMeta } from '@gemma-sdk/agent';
import type { StyledLine } from '../markdown/types.js';

export type HistoryKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'command'
  | 'settings'
  | 'status'
  | 'disclaimer'
  | 'notice'
  | 'error';

export interface HistoryEntryMeta {
  fileChange?: FileChangeMeta;
  pending?: boolean;
}

export interface HistoryEntry {
  kind: HistoryKind;
  text: string;
  meta?: HistoryEntryMeta;
}

export interface RenderedLine {
  kind: HistoryKind | 'header';
  line: StyledLine;
}

export interface HistoryRenderOptions {
  width: number;
  separate: boolean;
}
