import { describe, expect, it } from "vitest";
import {
  SessionEngine,
  type ChatRequest,
  type RuntimeAdapter,
  type RuntimeInspectionResult,
} from "@gemma-desktop/sdk-core";

function createInspection(): RuntimeInspectionResult {
  return {
    runtime: {
      id: "mock-runtime",
      family: "unknown",
      kind: "server",
      displayName: "Mock Runtime",
      endpoint: "http://127.0.0.1",
    },
    installed: true,
    reachable: true,
    healthy: true,
    capabilities: [],
    models: [],
    loadedInstances: [],
    warnings: [],
    diagnosis: [],
  };
}

describe("session request reasoning settings", () => {
  it("propagates requestPreferences and keeps Gemma 4 reasoning enabled", async () => {
    const requests: ChatRequest[] = [];
    const adapter: RuntimeAdapter = {
      identity: createInspection().runtime,
      async inspect() {
        return createInspection();
      },
      async generate() {
        return {
          text: "unused",
          content: [{ type: "text", text: "unused" }],
          toolCalls: [],
        };
      },
      async *stream(request) {
        requests.push(request);
        yield {
          type: "response.complete",
          response: {
            text: "Reasoning configured.",
            content: [{ type: "text", text: "Reasoning configured." }],
            toolCalls: [],
          },
        };
      },
    };

    const session = new SessionEngine({
      adapter,
      model: "gemma4:31b",
      mode: "cowork",
      workingDirectory: "/tmp",
      metadata: {
        requestPreferences: {
          reasoningMode: "off",
          ollamaOptions: {
            num_ctx: 65536,
            temperature: 1,
            top_p: 0.95,
            top_k: 64,
          },
          omlxOptions: {
            max_tokens: 4096,
            temperature: 0.8,
          },
        },
      },
    });

    const result = await session.run("Hello");

    expect(result.text).toBe("Reasoning configured.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.settings).toEqual(expect.objectContaining({
      reasoningMode: "on",
      ollamaOptions: {
        num_ctx: 65536,
        temperature: 1,
        top_p: 0.95,
        top_k: 64,
      },
      omlxOptions: {
        max_tokens: 4096,
        temperature: 0.8,
      },
    }));
  });
});
