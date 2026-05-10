export interface TokenRateState {
  startedAt: number;
  firstOutputAt?: number;
  outputChars: number;
  outputTokens: number;
  samples: TokenRateSample[];
  label?: string;
}

interface TokenRateSample {
  timeMs: number;
  tokens: number;
}

const tokenEstimateChars = 4;
const windowMs = 6_000;
const minTokensForLabel = 12;
const minTokensForWindow = 8;
const minElapsedMs = 1_200;

export function createTokenRateState(now = Date.now()): TokenRateState {
  return {
    startedAt: now,
    outputChars: 0,
    outputTokens: 0,
    samples: []
  };
}

export function recordTokenRateChunk(
  state: TokenRateState,
  chunk: { content?: string; thinking?: string },
  now = Date.now()
): string | undefined {
  const text = `${chunk.thinking ?? ''}${chunk.content ?? ''}`;
  if (!text) {
    return state.label;
  }

  if (state.firstOutputAt === undefined) {
    state.firstOutputAt = now;
    state.samples.push({ timeMs: now, tokens: state.outputTokens });
  }
  state.outputChars += text.length;
  state.outputTokens = state.outputChars / tokenEstimateChars;
  state.samples.push({ timeMs: now, tokens: state.outputTokens });
  pruneSamples(state, now);
  state.label = tokenRateLabel(state, now);
  return state.label;
}

export function tokenRateLabel(state: TokenRateState, now = Date.now()): string | undefined {
  if (state.firstOutputAt === undefined || state.outputTokens < minTokensForLabel) {
    return undefined;
  }

  const latestSample = state.samples.at(-1);
  if (!latestSample) {
    return undefined;
  }
  const latest = {
    timeMs: Math.max(now, latestSample.timeMs),
    tokens: latestSample.tokens
  };

  const windowStart = state.samples.find((sample) => sample.timeMs >= now - windowMs) ?? state.samples[0];
  const windowRate = rateFor(latest, windowStart);
  if (windowRate && windowRate.elapsedMs >= minElapsedMs && windowRate.tokens >= minTokensForWindow) {
    return formatTokenRate(windowRate.tokens / (windowRate.elapsedMs / 1000));
  }

  const totalElapsedMs = latest.timeMs - state.firstOutputAt;
  if (totalElapsedMs < minElapsedMs) {
    return undefined;
  }
  return formatTokenRate(state.outputTokens / (totalElapsedMs / 1000));
}

function pruneSamples(state: TokenRateState, now: number): void {
  const cutoff = now - windowMs;
  while (state.samples.length > 2 && state.samples[1]!.timeMs < cutoff) {
    state.samples.shift();
  }
}

function rateFor(latest: TokenRateSample, start: TokenRateSample | undefined): { tokens: number; elapsedMs: number } | undefined {
  if (!start) {
    return undefined;
  }
  const elapsedMs = latest.timeMs - start.timeMs;
  if (elapsedMs <= 0) {
    return undefined;
  }
  return {
    tokens: latest.tokens - start.tokens,
    elapsedMs
  };
}

function formatTokenRate(tokensPerSecond: number): string | undefined {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return undefined;
  }
  const value = tokensPerSecond < 10
    ? tokensPerSecond.toFixed(1)
    : String(Math.round(tokensPerSecond));
  return `~${value} tok/s`;
}
