import type { AgentModelActivityEvent, AgentModelEvent, TokenUsage } from '@gemma-sdk/agent';

const tokenEstimateChars = 4;

export interface HeadlessRunMetrics {
  totals: HeadlessRunMetricTotals;
  modelCalls: HeadlessModelCallMetrics[];
}

export interface HeadlessRunMetricTotals {
  wallDurationMs: number;
  modelCallDurationMs: number;
  generationDurationMs?: number;
  contentChars: number;
  thinkingChars: number;
  estimatedOutputTokens: number;
  providerOutputTokens?: number;
  metricOutputTokens: number;
  tokenSource: 'provider' | 'estimate' | 'mixed';
  tokensPerSecond?: number;
  wallTokensPerSecond?: number;
}

export interface HeadlessModelCallMetrics {
  index: number;
  finalization: boolean;
  durationMs: number;
  firstOutputLatencyMs?: number;
  generationDurationMs?: number;
  contentChars: number;
  thinkingChars: number;
  estimatedOutputTokens: number;
  providerOutputTokens?: number;
  metricOutputTokens: number;
  tokenSource: 'provider' | 'estimate';
  tokensPerSecond?: number;
  wallTokensPerSecond?: number;
  done: boolean;
  doneReason?: string;
}

interface ModelCallState {
  index: number;
  finalization: boolean;
  startedAt: number;
  firstOutputAt?: number;
  lastActivityAt?: number;
  doneAt?: number;
  doneReason?: string;
  contentChars: number;
  thinkingChars: number;
  usage?: TokenUsage;
}

export interface HeadlessRunMetricsTracker {
  onModelStart(event: AgentModelEvent, now?: number): void;
  onModelActivity(event: AgentModelActivityEvent, now?: number): void;
  snapshot(now?: number): HeadlessRunMetrics;
}

export function createHeadlessRunMetricsTracker(now = Date.now()): HeadlessRunMetricsTracker {
  const startedAt = now;
  const calls = new Map<string, ModelCallState>();

  return {
    onModelStart(event, eventAt = Date.now()) {
      const key = callKey(event.index, event.finalization === true);
      calls.set(key, {
        index: event.index,
        finalization: event.finalization === true,
        startedAt: eventAt,
        contentChars: 0,
        thinkingChars: 0
      });
    },
    onModelActivity(event, eventAt = Date.now()) {
      const finalization = event.finalization === true;
      const key = callKey(event.index, finalization);
      const call = calls.get(key) ?? {
        index: event.index,
        finalization,
        startedAt: eventAt,
        contentChars: 0,
        thinkingChars: 0
      };
      const contentChars = event.chunk.content?.length ?? 0;
      const thinkingChars = event.chunk.thinking?.length ?? 0;
      if ((contentChars > 0 || thinkingChars > 0) && call.firstOutputAt === undefined) {
        call.firstOutputAt = eventAt;
      }
      call.contentChars += contentChars;
      call.thinkingChars += thinkingChars;
      call.lastActivityAt = eventAt;
      if (event.chunk.usage) {
        call.usage = event.chunk.usage;
      }
      if (event.chunk.done === true) {
        call.doneAt = eventAt;
      }
      if (event.chunk.doneReason) {
        call.doneReason = event.chunk.doneReason;
      }
      calls.set(key, call);
    },
    snapshot(snapshotAt = Date.now()) {
      const modelCalls = [...calls.values()]
        .map((call) => formatModelCall(call, snapshotAt))
        .sort((a, b) => Number(a.finalization) - Number(b.finalization) || a.index - b.index);
      return {
        totals: formatTotals(modelCalls, Math.max(0, snapshotAt - startedAt)),
        modelCalls
      };
    }
  };
}

function formatModelCall(call: ModelCallState, now: number): HeadlessModelCallMetrics {
  const endedAt = call.doneAt ?? call.lastActivityAt ?? now;
  const durationMs = Math.max(0, endedAt - call.startedAt);
  const generationDurationMs = call.firstOutputAt === undefined
    ? undefined
    : Math.max(0, endedAt - call.firstOutputAt);
  const firstOutputLatencyMs = call.firstOutputAt === undefined
    ? undefined
    : Math.max(0, call.firstOutputAt - call.startedAt);
  const estimatedOutputTokens = estimateTokens(call.contentChars + call.thinkingChars);
  const providerOutputTokens = finitePositive(call.usage?.outputTokens);
  const tokenSource: HeadlessModelCallMetrics['tokenSource'] = providerOutputTokens === undefined ? 'estimate' : 'provider';
  const metricOutputTokens = providerOutputTokens ?? estimatedOutputTokens;
  return pruneUndefined({
    index: call.index,
    finalization: call.finalization,
    durationMs,
    firstOutputLatencyMs,
    generationDurationMs,
    contentChars: call.contentChars,
    thinkingChars: call.thinkingChars,
    estimatedOutputTokens,
    providerOutputTokens,
    metricOutputTokens,
    tokenSource,
    tokensPerSecond: rate(metricOutputTokens, generationDurationMs),
    wallTokensPerSecond: rate(metricOutputTokens, durationMs),
    done: call.doneAt !== undefined,
    doneReason: call.doneReason
  });
}

function formatTotals(modelCalls: HeadlessModelCallMetrics[], wallDurationMs: number): HeadlessRunMetricTotals {
  const contentChars = sum(modelCalls.map((call) => call.contentChars));
  const thinkingChars = sum(modelCalls.map((call) => call.thinkingChars));
  const estimatedOutputTokens = estimateTokens(contentChars + thinkingChars);
  const providerCalls = modelCalls.filter((call) => call.providerOutputTokens !== undefined);
  const providerOutputTokens = providerCalls.length > 0
    ? round(sum(providerCalls.map((call) => call.providerOutputTokens ?? 0)))
    : undefined;
  const tokenSource: HeadlessRunMetricTotals['tokenSource'] = providerCalls.length === modelCalls.length && modelCalls.length > 0
    ? 'provider'
    : providerCalls.length === 0
      ? 'estimate'
      : 'mixed';
  const metricOutputTokens = round(sum(modelCalls.map((call) => call.metricOutputTokens)));
  const modelCallDurationMs = sum(modelCalls.map((call) => call.durationMs));
  const generationDurationMs = sum(modelCalls.map((call) => call.generationDurationMs ?? 0));
  return pruneUndefined({
    wallDurationMs,
    modelCallDurationMs,
    generationDurationMs: generationDurationMs > 0 ? generationDurationMs : undefined,
    contentChars,
    thinkingChars,
    estimatedOutputTokens,
    providerOutputTokens,
    metricOutputTokens,
    tokenSource,
    tokensPerSecond: rate(metricOutputTokens, generationDurationMs),
    wallTokensPerSecond: rate(metricOutputTokens, wallDurationMs)
  });
}

function callKey(index: number, finalization: boolean): string {
  return `${finalization ? 'final' : 'turn'}:${index}`;
}

function estimateTokens(chars: number): number {
  return round(chars / tokenEstimateChars);
}

function rate(tokens: number, durationMs: number | undefined): number | undefined {
  if (!durationMs || durationMs <= 0 || tokens <= 0) {
    return undefined;
  }
  return round(tokens / (durationMs / 1000));
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
