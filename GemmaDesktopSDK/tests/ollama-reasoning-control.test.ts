import { afterEach, describe, expect, it } from "vitest";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "./helpers/mock-server.js";

describe("ollama reasoning control", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("sends think=true when reasoningMode is on", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      requests.push((request.bodyJson ?? {}) as Record<string, unknown>);
      return {
        json: {
          message: {
            role: "assistant",
            content: "Hello.",
          },
        },
      };
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:31b",
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      settings: {
        reasoningMode: "on",
      },
    });

    expect(requests[0]?.think).toBe(true);
  });

  it("sends think=false when reasoningMode is off", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      requests.push((request.bodyJson ?? {}) as Record<string, unknown>);
      return {
        json: {
          message: {
            role: "assistant",
            content: "Hello.",
          },
        },
      };
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:31b",
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      settings: {
        reasoningMode: "off",
      },
    });

    expect(requests[0]?.think).toBe(false);
  });

  it("omits think when reasoningMode is auto", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      requests.push((request.bodyJson ?? {}) as Record<string, unknown>);
      return {
        json: {
          message: {
            role: "assistant",
            content: "Hello.",
          },
        },
      };
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:31b",
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      settings: {
        reasoningMode: "auto",
      },
    });

    expect("think" in (requests[0] ?? {})).toBe(false);
  });

  it("sends explicit ollama options when provided", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      requests.push((request.bodyJson ?? {}) as Record<string, unknown>);
      return {
        json: {
          message: {
            role: "assistant",
            content: "Hello.",
          },
        },
      };
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:26b",
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      settings: {
        ollamaOptions: {
          num_ctx: 65536,
          temperature: 1,
          top_p: 0.95,
          top_k: 64,
        },
      },
    });

    expect(requests[0]?.options).toEqual({
      num_ctx: 65536,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    });
  });

  it("sends explicit keep_alive when provided", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      requests.push((request.bodyJson ?? {}) as Record<string, unknown>);
      return {
        json: {
          message: {
            role: "assistant",
            content: "Hello.",
          },
        },
      };
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:26b",
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      settings: {
        ollamaKeepAlive: "24h",
      },
    });

    expect(requests[0]?.keep_alive).toBe("24h");
  });
});
