import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchWithRetry, isTransientFetchError } from "@gemma-desktop/sdk-core";

describe("isTransientFetchError", () => {
  it("recognises bare TypeError: fetch failed", () => {
    const error = new TypeError("fetch failed");
    expect(isTransientFetchError(error)).toBe(true);
  });

  it("walks the cause chain for undici-style transport errors", () => {
    const root = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    (root as NodeJS.ErrnoException).code = "ECONNREFUSED";
    const wrapper = new TypeError("fetch failed");
    (wrapper as Error & { cause?: unknown }).cause = root;
    expect(isTransientFetchError(wrapper)).toBe(true);
  });

  it("treats ECONNRESET / ETIMEDOUT / socket hang up as transient", () => {
    for (const marker of ["ECONNRESET", "ETIMEDOUT", "socket hang up", "EAI_AGAIN", "other side closed"]) {
      const error = new Error(`read ${marker}`);
      expect(isTransientFetchError(error)).toBe(true);
    }
  });

  it("does not treat ordinary errors or HTTP bodies as transient", () => {
    expect(isTransientFetchError(new Error("HTTP 500: internal server error"))).toBe(false);
    expect(isTransientFetchError(new Error("invalid JSON"))).toBe(false);
    expect(isTransientFetchError(undefined)).toBe(false);
    expect(isTransientFetchError("fetch failed")).toBe(false);
  });

  it("never retries AbortError", () => {
    const abort = new Error("The user aborted a request.");
    abort.name = "AbortError";
    expect(isTransientFetchError(abort)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  function transient(message = "fetch failed"): TypeError {
    return new TypeError(message);
  }

  function okResponse(): Response {
    return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });
  }

  it("returns the response on the first attempt when fetch succeeds", async () => {
    const mock = vi.fn().mockResolvedValueOnce(okResponse());
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchWithRetry("http://localhost:11434/api/tags");

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("retries transient errors and eventually succeeds", async () => {
    const mock = vi.fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = mock as unknown as typeof fetch;

    const promise = fetchWithRetry("http://localhost:11434/api/chat", {}, { initialDelayMs: 5 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const mock = vi.fn().mockRejectedValue(transient("fetch failed"));
    globalThis.fetch = mock as unknown as typeof fetch;

    const promise = fetchWithRetry(
      "http://localhost:11434/api/chat",
      {},
      { maxAttempts: 3, initialDelayMs: 1 },
    );
    const assertion = expect(promise).rejects.toThrow(/fetch failed/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-transient errors", async () => {
    const mock = vi.fn().mockRejectedValueOnce(new Error("invalid JSON body"));
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(fetchWithRetry("http://localhost:11434/api/chat")).rejects.toThrow(/invalid JSON/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry HTTP 5xx (they come back as Response objects, not throws)", async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchWithRetry("http://localhost:11434/api/chat");

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(500);
  });

  it("stops retrying when the AbortSignal is triggered mid-backoff", async () => {
    const controller = new AbortController();
    const mock = vi.fn().mockRejectedValue(transient());
    globalThis.fetch = mock as unknown as typeof fetch;

    const promise = fetchWithRetry(
      "http://localhost:11434/api/chat",
      { signal: controller.signal },
      { maxAttempts: 5, initialDelayMs: 1000 },
    );
    const assertion = expect(promise).rejects.toMatchObject({ kind: "cancellation" });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await assertion;

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("invokes the onRetry hook with attempt, error, and delay", async () => {
    const onRetry = vi.fn();
    const mock = vi.fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = mock as unknown as typeof fetch;

    const promise = fetchWithRetry(
      "http://localhost:11434/api/chat",
      {},
      { initialDelayMs: 10, onRetry },
    );
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 10);
  });
});

describe("fetchJson retry integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("retries transient errors inside fetchJson and returns parsed JSON", async () => {
    const mock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "0.1.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const promise = fetchJson<{ version: string }>("http://localhost:11434/api/version");
    await vi.advanceTimersByTimeAsync(300);
    const parsed = await promise;

    expect(parsed).toEqual({ version: "0.1.0" });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
