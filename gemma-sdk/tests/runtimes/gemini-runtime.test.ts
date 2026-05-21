import { afterEach, describe, expect, it } from "vitest";
import { createGeminiApiAdapter } from "@gemma-sdk/runtime-gemini";
import { createMockServer } from "../helpers/mock-server.js";

describe("Gemini API runtime adapter", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("reports a clear unavailable state without an API key", async () => {
    const inspection = await createGeminiApiAdapter().inspect();

    expect(inspection).toMatchObject({
      runtime: {
        id: "gemini-api",
        family: "gemini",
        kind: "hosted",
        displayName: "Gemini API",
      },
      installed: true,
      reachable: false,
      healthy: false,
      models: [],
      loadedInstances: [],
    });
    expect(inspection.warnings[0]).toContain("No Gemini API key");
  });

  it("discovers hosted Gemini models from models.list metadata", async () => {
    const server = await createMockServer((request) => {
      expect(request.path).toContain("/models");
      expect(request.path).toContain("key=test-key");
      return {
        json: {
          models: [
            {
              name: "models/gemini-3.5-flash",
              displayName: "Gemini 3.5 Flash",
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ["generateContent", "countTokens"],
              thinking: true,
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        },
      };
    });
    cleanup.push(server.close);

    const inspection = await createGeminiApiAdapter({
      apiKey: "test-key",
      baseUrl: server.url,
    }).inspect();

    expect(inspection).toMatchObject({
      reachable: true,
      healthy: true,
      loadedInstances: [],
    });
    expect(inspection.models).toHaveLength(2);
    expect(inspection.models[0]).toMatchObject({
      id: "gemini-3.5-flash",
      runtimeId: "gemini-api",
      kind: "llm",
      metadata: {
        displayName: "Gemini 3.5 Flash",
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      },
    });
    expect(inspection.models[0]?.capabilities.some((capability) =>
      capability.id === "request.tool-calling" && capability.status === "supported"
    )).toBe(true);
    expect(inspection.models[1]).toMatchObject({
      id: "text-embedding-004",
      kind: "embedding",
    });
  });

  it("maps system instructions, messages, and JSON response settings for generation", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path.startsWith("/models/gemini-3.5-flash:generateContent")) {
        requestBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            candidates: [{
              content: { parts: [{ text: "{\"answer\":\"ok\"}" }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 4,
              totalTokenCount: 14,
            },
          },
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const response = await createGeminiApiAdapter({
      apiKey: "test-key",
      baseUrl: server.url,
    }).generate({
      model: "gemini-3.5-flash",
      messages: [
        { id: "s1", role: "system", content: [{ type: "text", text: "Be concise." }], createdAt: "now" },
        { id: "u1", role: "user", content: [{ type: "text", text: "Return JSON." }], createdAt: "now" },
      ],
      responseFormat: {
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
      tools: [{
        name: "read_file",
        description: "Read a workspace file.",
        inputSchema: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            options: {
              type: "object",
              additionalProperties: false,
              properties: {
                include: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      pattern: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }],
    });

    expect(response.text).toBe("{\"answer\":\"ok\"}");
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(requestBody).toMatchObject({
      systemInstruction: { parts: [{ text: "Be concise." }] },
      contents: [{ role: "user", parts: [{ text: "Return JSON." }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("additionalProperties");
    expect(requestBody?.tools).toEqual([{
      functionDeclarations: [{
        name: "read_file",
        description: "Read a workspace file.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            options: {
              type: "object",
              properties: {
                include: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      pattern: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }],
    }]);
  });

  it("replays Gemini thought signatures on function call history", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const server = await createMockServer((request) => {
      if (request.path.startsWith("/models/gemini-3.5-flash:generateContent")) {
        requestBodies.push(request.bodyJson as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return {
            json: {
              candidates: [{
                content: {
                  role: "model",
                  parts: [{
                    functionCall: {
                      name: "read_file",
                      args: { path: "README.md" },
                    },
                    thoughtSignature: "signature-from-gemini",
                  }],
                },
                finishReason: "STOP",
              }],
            },
          };
        }

        return {
          json: {
            candidates: [{
              content: { role: "model", parts: [{ text: "done" }] },
              finishReason: "STOP",
            }],
          },
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createGeminiApiAdapter({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const tools = [{
      name: "read_file",
      description: "Read a workspace file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }];

    const first = await adapter.generate({
      model: "gemini-3.5-flash",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "Read README.md" }], createdAt: "now" },
      ],
      tools,
    });
    expect(first.toolCalls).toHaveLength(1);

    await adapter.generate({
      model: "gemini-3.5-flash",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "Read README.md" }], createdAt: "now" },
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          createdAt: "now",
          toolCalls: first.toolCalls,
          metadata: first.metadata,
        },
        {
          id: "t1",
          role: "tool",
          name: "read_file",
          toolCallId: first.toolCalls[0]?.id,
          content: [{ type: "text", text: "README contents" }],
          createdAt: "now",
        },
      ],
      tools,
    });

    expect(requestBodies[1]?.contents).toEqual([
      { role: "user", parts: [{ text: "Read README.md" }] },
      {
        role: "model",
        parts: [{
          functionCall: {
            name: "read_file",
            args: { path: "README.md" },
          },
          thoughtSignature: "signature-from-gemini",
        }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            name: "read_file",
            response: {
              content: "README contents",
              toolCallId: first.toolCalls[0]?.id,
            },
          },
        }],
      },
    ]);
  });

  it("does not blame API keys for Gemini request-shape 400 errors", async () => {
    const server = await createMockServer((request) => {
      if (request.path.startsWith("/models/gemini-3.5-flash:generateContent")) {
        return {
          status: 400,
          json: {
            error: {
              code: 400,
              message: "Function call is missing a thought_signature in functionCall parts.",
              status: "INVALID_ARGUMENT",
            },
          },
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    await expect(createGeminiApiAdapter({
      apiKey: "test-key",
      baseUrl: server.url,
    }).generate({
      model: "gemini-3.5-flash",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "Hello" }], createdAt: "now" },
      ],
    })).rejects.toThrow(/tool-call history/);
  });
});
