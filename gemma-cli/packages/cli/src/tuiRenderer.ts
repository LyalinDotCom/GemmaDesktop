export {
  renderTuiFrame,
  visibleHistoryEntries,
  visibleHistoryLines,
  historyEntryLines,
  historyEntryStyled,
  maxScrollOffset,
  formatSettings,
  inputPrompt,
  type FrameOptions
} from './tui/frame.js';

export type { HistoryEntry as TuiHistoryEntry, HistoryKind as TuiHistoryKind, RenderedLine as HistoryLine } from './tui/history/types.js';
