import { afterEach, describe, expect, it } from "vitest";
import { createLmStudioOpenAICompatibleAdapter } from "@gemma-sdk/runtime-lmstudio";
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

    expect(inspection.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "request.tool-calling",
        status: "conditional",
      }),
    ]));
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

  it("lists native inventory models through the OpenAI-compatible inference runtime", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/models") {
        return {
          json: {
            data: [],
          },
        };
      }

      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "google/gemma-4-26b-it",
              display_name: "Gemma 4 26B",
              params_string: "26B",
              max_context_length: 262144,
              capabilities: {
                vision: true,
                trained_for_tool_use: true,
              },
              loaded_instances: [{
                id: "lmstudio-instance-1",
                config: {
                  context_length: 131072,
                },
              }],
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

    expect(model).toEqual(expect.objectContaining({
      id: "google/gemma-4-26b-it",
      runtimeId: "lmstudio-openai",
      discoveryRuntimeId: "lmstudio-native",
      availability: "available",
    }));
    expect(model?.metadata).toEqual(expect.objectContaining({
      displayName: "Gemma 4 26B",
      parameterCount: "26B",
      contextLength: 131072,
      maxContextLength: 262144,
      discoveryRuntimeId: "lmstudio-native",
    }));
    expect(model?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "model.input.image",
        status: "supported",
      }),
    ]));

    expect(inspection.loadedInstances[0]).toEqual(expect.objectContaining({
      id: "lmstudio-instance-1",
      modelId: "google/gemma-4-26b-it",
      runtimeId: "lmstudio-openai",
      status: "loaded",
      config: {
        context_length: 131072,
      },
    }));
  });

  it("deduplicates models that are visible through both LM Studio endpoints", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/v1/models") {
        return {
          json: {
            data: [
              {
                id: "google/gemma-4-e2b-it",
                owned_by: "lmstudio",
              },
              {
                id: "openai-only-model",
                owned_by: "lmstudio",
              },
            ],
          },
        };
      }

      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "google/gemma-4-e2b-it",
              display_name: "Gemma 4 E2B",
              capabilities: {},
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

    expect(inspection.models.map((model) => model.id)).toEqual([
      "google/gemma-4-e2b-it",
      "openai-only-model",
    ]);
    expect(inspection.models[0]).toEqual(expect.objectContaining({
      runtimeId: "lmstudio-openai",
      discoveryRuntimeId: "lmstudio-native",
      availability: "visible",
    }));
    expect(inspection.models[0]?.metadata).toEqual(expect.objectContaining({
      ownedBy: "lmstudio",
      displayName: "Gemma 4 E2B",
    }));
    expect(inspection.models[1]).toEqual(expect.objectContaining({
      runtimeId: "lmstudio-openai",
      availability: "visible",
    }));
    expect(inspection.models[1]?.metadata).toEqual(expect.objectContaining({
      ownedBy: "lmstudio",
    }));
  });
});
