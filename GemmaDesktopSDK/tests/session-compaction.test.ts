import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "./helpers/mock-server.js";

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : String((part as Record<string, unknown>).text ?? ""),
      )
      .join("\n");
  }

  return "";
}

describe("session compaction", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("rewrites history into a compact summary plus retained tail and survives resume", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responseFrames = [
      [
        `data: ${JSON.stringify({
          id: "turn_1",
          choices: [{ index: 0, delta: { content: "First answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "turn_1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "turn_2",
          choices: [{ index: 0, delta: { content: "Second answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "turn_2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "compact_1",
          choices: [
            {
              index: 0,
              delta: {
                content: [
                  "## Project Context",
                  "Continuing a small test conversation.",
                  "",
                  "## Work Completed",
                  "- Answered the first two prompts.",
                  "",
                  "## Key Decisions",
                  "- Keep the newest turn verbatim.",
                  "",
                  "## Outstanding TODOs",
                  "- Wait for the next prompt.",
                  "",
                  "## Important Artifacts",
                  "- No workspace files yet.",
                ].join("\n"),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "compact_1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "turn_3",
          choices: [{ index: 0, delta: { content: "Third answer." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "turn_3",
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

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "minimal",
    });

    await session.run("First prompt");
    await session.run("Second prompt");
    const compacted = await session.compact({ keepLastMessages: 2 });
    expect(compacted.summary).toContain("## Project Context");

    const snapshot = session.snapshot();
    expect(snapshot.compaction?.count).toBe(1);
    expect(snapshot.history).toHaveLength(3);
    expect(snapshot.history[0]?.role).toBe("assistant");
    expect(
      (snapshot.history[0]?.metadata?.compaction as Record<string, unknown>)?.kind,
    ).toBe("summary");

    const resumed = await gemmaDesktop.sessions.resume({ snapshot });
    const result = await resumed.run("Third prompt");
    expect(result.text).toBe("Third answer.");

    const resumedMessages = (requests[3]?.messages as Array<Record<string, unknown>>) ?? [];
    const resumedTranscript = resumedMessages.map(messageText).join("\n\n");
    expect(resumedTranscript).toContain("Compacted Session Summary");
    expect(resumedTranscript).toContain("Second prompt");
    expect(resumedTranscript).not.toContain("First prompt");
    expect(resumedTranscript).not.toContain("First answer.");
  });

  it("removes verbose tool-call output from the compaction transcript", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-compact-"));
    const hugeFileContents = Array.from({ length: 220 }, (_, index) => `line ${index}: ${"x".repeat(40)}`).join("\n");
    await writeFile(path.join(tempDirectory, "big.txt"), hugeFileContents, "utf8");

    const requests: Array<Record<string, unknown>> = [];
    const responseFrames = [
      [
        `data: ${JSON.stringify({
          id: "tool_turn_1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "big.txt" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "tool_turn_1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "tool_turn_2",
          choices: [{ index: 0, delta: { content: "Inspected the large file." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "tool_turn_2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "compact_2",
          choices: [{ index: 0, delta: { content: "## Project Context\nLarge file inspection." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "compact_2",
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
      workingDirectory: tempDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "build",
      workingDirectory: tempDirectory,
    });

    const result = await session.run("Inspect big.txt and tell me what you found.");
    expect(result.text).toContain("Inspected the large file.");

    await session.compact({ keepLastMessages: 0 });
    const compactionMessages = (requests[2]?.messages as Array<Record<string, unknown>>) ?? [];
    const compactionTranscript = compactionMessages.map(messageText).join("\n\n");

    expect(compactionTranscript).toContain("Tool requested: read_file");
    expect(compactionTranscript).toContain("large output omitted");
    expect(compactionTranscript).not.toContain("line 219:");
    expect(compactionTranscript).not.toContain(hugeFileContents.slice(0, 400));
  });

  it("preserves exact user-provided paths in compaction metadata for future turns", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responseFrames = [
      [
        `data: ${JSON.stringify({
          id: "turn_path_1",
          choices: [{ index: 0, delta: { content: "Checked the project path." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "turn_path_1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "compact_path_1",
          choices: [{ index: 0, delta: { content: "## Project Context\nPath preserved." } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "compact_path_1",
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

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "build",
    });

    await session.run("Inspect /Users/demo/Source/Testing/GemmaDesktop/solar-system-sim/main.js and update the orbit initialization.");
    await session.compact({ keepLastMessages: 2 });

    const snapshot = session.snapshot();
    expect(
      ((snapshot.history[0]?.metadata?.compaction as Record<string, unknown>)?.exactUserPaths as string[] | undefined),
    ).toContain("/Users/demo/Source/Testing/GemmaDesktop/solar-system-sim/main.js");
  });
});
