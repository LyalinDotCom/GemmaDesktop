import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
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

  it("sends think=false for Gemma 4 when reasoningMode is explicitly off", async () => {
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

  it("enables Gemma 4 thinking in both the Ollama request and system prompt", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return { json: { version: "0.6.0" } };
        case "/api/tags":
          return {
            json: {
              models: [{
                name: "gemma4:31b",
                details: {
                  family: "gemma",
                },
              }],
            },
          };
        case "/api/ps":
          return { json: { models: [] } };
        case "/api/show":
          return { json: { capabilities: ["completion"] } };
        case "/api/chat":
          capturedBody = request.bodyJson as Record<string, unknown>;
          return {
            json: {
              message: {
                role: "assistant",
                content: "Hello.",
              },
            },
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createOllamaNativeAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "gemma4:31b",
      mode: "cowork",
      metadata: {
        requestPreferences: {
          reasoningMode: "on",
        },
      },
    });

    await session.run("Hello.");

    expect(capturedBody?.think).toBe(true);
    const systemText = ((capturedBody?.messages as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((message) => message.role === "system")
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(systemText).toContain("<gemma_desktop_system_prompt>");
    expect(systemText).toContain("<|think|>");
    expect(systemText).toContain("Thinking mode is enabled for this Gemma 4 conversation.");
    expect(systemText).not.toContain("<|turn>system");
    expect(systemText).not.toContain("<turn|>");
  });

  it("sends think=true for Gemma 4 when reasoningMode is auto", async () => {
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

    expect(requests[0]?.think).toBe(true);
  });

  it("omits Gemma 4 thinking prompt instructions when reasoningMode is explicitly off", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return { json: { version: "0.6.0" } };
        case "/api/tags":
          return {
            json: {
              models: [{
                name: "gemma4:31b",
                details: {
                  family: "gemma",
                },
              }],
            },
          };
        case "/api/ps":
          return { json: { models: [] } };
        case "/api/show":
          return { json: { capabilities: ["completion"] } };
        case "/api/chat":
          capturedBody = request.bodyJson as Record<string, unknown>;
          return {
            json: {
              message: {
                role: "assistant",
                content: "Hello.",
              },
            },
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createOllamaNativeAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "gemma4:31b",
      mode: "cowork",
      metadata: {
        requestPreferences: {
          reasoningMode: "off",
        },
      },
    });

    await session.run("Hello.");

    expect(capturedBody?.think).toBe(false);
    const systemText = ((capturedBody?.messages as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((message) => message.role === "system")
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(systemText).toContain("<gemma_desktop_system_prompt>");
    expect(systemText).not.toContain("<|think|>");
    expect(systemText).not.toContain("Thinking mode is enabled for this Gemma 4 conversation.");
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
