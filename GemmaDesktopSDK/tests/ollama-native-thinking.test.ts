import { afterEach, describe, expect, it } from "vitest";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "./helpers/mock-server.js";

describe("Ollama native thinking", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("parses separate thinking from non-streaming chat responses", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          json: {
            model: "qwen3:8b",
            message: {
              role: "assistant",
              thinking: "Need to check the numbers.",
              content: "42",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "calculator",
                    arguments: { expression: "6 * 7" },
                  },
                },
              ],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 6,
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    const response = await adapter.generate({
      model: "qwen3:8b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "What is 6 times 7?" }], createdAt: new Date().toISOString() }],
    });

    expect(response.reasoning).toBe("Need to check the numbers.");
    expect(response.text).toBe("42");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe("calculator");
  });

  it("streams thinking separately from content for native chat responses", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          text: [
            JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
                thinking: "Need to check ",
              },
              done: false,
            }),
            JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
                thinking: "the numbers.",
              },
              done: false,
            }),
            JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
                content: "42",
              },
              done: false,
            }),
            JSON.stringify({
              model: "qwen3:8b",
              message: {
                role: "assistant",
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 12,
              eval_count: 6,
            }),
          ].join("\n"),
          headers: {
            "content-type": "application/x-ndjson",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    const events = [];

    for await (const event of adapter.stream({
      model: "qwen3:8b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "What is 6 times 7?" }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    const reasoningEvents = events.filter((event) => event.type === "reasoning.delta");
    expect(reasoningEvents).toHaveLength(2);
    expect(
      reasoningEvents.map((event) => event.type === "reasoning.delta" ? event.delta : "").join(""),
    ).toBe("Need to check the numbers.");

    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.reasoning : "").toBe("Need to check the numbers.");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("42");
  });

  it("recovers inline pseudo tool-call syntax from non-streaming native chat responses", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          json: {
            model: "gemma4:26b",
            message: {
              role: "assistant",
              content: 'call:fetch_url{url:<|"|>https://news.ycombinator.com/<|"|>}<tool_call|>',
            },
            done: true,
            done_reason: "stop",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    const response = await adapter.generate({
      model: "gemma4:26b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Fetch Hacker News." }], createdAt: new Date().toISOString() }],
    });

    expect(response.text).toBe("");
    expect(response.toolCalls).toEqual([
      expect.objectContaining({
        name: "fetch_url",
        input: {
          url: "https://news.ycombinator.com/",
        },
      }),
    ]);
  });

  it("recovers inline pseudo tool-call syntax from streaming native chat responses", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          text: [
            JSON.stringify({
              model: "gemma4:26b",
              message: {
                role: "assistant",
                content: 'call:fetch_url{url:<|"|>https://news.',
              },
              done: false,
            }),
            JSON.stringify({
              model: "gemma4:26b",
              message: {
                role: "assistant",
                content: 'ycombinator.com/<|"|>}<tool_call|>',
              },
              done: false,
            }),
            JSON.stringify({
              model: "gemma4:26b",
              message: {
                role: "assistant",
              },
              done: true,
              done_reason: "stop",
            }),
          ].join("\n"),
          headers: {
            "content-type": "application/x-ndjson",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    const events = [];

    for await (const event of adapter.stream({
      model: "gemma4:26b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Fetch Hacker News." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("");
    expect(completed && completed.type === "response.complete" ? completed.response.toolCalls : []).toEqual([
      expect.objectContaining({
        name: "fetch_url",
        input: {
          url: "https://news.ycombinator.com/",
        },
      }),
    ]);
  });

  it("does not misclassify ordinary prose as an inline tool call", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          json: {
            model: "gemma4:26b",
            message: {
              role: "assistant",
              content: "I saw the string call:fetch_url in the docs, but I am not invoking a tool here.",
            },
            done: true,
            done_reason: "stop",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    const response = await adapter.generate({
      model: "gemma4:26b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "What did you see?" }], createdAt: new Date().toISOString() }],
    });

    expect(response.text).toBe("I saw the string call:fetch_url in the docs, but I am not invoking a tool here.");
    expect(response.toolCalls).toEqual([]);
  });
});
