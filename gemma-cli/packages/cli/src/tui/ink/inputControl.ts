import { slashSuggestions, type TuiSession } from '../../tui.js';

export function editInput(
  value: string,
  cursor: number,
  setInput: (value: string) => void,
  setCursor: (value: number) => void,
  session: TuiSession,
  action: 'insert' | 'backspace',
  insertText = ''
): void {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const next = action === 'insert'
    ? `${value.slice(0, safeCursor)}${insertText}${value.slice(safeCursor)}`
    : safeCursor > 0
      ? `${value.slice(0, safeCursor - 1)}${value.slice(safeCursor)}`
      : value;
  const nextCursor = action === 'insert' ? safeCursor + insertText.length : Math.max(safeCursor - 1, 0);
  session.inputBuffer = next;
  session.commandSuggestions = slashSuggestions(next);
  setInput(next);
  setCursor(nextCursor);
}

export function moveInputCursor(
  key: { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean },
  value: string,
  cursor: number,
  setCursor: (value: number) => void,
  width: number
): void {
  const inputWidth = Math.max(width - 6, 1);
  if (key.leftArrow) {
    setCursor(Math.max(cursor - 1, 0));
  } else if (key.rightArrow) {
    setCursor(Math.min(cursor + 1, value.length));
  } else if (key.upArrow) {
    setCursor(moveCursorVertically(value, cursor, inputWidth, -1));
  } else if (key.downArrow) {
    setCursor(moveCursorVertically(value, cursor, inputWidth, 1));
  }
}

function moveCursorVertically(value: string, cursor: number, width: number, direction: -1 | 1): number {
  const safe = Math.max(width, 1);
  const lines = value.split('\n');
  let consumed = 0;
  let line = 0;
  for (const logical of lines) {
    if (cursor <= consumed + logical.length) {
      const local = cursor - consumed;
      const wrappedLine = line + Math.floor(local / safe);
      const column = local % safe;
      const targetLine = wrappedLine + direction;
      if (targetLine < 0) return 0;
      return positionForWrapped(value, targetLine, column, safe);
    }
    consumed += logical.length + 1;
    line += Math.max(1, Math.ceil(logical.length / safe));
  }
  return Math.min(value.length, cursor);
}

function positionForWrapped(value: string, targetLine: number, column: number, width: number): number {
  const lines = value.split('\n');
  let consumed = 0;
  let line = 0;
  for (const logical of lines) {
    const wraps = Math.max(1, Math.ceil(logical.length / width));
    if (targetLine < line + wraps) {
      const offsetWithin = (targetLine - line) * width + column;
      return consumed + Math.min(offsetWithin, logical.length);
    }
    consumed += logical.length + 1;
    line += wraps;
  }
  return value.length;
}
