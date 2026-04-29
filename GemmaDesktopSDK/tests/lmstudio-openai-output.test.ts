import { afterEach, describe, expect, it } from "vitest";
import { createLmStudioOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createMockServer } from "./helpers/mock-server.js";

describe("LM Studio OpenAI-compatible output sanitization", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("strips Gemma transport artifacts from generate responses while preserving tool calls", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          json: {
            id: "chatcmpl_mock",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "<|channel>thought\n<channel|>",
                tool_calls: [{
                  type: "function",
                  id: "tool_1",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"index.html\",\"content\":\"hello\"}",
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const response = await adapter.generate({
      model: "supergemma4-26b-uncensored-v2",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Build something." }], createdAt: new Date().toISOString() }],
    });

    expect(response.text).toBe("");
    expect(response.content).toEqual([]);
    expect(response.toolCalls).toEqual([{
      id: "tool_1",
      name: "write_file",
      input: {
        path: "index.html",
        content: "hello",
      },
    }]);
  });

  it("strips leaked XML-style thought tags from generate responses", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          json: {
            id: "chatcmpl_mock",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "First, I'll create the directory.\n\n<thought I'll use exec_command to create the folder.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const response = await adapter.generate({
      model: "supergemma4-26b-uncensored-v2",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Build something." }], createdAt: new Date().toISOString() }],
    });

    expect(response.text).toBe("First, I'll create the directory.");
    expect(response.content).toEqual([{ type: "text", text: "First, I'll create the directory." }]);
  });

  it("suppresses streamed Gemma transport artifacts but keeps structured tool calls", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          sse: [
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"<|channel>\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"thought\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\n\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"<channel|>\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tool_1\",\"type\":\"function\",\"function\":{\"name\":\"write_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"function\",\"function\":{\"arguments\":\"{\\\"path\\\":\\\"index.html\\\",\\\"content\\\":\\\"hello\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "supergemma4-26b-uncensored-v2",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Build something." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "text.delta")).toEqual([]);
    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("");
    expect(completed && completed.type === "response.complete" ? completed.response.toolCalls : []).toEqual([{
      id: "tool_1",
      name: "write_file",
      input: {
        path: "index.html",
        content: "hello",
      },
    }]);
  });

  it("withholds streamed XML-style thought leakage while preserving later visible text", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          sse: [
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"First, I'll create the directory.\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\n\\n<thought I'll use exec_command to create the folder.\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\n</thought>\\nDone.\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "supergemma4-26b-uncensored-v2",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Build something." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", delta: "First, I'll create the directory." },
      { type: "text.delta", delta: "\n\nDone." },
    ]);
    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("First, I'll create the directory.\n\nDone.");
  });

  it("drops malformed empty streamed tool calls when LM Studio also returns a valid tool call", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          sse: [
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tool_empty\",\"type\":\"function\",\"function\":{\"name\":\"write_file\",\"arguments\":\"\"}},{\"index\":1,\"id\":\"tool_real\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"type\":\"function\",\"function\":{\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "supergemma4-26b-uncensored-v2",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Run pwd." }], createdAt: new Date().toISOString() }],
      tools: [
        {
          name: "write_file",
          description: "Write a file.",
          inputSchema: {
            type: "object",
            required: ["path", "content"],
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
        {
          name: "exec_command",
          description: "Run a command.",
          inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
              command: { type: "string" },
            },
          },
        },
      ],
    })) {
      events.push(event);
    }

    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.toolCalls : []).toEqual([{
      id: "tool_real",
      name: "exec_command",
      input: {
        command: "pwd",
      },
    }]);
  });

  it("passes through normal streamed assistant text unchanged", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        return {
          sse: [
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Done.\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "google/gemma-4-26b-a4b",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Say done." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "text.delta")).toEqual([{
      type: "text.delta",
      delta: "Done.",
    }]);
    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("Done.");
  });
});
