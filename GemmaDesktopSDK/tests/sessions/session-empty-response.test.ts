import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "../helpers/mock-server.js";

describe("empty response handling", () => {
  const cleanup: Array<() => Promise<void>> = [];

  function collectSystemText(messages: Array<Record<string, unknown>>): string {
    return messages
      .filter((message) => message.role === "system")
      .map((message) => {
        const content = message.content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          return content.map((part) => String((part as Record<string, unknown>).text ?? "")).join("\n");
        }
        return "";
      })
      .join("\n");
  }

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("retries a non-minimal turn when the model returns an empty reply", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const queuedResponses = [
      [
        `data: ${JSON.stringify({
          id: "empty_1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "empty_2",
          choices: [{ index: 0, delta: { content: "Recovered answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "empty_2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
    ];

    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
    });

    const result = await session.run("Say hello.");

    expect(result.text).toBe("Recovered answer.");
    expect(requests).toHaveLength(2);

    const retriedSystemText = collectSystemText(
      (requests[1]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(retriedSystemText).toContain("Your previous reply was empty.");
  });

  it("accepts reasoning-only replies without retrying the turn", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "reasoning_1",
              choices: [{ index: 0, delta: { reasoning_content: "Need to inspect the request carefully." } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "reasoning_1",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
    });

    const result = await session.run("Think out loud.");

    expect(result.text).toBe("");
    expect(result.reasoning).toBe("Need to inspect the request carefully.");
    expect(requests).toHaveLength(1);
  });
});
