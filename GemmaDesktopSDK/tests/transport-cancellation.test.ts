import { describe, expect, it } from "vitest";
import { parseJsonLines, parseSse } from "@gemma-desktop/sdk-core";

function createHangingStream(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      onCancel();
    },
  });
}

describe("transport stream cancellation", () => {
  it("aborts pending SSE reads when the signal is cancelled", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const iterator = parseSse(
      createHangingStream(() => {
        cancelled = true;
      }),
      controller.signal,
    )[Symbol.asyncIterator]();

    const next = iterator.next();
    controller.abort();

    await expect(next).rejects.toMatchObject({
      kind: "cancellation",
    });
    expect(cancelled).toBe(true);
  });

  it("aborts pending JSONL reads when the signal is cancelled", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const iterator = parseJsonLines(
      createHangingStream(() => {
        cancelled = true;
      }),
      controller.signal,
    )[Symbol.asyncIterator]();

    const next = iterator.next();
    controller.abort();

    await expect(next).rejects.toMatchObject({
      kind: "cancellation",
    });
    expect(cancelled).toBe(true);
  });

  it("times out pending JSONL reads when the stream goes idle", async () => {
    let cancelled = false;
    const iterator = parseJsonLines(
      createHangingStream(() => {
        cancelled = true;
      }),
      undefined,
      {
        idleTimeoutMs: 10,
        idleTimeoutMessage: "Ollama stream produced no data.",
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      kind: "timeout",
      message: "Ollama stream produced no data.",
    });
    expect(cancelled).toBe(true);
  });
});
