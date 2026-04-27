import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeDebugEvent } from "@gemma-desktop/sdk-core";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "./helpers/mock-server.js";

async function createHangingNdjsonServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/chat") {
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
      });
      response.flushHeaders();
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

describe("ollama native debug events", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("emits request and response debug events for streaming chat", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        return {
          text: [
            JSON.stringify({
              model: "qwen3:8b",
              message: {
                content: "Hello from Ollama.",
              },
              done: false,
            }),
            JSON.stringify({
              model: "qwen3:8b",
              message: {},
              done: true,
              done_reason: "stop",
              prompt_eval_count: 8,
              eval_count: 4,
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

    const debugEvents: RuntimeDebugEvent[] = [];
    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });

    for await (const _event of adapter.stream({
      model: "qwen3:8b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Hello?" }], createdAt: new Date().toISOString() }],
      debug: (event) => {
        debugEvents.push(event);
      },
    })) {
      // Drain the stream.
    }

    const requestEvent = debugEvents.find(
      (event) => event.stage === "request" && event.transport === "ollama-native.stream",
    );
    expect(requestEvent).toBeDefined();
    expect(requestEvent?.url).toBe(`${server.url}/api/chat`);
    expect(requestEvent?.payload).toMatchObject({
      model: "qwen3:8b",
      stream: true,
    });

    const responseEvent = debugEvents.find(
      (event) => event.stage === "response" && event.transport === "ollama-native.stream",
    );
    expect(responseEvent?.status).toBe(200);

    const streamEvent = debugEvents.find(
      (event) => event.stage === "stream" && event.transport === "ollama-native.stream",
    );
    expect(streamEvent?.body).toMatchObject({
      done: true,
      done_reason: "stop",
    });
  });

  it("ends stalled streams with an actionable timeout", async () => {
    const server = await createHangingNdjsonServer();
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({
      baseUrl: server.url,
      streamIdleTimeoutMs: 10,
    });
    const iterator = adapter.stream({
      model: "gemma4:31b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Hello?" }], createdAt: new Date().toISOString() }],
    })[Symbol.asyncIterator]();

    let thrown: unknown;
    try {
      await iterator.next();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ kind: "timeout" });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Ollama accepted the gemma4:31b stream but produced no data");
  });

  it("sends Ollama-native tool definitions and tool result history in the expected shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            model: "qwen3:8b",
            message: {
              role: "assistant",
              content: "Done.",
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 8,
            eval_count: 4,
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "qwen3:8b",
      messages: [
        { id: "msg_1", role: "user", content: [{ type: "text", text: "Look up today's headlines." }], createdAt: new Date().toISOString() },
        {
          id: "msg_2",
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id: "call_1",
              name: "web_research_agent",
              input: { goal: "Get today's headlines from cnn.com and foxnews.com." },
            },
          ],
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg_3",
          role: "tool",
          name: "web_research_agent",
          toolCallId: "call_1",
          content: [{ type: "text", text: "Headlines fetched." }],
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [
        {
          name: "web_research_agent",
          description: "Research the web and return a compact summary.",
          inputSchema: {
            type: "object",
            required: ["goal"],
            properties: {
              goal: {
                type: "string",
              },
            },
            additionalProperties: false,
          },
        },
      ],
    });

    expect(capturedBody).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "web_research_agent",
            description: "Research the web and return a compact summary.",
            parameters: {
              type: "object",
              required: ["goal"],
            },
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Look up today's headlines.",
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "web_research_agent",
                arguments: {
                  goal: "Get today's headlines from cnn.com and foxnews.com.",
                },
              },
            },
          ],
        },
        {
          role: "tool",
          content: "Headlines fetched.",
          tool_name: "web_research_agent",
        },
      ],
    });
  });
});
