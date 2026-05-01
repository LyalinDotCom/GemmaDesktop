import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "../helpers/mock-server.js";

describe("session snapshots", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("resumes a session from a snapshot and preserves prior history", async () => {
    const seenRequests: Array<Record<string, unknown>> = [];
    const responseFrames = [
      [
        `data: ${JSON.stringify({
          id: "resume_1",
          choices: [{ index: 0, delta: { content: "First answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "resume_1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "resume_2",
          choices: [{ index: 0, delta: { content: "Second answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "resume_2",
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
        seenRequests.push(request.bodyJson as Record<string, unknown>);
        const next = responseFrames.shift();
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

    const initial = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "minimal",
    });
    const first = await initial.run("First prompt");
    expect(first.text).toBe("First answer.");

    const snapshot = initial.snapshot();
    const resumed = await gemmaDesktop.sessions.resume({ snapshot });
    expect(resumed.id).toBe(initial.id);

    const second = await resumed.run("Second prompt");
    expect(second.text).toBe("Second answer.");

    expect(seenRequests).toHaveLength(2);
    const secondMessages = seenRequests[1]?.messages as Array<Record<string, unknown>>;
    expect(secondMessages.length).toBeGreaterThanOrEqual(3);
  });
});
