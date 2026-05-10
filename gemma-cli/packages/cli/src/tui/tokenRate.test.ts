import { describe, expect, it } from 'vitest';
import { createTokenRateState, recordTokenRateChunk, tokenRateLabel } from './tokenRate.js';

describe('token rate tracking', () => {
  it('waits for enough estimated output before showing a rate', () => {
    const state = createTokenRateState(0);

    expect(recordTokenRateChunk(state, { content: 'short output' }, 500)).toBeUndefined();
  });

  it('estimates live output tokens per second from streamed text', () => {
    const state = createTokenRateState(0);

    recordTokenRateChunk(state, { content: 'x'.repeat(40) }, 0);
    const label = recordTokenRateChunk(state, { thinking: 'x'.repeat(40) }, 2_000);

    expect(label).toBe('~10 tok/s');
  });

  it('uses a recent window so the label can move with live throughput', () => {
    const state = createTokenRateState(0);

    recordTokenRateChunk(state, { content: 'x'.repeat(80) }, 0);
    recordTokenRateChunk(state, { content: 'x'.repeat(80) }, 2_000);
    const slower = recordTokenRateChunk(state, { content: 'x'.repeat(40) }, 8_000);

    expect(slower).toBe('~1.7 tok/s');
  });

  it('drops during quiet periods between streamed chunks', () => {
    const state = createTokenRateState(0);

    recordTokenRateChunk(state, { content: 'x'.repeat(120) }, 0);

    expect(tokenRateLabel(state, 2_000)).toBe('~15 tok/s');
    expect(tokenRateLabel(state, 6_000)).toBe('~5.0 tok/s');
  });
});
