import { afterEach, describe, expect, it } from "vitest";
import { createLmStudioOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createMockServer } from "../helpers/mock-server.js";

describe("LM Studio OpenAI-compatible inspection", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("inherits native multimodal capabilities for matching models", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{
              id: "qwen2vl-2b-instruct",
              owned_by: "lmstudio",
            }],
          },
        };
      }

      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "qwen2vl-2b-instruct",
              display_name: "Qwen2VL 2B Instruct",
              capabilities: {
                vision: true,
                trained_for_tool_use: false,
              },
              loaded_instances: [],
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const inspection = await adapter.inspect();
    const model = inspection.models[0];

    expect(model?.metadata).toEqual(expect.objectContaining({
      ownedBy: "lmstudio",
      displayName: "Qwen2VL 2B Instruct",
    }));
    expect(model?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "model.vision",
        status: "supported",
      }),
      expect.objectContaining({
        id: "model.input.image",
        status: "supported",
      }),
      expect.objectContaining({
        id: "model.multimodal",
        status: "supported",
      }),
    ]));
  });
});
