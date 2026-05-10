import type { TuiSession } from '../../tui.js';

export function contextLabel(session: TuiSession): string {
  const total = session.runtime.contextTokens;
  const loaded = session.runtime.loadedContextTokens;
  if (!total) return 'n/a';
  const systemTokens = session.runtime.systemPromptTokens ?? 0;
  const runtimeHistoryChars = (session.runtime.history ?? []).reduce((sum, message) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.type === 'text' ? part.text : `[${part.type}:${part.url}]`).join('\n');
    return sum + text.length;
  }, 0);
  const visibleHistoryChars = session.history.reduce((sum, entry) => sum + entry.text.length, 0);
  const usedTokens = systemTokens + Math.ceil(Math.max(runtimeHistoryChars, visibleHistoryChars) / 4);
  const percent = Math.max(1, Math.ceil((usedTokens / total) * 100));
  return `~${percent}% used (${formatContextTokens(loaded ?? total)})`;
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}k`;
  }
  if (tokens >= 1000 && tokens % 1000 === 0) {
    return `${tokens / 1000}k`;
  }
  return String(tokens);
}
