import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOllamaNativeAdapter,
  createOllamaOpenAICompatibleModelDiscoveryProvider,
} from "@gemma-sdk/runtime-ollama";
import { createLlamaCppServerAdapter } from "@gemma-sdk/runtime-llamacpp";
import { createMockServer } from "../helpers/mock-server.js";

describe("environment inspection", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it("distinguishes available models from loaded instances for Ollama native", async () => {
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return {
            json: { version: "0.6.0" },
          };
        case "/api/tags":
          return {
            json: {
              models: [
                {
                  name: "qwen3:8b",
                  size: 123,
                  digest: "abc",
                  details: {
                    format: "gguf",
                    family: "qwen",
                    quantization_level: "Q4_K_M",
                  },
                },
              ],
            },
          };
        case "/api/ps":
          return {
            json: {
              models: [
                {
                  name: "qwen3:8b",
                  size: 123,
                  size_vram: 45,
                  context_length: 32768,
                  expires_at: null,
                },
              ],
            },
          };
        case "/api/show":
          return {
            json: {
              capabilities: ["completion", "vision"],
              parameters: "temperature 1\ntop_k 64\ntop_p 0.95",
              model_info: {
                context_length: 32768,
              },
            },
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const inspection = await createOllamaNativeAdapter({ baseUrl: server.url }).inspect();

    expect(inspection.reachable).toBe(true);
    expect(inspection.models).toHaveLength(1);
    expect(inspection.loadedInstances).toHaveLength(1);
    expect(inspection.models[0]?.availability).toBe("available");
    expect(inspection.loadedInstances[0]?.status).toBe("loaded");
    expect(inspection.loadedInstances[0]?.config).toEqual(expect.objectContaining({
      context_length: 32768,
    }));
    expect(inspection.models[0]?.metadata).toEqual(expect.objectContaining({
      parameters: {
        temperature: 1,
        top_k: 64,
        top_p: 0.95,
      },
      parametersText: "temperature 1\ntop_k 64\ntop_p 0.95",
    }));
  });

  it("can report Ollama native inventory for OpenAI-compatible inference targets", async () => {
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/v1/models":
          return {
            json: {
              object: "list",
              data: [{ id: "gemma4:31b", owned_by: "ollama" }],
            },
          };
        case "/api/version":
          return {
            json: { version: "0.6.0" },
          };
        case "/api/tags":
          return {
            json: {
              models: [
                {
                  name: "gemma4:31b",
                  size: 123,
                  digest: "abc",
                  details: {
                    format: "gguf",
                    family: "gemma",
                    quantization_level: "Q4_K_M",
                  },
                },
              ],
            },
          };
        case "/api/ps":
          return {
            json: {
              models: [
                {
                  name: "gemma4:31b",
                  size: 123,
                  size_vram: 45,
                  context_length: 262144,
                  expires_at: null,
                },
              ],
            },
          };
        case "/api/show":
          return {
            json: {
              capabilities: ["completion", "vision"],
              model_info: {
                context_length: 262144,
              },
            },
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const inspection = await createOllamaOpenAICompatibleModelDiscoveryProvider({
      baseUrl: server.url,
    }).inspect();

    expect(inspection.runtime.id).toBe("ollama-openai");
    expect(inspection.healthy).toBe(true);
    const discoveredModel = inspection.models[0];
    expect(discoveredModel?.id).toBe("gemma4:31b");
    expect(discoveredModel?.runtimeId).toBe("ollama-openai");
    expect(discoveredModel?.discoveryRuntimeId).toBe("ollama-native");
    expect(discoveredModel?.metadata.contextLength).toBe(262144);
    expect(discoveredModel?.metadata.discoveryRuntimeId).toBe("ollama-native");

    const loadedInstance = inspection.loadedInstances[0];
    expect(loadedInstance?.modelId).toBe("gemma4:31b");
    expect(loadedInstance?.runtimeId).toBe("ollama-openai");
    expect(loadedInstance?.discoveryRuntimeId).toBe("ollama-native");
    expect(loadedInstance?.config.context_length).toBe(262144);

    expect(discoveredModel?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model.input.image",
          status: "supported",
        }),
      ]),
    );
  });

  it("does not mention llama.cpp router mode when the server endpoint is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("llama.cpp endpoint unavailable"));

    const inspection = await createLlamaCppServerAdapter({
      baseUrl: "http://127.0.0.1:65534",
    }).inspect();

    expect(inspection.reachable).toBe(false);
    expect(inspection.diagnosis).toEqual([]);
  });

  it("describes reachable single-model llama.cpp servers without implying the runtime is missing", async () => {
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/health":
          return { status: 200, text: "ok" };
        case "/v1/models":
        case "/models":
          return {
            json: {
              object: "list",
              data: [{ id: "mock-model" }],
            },
          };
        case "/props":
          return { json: { role: "model" } };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const inspection = await createLlamaCppServerAdapter({ baseUrl: server.url }).inspect();

    expect(inspection.reachable).toBe(true);
    expect(inspection.models).toHaveLength(1);
    expect(inspection.diagnosis).toEqual([
      "llama.cpp server is reachable in single-model mode; model load and unload controls require llama.cpp router mode.",
    ]);
    expect(inspection.diagnosis.join(" ")).not.toContain("Router mode is not detected");
  });

  it("detects llama.cpp router mode from server props and router model status", async () => {
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/health":
          return { status: 200, text: "ok" };
        case "/v1/models":
        case "/models":
          return {
            json: {
              object: "list",
              data: [
                {
                  id: "mock-model",
                  object: "model",
                  owned_by: "llamacpp",
                  created: 1,
                  in_cache: true,
                  path: "/tmp/mock-model.gguf",
                  status: { value: "loaded" },
                },
              ],
            },
          };
        case "/props":
          return { json: { role: "router" } };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const inspection = await createLlamaCppServerAdapter({ baseUrl: server.url }).inspect();
    const loadUnload = inspection.capabilities.find((capability) =>
      capability.id === "runtime.load-unload",
    );

    expect(loadUnload?.status).toBe("supported");
    expect(inspection.diagnosis).toEqual([]);
    expect(inspection.loadedInstances).toEqual([
      expect.objectContaining({
        modelId: "mock-model",
        status: "loaded",
      }),
    ]);
  });
});
