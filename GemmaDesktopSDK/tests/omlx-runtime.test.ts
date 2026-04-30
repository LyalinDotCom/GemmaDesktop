import { afterEach, describe, expect, it } from "vitest";
import { createOmlxOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-omlx";
import { createMockServer } from "./helpers/mock-server.js";

describe("oMLX OpenAI-compatible runtime adapter", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("inspects oMLX health, model status, and model capabilities", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return {
          json: {
            status: "healthy",
            engine_pool: {
              model_count: 2,
              loaded_count: 1,
            },
          },
        };
      }

      if (request.path === "/api/status") {
        return {
          json: {
            status: "ok",
            version: "0.3.8rc1",
          },
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            object: "list",
            data: [
              { id: "gemma4-vlm", object: "model", owned_by: "omlx" },
              { id: "bge-m3", object: "model", owned_by: "omlx" },
            ],
          },
        };
      }

      if (request.path === "/v1/models/status") {
        return {
          json: {
            max_model_memory: 1024,
            current_model_memory: 512,
            model_count: 2,
            loaded_count: 1,
            models: [
              {
                id: "gemma4-vlm",
                loaded: true,
                is_loading: false,
                estimated_size: 512,
                pinned: false,
                engine_type: "vlm",
                model_type: "vlm",
                config_model_type: "gemma4",
                max_context_window: 262144,
                max_tokens: 4096,
              },
              {
                id: "bge-m3",
                loaded: false,
                is_loading: false,
                estimated_size: 128,
                pinned: false,
                engine_type: "embedding",
                model_type: "embedding",
                max_context_window: 8192,
                max_tokens: 512,
              },
            ],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    const inspection = await adapter.inspect();

    expect(inspection.runtime).toEqual(expect.objectContaining({
      id: "omlx-openai",
      family: "omlx",
      displayName: "oMLX OpenAI-Compatible",
      endpoint: `${server.url}/v1`,
    }));
    expect(inspection).toEqual(expect.objectContaining({
      installed: true,
      reachable: true,
      healthy: true,
      version: "0.3.8rc1",
      warnings: [],
      diagnosis: [],
    }));
    const gemmaModel = inspection.models.find((model) => model.id === "gemma4-vlm");
    expect(gemmaModel).toMatchObject({
      kind: "llm",
      runtimeId: "omlx-openai",
    });
    expect(gemmaModel?.metadata).toMatchObject({
      modelType: "vlm",
      engineType: "vlm",
      maxContextWindow: 262144,
      maxTokens: 4096,
    });
    expect(gemmaModel?.capabilities.some((capability) =>
      capability.id === "model.input.image" && capability.status === "supported"
    )).toBe(true);
    expect(inspection.capabilities.some((capability) =>
      capability.id === "runtime.load" && capability.status === "supported"
    )).toBe(true);

    const embeddingModel = inspection.models.find((model) => model.id === "bge-m3");
    expect(embeddingModel?.kind).toBe("embedding");
    expect(embeddingModel?.capabilities.some((capability) =>
      capability.id === "model.embedding" && capability.status === "supported"
    )).toBe(true);

    const loadedInstance = inspection.loadedInstances[0];
    expect(loadedInstance).toMatchObject({
      modelId: "gemma4-vlm",
      status: "loaded",
    });
    expect(loadedInstance?.config).toMatchObject({
      maxContextWindow: 262144,
      maxTokens: 4096,
    });
  });

  it("keeps an empty reachable oMLX server informational instead of warning", async () => {
    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return {
          json: {
            status: "healthy",
            engine_pool: {
              model_count: 0,
              loaded_count: 0,
            },
          },
        };
      }

      if (request.path === "/api/status") {
        return { json: { status: "ok", version: "0.3.8rc1" } };
      }

      if (request.path === "/v1/models") {
        return { json: { object: "list", data: [] } };
      }

      if (request.path === "/v1/models/status") {
        return { json: { model_count: 0, loaded_count: 0, models: [] } };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const inspection = await createOmlxOpenAICompatibleAdapter({ baseUrl: server.url }).inspect();

    expect(inspection.warnings).toEqual([]);
    expect(inspection.diagnosis).toEqual([
      "oMLX is reachable, but it did not report any models.",
    ]);
  });

  it("uses OpenAI-compatible chat and oMLX lifecycle endpoints", async () => {
    let chatBody: unknown;
    let loadCalled = false;
    let unloadCalled = false;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        chatBody = request.bodyJson;
        return {
          json: {
            id: "chatcmpl_omlx",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Ready from oMLX.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      if (request.path === "/admin/api/models/gemma-4/load") {
        loadCalled = true;
        return {
          json: {
            status: "ok",
            model_id: "gemma-4",
          },
        };
      }

      if (request.path === "/v1/models/gemma-4/unload") {
        unloadCalled = true;
        return {
          json: {
            status: "ok",
            model_id: "gemma-4",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    await adapter.lifecycle?.loadModel?.("gemma-4");
    const response = await adapter.generate({
      model: "gemma-4",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      }],
    });
    await adapter.lifecycle?.unloadModel?.("gemma-4");

    expect(chatBody).toEqual(expect.objectContaining({
      model: "gemma-4",
      stream: false,
      messages: [expect.objectContaining({ role: "user", content: "hello" })],
    }));
    expect(response.text).toBe("Ready from oMLX.");
    expect(loadCalled).toBe(true);
    expect(unloadCalled).toBe(true);
  });

  it("enables oMLX Gemma 4 thinking with a bounded thinking budget", async () => {
    let chatBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        chatBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            id: "chatcmpl_omlx",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Ready from oMLX.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma-4-26b-a4b-it-nvfp4",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      }],
      settings: {
        reasoningMode: "on",
      },
    });

    expect(chatBody).toEqual(expect.objectContaining({
      model: "gemma-4-26b-a4b-it-nvfp4",
      stream: false,
      thinking_budget: 4096,
      chat_template_kwargs: {
        enable_thinking: true,
      },
    }));
  });

  it("does not enable oMLX Gemma 4 thinking when reasoningMode is explicitly off", async () => {
    let chatBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        chatBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            id: "chatcmpl_omlx",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Ready from oMLX.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma-4-26b-a4b-it-nvfp4",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      }],
      settings: {
        reasoningMode: "off",
      },
    });

    expect(chatBody).toEqual(expect.objectContaining({
      model: "gemma-4-26b-a4b-it-nvfp4",
      stream: false,
    }));
    expect(chatBody).not.toHaveProperty("thinking_budget");
    expect(chatBody).not.toHaveProperty("chat_template_kwargs");
  });

  it("preserves explicit oMLX thinking budget overrides", async () => {
    let chatBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        chatBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            id: "chatcmpl_omlx",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Ready from oMLX.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma-4-26b-a4b-it-nvfp4",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      }],
      settings: {
        reasoningMode: "on",
        openAICompatibleOptions: {
          thinking_budget: 8192,
          chat_template_kwargs: {
            reasoning_effort: "high",
          },
        },
      },
    });

    expect(chatBody).toEqual(expect.objectContaining({
      thinking_budget: 8192,
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_effort: "high",
      },
    }));
  });

  it("maps managed oMLX request options onto OpenAI-compatible chat", async () => {
    let chatBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        chatBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            id: "chatcmpl_omlx",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Ready from oMLX.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOmlxOpenAICompatibleAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma-4-26b-a4b-it-nvfp4",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      }],
      settings: {
        omlxOptions: {
          max_context_window: 262144,
          temperature: 0.8,
          top_p: 0.9,
          top_k: 64,
          max_tokens: 2048,
          seed: 42,
        },
      },
    });

    expect(chatBody).toEqual(expect.objectContaining({
      model: "gemma-4-26b-a4b-it-nvfp4",
      stream: false,
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 2048,
      seed: 42,
    }));
    expect(chatBody).not.toHaveProperty("max_context_window");
    expect(chatBody).not.toHaveProperty("top_k");
  });
});
