import { afterEach, describe, expect, it } from "vitest";
import { createLmStudioNativeAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createMockServer } from "./helpers/mock-server.js";

describe("LM Studio native streaming", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("parses lifecycle, reasoning, and message events from native SSE streams", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/chat") {
        requests.push((request.bodyJson as Record<string, unknown>) ?? {});
        return {
          sse: [
            'event: model_load.start\ndata: {"type":"model_load.start","model_instance_id":"mock"}\n\n',
            'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"Need to check."}\n\n',
            'event: message.delta\ndata: {"type":"message.delta","content":"Done."}\n\n',
            'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_1","output":[{"type":"reasoning","content":"Need to check."},{"type":"message","content":"Done."}]}}\n\n',
          ],
        };
      }
      if (request.path === "/api/v1/models") {
        return {
          json: { models: [] },
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioNativeAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "mock-model",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Say hello." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toContain("Say hello.");
    expect(requests[0]?.messages).toBeUndefined();
    expect(events.some((event) => event.type === "lifecycle")).toBe(true);
    expect(events.some((event) => event.type === "reasoning.delta")).toBe(true);
    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("Done.");
  });

  it("sanitizes XML-style thought leakage from native message streams", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/chat") {
        return {
          sse: [
            'event: message.delta\ndata: {"type":"message.delta","content":"First, I will inspect it."}\n\n',
            'event: message.delta\ndata: {"type":"message.delta","content":"\\n\\n<thought I should use a command."}\n\n',
            'event: message.delta\ndata: {"type":"message.delta","content":"\\n</thought>\\nDone."}\n\n',
            'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_1","output":[{"type":"message","content":"First, I will inspect it.\\n\\n<thought I should use a command.\\n</thought>\\nDone."}]}}\n\n',
          ],
        };
      }
      if (request.path === "/api/v1/models") {
        return {
          json: { models: [] },
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioNativeAdapter({ baseUrl: server.url });
    const events = [];
    for await (const event of adapter.stream({
      model: "mock-model",
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "Inspect it." }], createdAt: new Date().toISOString() }],
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", delta: "First, I will inspect it." },
      { type: "text.delta", delta: "\n\nDone." },
    ]);
    const completed = events.find((event) => event.type === "response.complete");
    expect(completed && completed.type === "response.complete" ? completed.response.text : "").toBe("First, I will inspect it.\n\nDone.");
  });
});
