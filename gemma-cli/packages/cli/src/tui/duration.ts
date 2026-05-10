export function formatDuration(ms: number): string {
  const clampedMs = Math.max(0, Math.round(ms));
  if (clampedMs < 1000) {
    return `${clampedMs}ms`;
  }

  const totalSeconds = Math.floor(clampedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  const secondsWithFraction = clampedMs / 1000;
  return secondsWithFraction < 10
    ? `${secondsWithFraction.toFixed(1)}s`
    : `${totalSeconds}s`;
}

export function runCompletionMessage(status: string | undefined, elapsedMs: number): string {
  const duration = formatClockDuration(elapsedMs);
  return status === 'incomplete'
    ? `run incomplete (${duration})`
    : `run complete (${duration})`;
}

export function formatClockDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${padClock(minutes)}:${padClock(seconds)}`;
  }
  return `${minutes}:${padClock(seconds)}`;
}

function padClock(value: number): string {
  return String(value).padStart(2, '0');
}
