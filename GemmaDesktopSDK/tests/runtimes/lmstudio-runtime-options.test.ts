import { afterEach, describe, expect, it } from "vitest";
import {
  createLmStudioNativeAdapter,
  createLmStudioOpenAICompatibleAdapter,
} from "@gemma-desktop/sdk-runtime-lmstudio";
import { createMockServer } from "../helpers/mock-server.js";

function userMessage(text: string) {
  return {
    id: "msg_1",
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    createdAt: new Date().toISOString(),
  };
}

describe("LM Studio runtime options", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("passes managed inference options to the native chat endpoint", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "google/gemma-4-26b-a4b",
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "on"],
                  default: "on",
                },
              },
            }],
          },
        };
      }

      if (request.path === "/api/v1/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            response_id: "resp_1",
            output: [{ type: "message", content: "Done." }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "google/gemma-4-26b-a4b",
      messages: [userMessage("Say done.")],
      settings: {
        reasoningMode: "off",
        lmstudioOptions: {
          context_length: 65536,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          repeat_penalty: 1.05,
          max_output_tokens: 2048,
        },
      },
    });

    expect(capturedBody).toEqual(expect.objectContaining({
      model: "google/gemma-4-26b-a4b",
      stream: false,
      context_length: 65536,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.05,
      max_output_tokens: 2048,
      reasoning: "on",
    }));
  });

  it("does not send native reasoning options for LM Studio models that do not expose them", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "gemma-4-31b-it-mlx",
              display_name: "Gemma 4 31B Instruct",
              capabilities: {
                vision: true,
                trained_for_tool_use: true,
              },
            }],
          },
        };
      }

      if (request.path === "/api/v1/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            response_id: "resp_1",
            output: [{ type: "message", content: "Done." }],
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma-4-31b-it-mlx",
      messages: [userMessage("Say done.")],
      settings: {
        reasoningMode: "on",
      },
    });

    expect(capturedBody).toEqual(expect.objectContaining({
      model: "gemma-4-31b-it-mlx",
      stream: false,
    }));
    expect(capturedBody).not.toHaveProperty("reasoning");
  });

  it("maps managed inference options onto LM Studio OpenAI-compatible chat", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/v1/chat/completions") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            id: "chatcmpl_mock",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Done.",
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
    await adapter.generate({
      model: "google/gemma-4-26b",
      messages: [userMessage("Say done.")],
      settings: {
        lmstudioOptions: {
          context_length: 65536,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          repeat_penalty: 1.05,
          max_output_tokens: 2048,
        },
      },
    });

    expect(capturedBody).toEqual(expect.objectContaining({
      model: "google/gemma-4-26b",
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.05,
      max_tokens: 2048,
    }));
    expect(capturedBody).not.toHaveProperty("context_length");
    expect(capturedBody).not.toHaveProperty("max_output_tokens");
  });

  it("exposes load lifecycle and loaded instances for the OpenAI-compatible adapter", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const server = await createMockServer((request) => {
      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{
              id: "google/gemma-4-26b",
              owned_by: "lmstudio",
            }],
          },
        };
      }

      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [{
              key: "google/gemma-4-26b",
              display_name: "Gemma 4 26B",
              loaded_instances: [{
                id: "instance-1",
                config: {
                  context_length: 65536,
                },
              }],
            }],
          },
        };
      }

      if (request.path === "/api/v1/models/load") {
        requests.push({ path: request.path, body: request.bodyJson as Record<string, unknown> });
        return {
          json: {
            instance_id: "instance-2",
            status: "loaded",
          },
        };
      }

      if (request.path === "/api/v1/models/unload") {
        requests.push({ path: request.path, body: request.bodyJson as Record<string, unknown> });
        return {
          json: {
            instance_id: "instance-2",
          },
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url });
    const inspection = await adapter.inspect();
    expect(inspection.loadedInstances).toEqual([expect.objectContaining({
      id: "instance-1",
      modelId: "google/gemma-4-26b",
      runtimeId: "lmstudio-openai",
      config: {
        context_length: 65536,
      },
    })]);

    await adapter.lifecycle?.loadModel?.("google/gemma-4-26b", {
      context_length: 65536,
      flash_attention: true,
      echo_load_config: true,
    });
    await adapter.lifecycle?.unloadModel?.("instance-2");

    expect(requests).toEqual([
      {
        path: "/api/v1/models/load",
        body: {
          model: "google/gemma-4-26b",
          context_length: 65536,
          flash_attention: true,
          echo_load_config: true,
        },
      },
      {
        path: "/api/v1/models/unload",
        body: {
          instance_id: "instance-2",
        },
      },
    ]);
  });
});
