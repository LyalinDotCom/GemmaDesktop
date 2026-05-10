import { afterEach, describe, expect, it } from "vitest";
import { createMockServer } from "../helpers/mock-server.js";

describe("mock server helper", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("keeps plain-text request bodies inspectable without forcing JSON parsing", async () => {
    const server = await createMockServer((request) => {
      expect(request.bodyText).toBe("hello from a raw text body");
      expect(request.bodyJson).toBeUndefined();
      return {
        text: "ok",
      };
    });
    cleanup.push(server.close);

    const response = await fetch(`${server.url}/plain`, {
      method: "POST",
      body: "hello from a raw text body",
      headers: {
        "content-type": "text/plain",
      },
    });

    expect(await response.text()).toBe("ok");
  });

  it("still parses valid JSON request bodies when present", async () => {
    const server = await createMockServer((request) => {
      expect(request.bodyJson).toEqual({
        ok: true,
        count: 2,
      });
      return {
        json: {
          accepted: true,
        },
      };
    });
    cleanup.push(server.close);

    const response = await fetch(`${server.url}/json`, {
      method: "POST",
      body: JSON.stringify({
        ok: true,
        count: 2,
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    expect(await response.json()).toEqual({
      accepted: true,
    });
  });
});
