import { describe, expect, it } from 'vitest';
import { createHeadlessRunMetricsTracker } from './headlessMetrics.js';

describe('headless run metrics', () => {
  it('uses provider output tokens when streaming usage is available', () => {
    const tracker = createHeadlessRunMetricsTracker(0);

    tracker.onModelStart({ index: 0 }, 100);
    tracker.onModelActivity({
      index: 0,
      chunk: { content: 'x'.repeat(40), done: false }
    }, 600);
    tracker.onModelActivity({
      index: 0,
      chunk: { thinking: 'x'.repeat(40), done: false }
    }, 1_600);
    tracker.onModelActivity({
      index: 0,
      chunk: {
        done: true,
        doneReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 25,
          totalTokens: 35
        }
      }
    }, 2_100);

    expect(tracker.snapshot(2_200)).toMatchObject({
      totals: {
        wallDurationMs: 2_200,
        modelCallDurationMs: 2_000,
        generationDurationMs: 1_500,
        contentChars: 40,
        thinkingChars: 40,
        estimatedOutputTokens: 20,
        providerOutputTokens: 25,
        metricOutputTokens: 25,
        tokenSource: 'provider',
        tokensPerSecond: 16.67,
        wallTokensPerSecond: 11.36
      },
      modelCalls: [{
        index: 0,
        finalization: false,
        durationMs: 2_000,
        firstOutputLatencyMs: 500,
        generationDurationMs: 1_500,
        contentChars: 40,
        thinkingChars: 40,
        estimatedOutputTokens: 20,
        providerOutputTokens: 25,
        metricOutputTokens: 25,
        tokenSource: 'provider',
        tokensPerSecond: 16.67,
        wallTokensPerSecond: 12.5,
        done: true,
        doneReason: 'stop'
      }]
    });
  });

  it('falls back to estimated output tokens when provider usage is absent', () => {
    const tracker = createHeadlessRunMetricsTracker(0);

    tracker.onModelStart({ index: 0 }, 0);
    tracker.onModelActivity({
      index: 0,
      chunk: { content: 'x'.repeat(80), done: false }
    }, 1_000);
    tracker.onModelActivity({
      index: 0,
      chunk: { done: true }
    }, 3_000);

    expect(tracker.snapshot(3_000)).toMatchObject({
      totals: {
        estimatedOutputTokens: 20,
        metricOutputTokens: 20,
        tokenSource: 'estimate',
        tokensPerSecond: 10,
        wallTokensPerSecond: 6.67
      },
      modelCalls: [{
        estimatedOutputTokens: 20,
        metricOutputTokens: 20,
        tokenSource: 'estimate',
        tokensPerSecond: 10,
        wallTokensPerSecond: 6.67
      }]
    });
  });
});
