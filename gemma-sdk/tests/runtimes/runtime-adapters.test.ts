import { describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-sdk/node";
import type {
  ChatRequest,
  ChatResponse,
  InferenceAdapter,
  ModelDiscoveryProvider,
  RuntimeAdapter,
  RuntimeInspectionResult,
} from "@gemma-sdk/core";

function createRuntimeAdapter(input: {
  modelId: string;
  endpoint: string;
  displayName?: string;
}): RuntimeAdapter & { inspectCount: number } {
  const adapter: RuntimeAdapter & { inspectCount: number } = {
    inspectCount: 0,
    identity: {
      id: "test-runtime",
      family: "unknown",
      kind: "server",
      displayName: input.displayName ?? "Test Runtime",
      endpoint: input.endpoint,
    },
    async inspect(): Promise<RuntimeInspectionResult> {
      adapter.inspectCount += 1;
      return {
        runtime: adapter.identity,
        installed: true,
        reachable: true,
        healthy: true,
        capabilities: [],
        models: [{
          id: input.modelId,
          runtimeId: adapter.identity.id,
          kind: "llm",
          availability: "visible",
          metadata: {},
          capabilities: [],
          raw: {},
        }],
        loadedInstances: [],
        warnings: [],
        diagnosis: [],
      };
    },
    async generate(_request: ChatRequest): Promise<ChatResponse> {
      throw new Error("generate() is not used in this test.");
    },
    async *stream(): AsyncIterable<never> {
      yield* [];
    },
  };
  return adapter;
}

describe("GemmaDesktop runtime adapters", () => {
  it("replaces configured adapters for subsequent environment inspection", async () => {
    const originalAdapter = createRuntimeAdapter({
      modelId: "original-model",
      endpoint: "http://original.local",
    });
    const updatedAdapter = createRuntimeAdapter({
      modelId: "updated-model",
      endpoint: "http://updated.local",
      displayName: "Updated Runtime",
    });

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [originalAdapter],
    });

    const originalInspection = await gemmaDesktop.inspectEnvironment();
    expect(originalInspection.runtimes).toHaveLength(1);
    expect(originalInspection.runtimes[0]?.runtime.endpoint).toBe("http://original.local");
    expect(originalInspection.runtimes[0]?.models.map((model) => model.id)).toEqual([
      "original-model",
    ]);

    gemmaDesktop.updateAdapters([updatedAdapter]);

    const updatedInspection = await gemmaDesktop.inspectEnvironment();
    expect(updatedInspection.runtimes).toHaveLength(1);
    expect(updatedInspection.runtimes[0]?.runtime.endpoint).toBe("http://updated.local");
    expect(updatedInspection.runtimes[0]?.runtime.displayName).toBe("Updated Runtime");
    expect(updatedInspection.runtimes[0]?.models.map((model) => model.id)).toEqual([
      "updated-model",
    ]);
    expect(originalAdapter.inspectCount).toBe(1);
    expect(updatedAdapter.inspectCount).toBe(1);
  });

  it("keeps inference adapters separate from model discovery providers", async () => {
    const inferenceAdapter: InferenceAdapter = {
      identity: {
        id: "test-openai",
        family: "unknown",
        kind: "openai-compatible",
        displayName: "Test OpenAI",
        endpoint: "http://inference.local",
      },
      async generate(_request: ChatRequest): Promise<ChatResponse> {
        throw new Error("generate() is not used in this test.");
      },
      async *stream(): AsyncIterable<never> {
        yield* [];
      },
    };
    const discoveryProvider: ModelDiscoveryProvider = {
      identity: {
        id: "test-openai",
        family: "unknown",
        kind: "openai-compatible",
        displayName: "Test Inventory",
        endpoint: "http://discovery.local",
      },
      async inspect(): Promise<RuntimeInspectionResult> {
        return {
          runtime: discoveryProvider.identity,
          installed: true,
          reachable: true,
          healthy: true,
          capabilities: [],
          models: [{
            id: "inventory-model",
            runtimeId: "test-openai",
            discoveryRuntimeId: "test-native",
            kind: "llm",
            availability: "visible",
            metadata: {},
            capabilities: [],
          }],
          loadedInstances: [],
          warnings: [],
          diagnosis: [],
        };
      },
    };

    const gemmaDesktop = await createGemmaDesktop({
      inferenceAdapters: [inferenceAdapter],
      modelDiscoveryProviders: [discoveryProvider],
    });

    const inspection = await gemmaDesktop.inspectEnvironment();

    expect(inspection.runtimes).toHaveLength(1);
    expect(inspection.runtimes[0]?.runtime.endpoint).toBe("http://discovery.local");
    expect(inspection.runtimes[0]?.models[0]).toEqual(expect.objectContaining({
      id: "inventory-model",
      runtimeId: "test-openai",
      discoveryRuntimeId: "test-native",
    }));
  });
});
