import { afterEach, describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  resolvePromptProfileSections,
  resolveSessionSystemInstructions,
  SYSTEM_PROMPT_ROOT_TAG,
  SYSTEM_PROMPT_SECTION_TAG,
  type SessionMessage,
  type SystemPromptCatalog,
} from "@gemma-desktop/sdk-core";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "./helpers/mock-server.js";

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

function collectSectionSources(prompt: string | undefined): string[] {
  if (!prompt) {
    return [];
  }

  return Array.from(
    prompt.matchAll(new RegExp(`<${SYSTEM_PROMPT_SECTION_TAG} source="([^"]+)"`, "g")),
    (match) => match[1] ?? "",
  );
}

function collectRepeatedInstructionLines(prompt: string): string[] {
  const counts = new Map<string, number>();
  for (const rawLine of prompt.split("\n")) {
    const line = rawLine.trim();
    if (
      line.length < 72
      || line.startsWith("<")
      || line.startsWith("</")
      || line.startsWith("Available tools in this turn:")
      || line.startsWith("Direct tools in this turn:")
      || line.startsWith("Delegated agent tools in this turn:")
    ) {
      continue;
    }

    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([line]) => line);
}

describe("system prompt profiles", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("layers fallback and model prompt sections from broad to specific", () => {
    const catalog: SystemPromptCatalog = {
      fallback: {
        kind: "fallback",
        id: "fallback",
        text: "Fallback prompt.",
      },
      models: [
        {
          kind: "model",
          id: "gemma4-31b",
          text: "Gemma 4 31B model prompt.",
        },
      ],
    };

    const sections = resolvePromptProfileSections("gemma4:31b", catalog);

    expect(sections.map((section) => `${section.source}:${section.id}`)).toEqual([
      "fallback:fallback",
      "model:gemma4-31b",
    ]);
  });

  it("wraps final prompts in explicit source boundaries", () => {
    const prompt = composeSystemPrompt(
      resolveSessionSystemInstructions({
        modelId: "gemma4:31b",
        mode: "build",
        workingDirectory: "/tmp/gemma-desktop",
        availableTools: ["search_web", "fetch_url", "browser", "write_file"],
        now: new Date("2026-04-07T15:30:00Z"),
        timeZone: "America/New_York",
      }),
      "Continue the current task now.",
    );

    expect(prompt?.startsWith(`<${SYSTEM_PROMPT_ROOT_TAG}>`)).toBe(true);
    expect(prompt?.endsWith(`</${SYSTEM_PROMPT_ROOT_TAG}>`)).toBe(true);
    expect(collectSectionSources(prompt)).toEqual([
      "fallback",
      "environment",
      "tool_context",
      "mode",
      "continuation",
    ]);
    expect(prompt).toContain(
      `<${SYSTEM_PROMPT_SECTION_TAG} source="continuation" id="runtime-continuation">`,
    );
    expect(prompt).toContain("**Web & Browser Tools:**");
    expect(prompt).toContain("**Browser Loop:**");
    expect(prompt).toContain("**Workspace & File Tools:**");
    expect(prompt).toContain("**Execution & File Mutation Rules:**");
    expect(prompt).toContain("**Validation & Dependencies:**");
    expect(prompt).toContain("**Communication Workflow:**");
  });

  it("leaves single custom worker prompts raw for minimal child sessions", () => {
    const prompt = composeSystemPrompt([
      {
        source: "custom",
        text: "This is a focused internal worker.\nReturn JSON only.",
      },
    ]);

    expect(prompt).toBe("This is a focused internal worker.\nReturn JSON only.");
  });

  it("keeps browser routing guidance in the dynamic tool context", () => {
    const staticWebPrompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "explore",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["search_web", "fetch_url"],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));
    const browserPrompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "explore",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["search_web", "fetch_url", "browser"],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(staticWebPrompt).not.toContain("A good dynamic-site loop is:");
    expect(staticWebPrompt).not.toContain("browser action=\"snapshot\"");
    expect(staticWebPrompt).toContain("**Web & Browser Tools:**");
    expect(staticWebPrompt).not.toContain("**Browser Loop:**");
    expect(browserPrompt).toContain("A good dynamic-site loop is:");
    expect(browserPrompt).toContain("browser action=\"snapshot\"");
    expect(browserPrompt).toContain("**Browser Loop:**");
  });

  it("keeps generated prompt instructions from drifting into duplicated lines", () => {
    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: [
        "list_tree",
        "search_paths",
        "search_text",
        "read_file",
        "read_files",
        "fetch_url",
        "search_web",
        "browser",
        "chrome_devtools",
        "write_file",
        "edit_file",
        "exec_command",
        "workspace_inspector_agent",
        "workspace_editor_agent",
        "workspace_command_agent",
      ],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).toBeDefined();
    expect(collectRepeatedInstructionLines(prompt ?? "")).toEqual([]);
  });

  it("injects shared anti-loop guidance into outgoing gemma4 requests", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "gemma4:31b" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "prompt_1",
              choices: [{ index: 0, delta: { content: "Answer." } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "prompt_1",
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
      model: "gemma4:31b",
      mode: "cowork",
    });

    const debug = gemmaDesktop.describeSession(session.snapshot());
    expect(
      debug.systemPromptSections.some(
        (section) => section.source === "fallback" && section.id === "fallback",
      ),
    ).toBe(true);

    await session.run("What are the other incidents?");

    const systemText = collectSystemText(
      (requests[0]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(systemText).toContain("After one refined retry, stop looping.");
    expect(systemText).toContain("If a tool result is only a title, heading, placeholder, 404 shell, or other thin scaffold");
    expect(systemText).toContain("execute against it instead of restating it as a fresh proposal");
    expect(systemText).toContain("Do not keep issuing near-duplicate tool calls after partial, empty, or malformed results.");
    expect(systemText).toContain(`<${SYSTEM_PROMPT_SECTION_TAG} source="fallback" id="fallback">`);
  });

  it("snapshots gemma4:31b prompt composition for explore, plan, and build", () => {
    const prompts = {
      explore: composeSystemPrompt(resolveSessionSystemInstructions({
        modelId: "gemma4:31b",
        mode: "explore",
        workingDirectory: "/tmp/gemma-desktop",
        availableTools: ["list_tree", "search_paths", "search_text", "read_file", "read_files", "search_web", "workspace_inspector_agent"],
        now: new Date("2026-04-07T15:30:00Z"),
        timeZone: "America/New_York",
      })),
      plan: composeSystemPrompt(resolveSessionSystemInstructions({
        modelId: "gemma4:31b",
        mode: "plan",
        workingDirectory: "/tmp/gemma-desktop",
        availableTools: ["list_tree", "search_paths", "search_text", "read_file", "read_files", "search_web", "workspace_inspector_agent", "ask_plan_question", "prepare_plan_execution"],
        now: new Date("2026-04-07T15:30:00Z"),
        timeZone: "America/New_York",
      })),
      build: composeSystemPrompt(resolveSessionSystemInstructions({
        modelId: "gemma4:31b",
        mode: "build",
        workingDirectory: "/tmp/gemma-desktop",
        availableTools: ["list_tree", "search_paths", "search_text", "read_file", "read_files", "write_file", "exec_command", "workspace_inspector_agent"],
        now: new Date("2026-04-07T15:30:00Z"),
        timeZone: "America/New_York",
      })),
    };

    expect(prompts).toMatchSnapshot();
  });

  it("tells the model how to handle truncated or partial file reads", () => {
    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["search_text", "read_file", "read_files", "write_file"],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).toContain(
      "read_file and read_files return explicit windows, not magical full-file context.",
    );
    expect(prompt).toContain(
      "If a read says it was truncated or starts after offset=1, you do not have the whole file.",
    );
    expect(prompt).toContain(
      "Continue with offset or use search_text to target the relevant section in large text files.",
    );
  });

  it("routes full content extraction through materialized artifacts before shell commands", () => {
    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: [
        "inspect_file",
        "materialize_content",
        "read_content",
        "search_content",
        "read_file",
        "write_file",
        "exec_command",
      ],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).toContain(
      "Use materialize_content when the user asks to extract, convert, OCR, transcribe, or save the full contents of a local source",
    );
    expect(prompt).toContain(
      "After materializing a large artifact, use search_content and read_content windows",
    );
    expect(prompt).toContain(
      "For local PDFs, images, and audio files, read_file is the direct extraction path for inspection",
    );
    expect(prompt).toContain(
      "Use shell commands or package installation only after the direct file tools fail or are unavailable",
    );
  });

  it("keeps exact path guidance from earlier user messages when a follow-up omits the path", () => {
    const history: SessionMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: [
          {
            type: "text",
            text: "Inspect /Users/demo/Source/Testing/GemmaDesktop/solar-system-sim/main.js and fix the orbit math.",
          },
        ],
        createdAt: "2026-04-08T22:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "I will inspect the file." }],
        createdAt: "2026-04-08T22:00:01.000Z",
      },
      {
        id: "user-2",
        role: "user",
        content: [{ type: "text", text: "try again" }],
        createdAt: "2026-04-08T22:00:02.000Z",
      },
    ];

    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["read_file", "write_file"],
      history,
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).toContain("/Users/demo/Source/Testing/GemmaDesktop/solar-system-sim/main.js");
    expect(prompt).toContain("Prefer these exact paths over relative guesses when choosing files.");
  });

  it("falls back to compaction-summary paths when older sessions did not preserve exact user paths in metadata", () => {
    const history: SessionMessage[] = [
      {
        id: "assistant-compact",
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "Compacted Session Summary",
              "",
              "## Project Context",
              "Three.js solar system simulation at `/Users/demo/Source/Testing/GemmaDesktop/solar-system-sim`.",
              "",
              "## Important Artifacts",
              "- `main.js`: Core simulation engine.",
            ].join("\n"),
          },
        ],
        createdAt: "2026-04-08T22:10:00.000Z",
        metadata: {
          compaction: {
            kind: "summary",
            compactedAt: "2026-04-08T22:10:00.000Z",
            count: 1,
          },
        },
      },
      {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "try again" }],
        createdAt: "2026-04-08T22:10:01.000Z",
      },
    ];

    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["read_file", "write_file"],
      history,
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).toContain("/Users/demo/Source/Testing/GemmaDesktop/solar-system-sim");
    expect(prompt).toContain("Treat them as authoritative.");
  });

  it("does not treat casual slash phrases like date/time as exact paths", () => {
    const history: SessionMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: [
          {
            type: "text",
            text: "can the planets load closer to where they really are based on date/time?",
          },
        ],
        createdAt: "2026-04-08T22:10:01.000Z",
      },
    ];

    const prompt = composeSystemPrompt(resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "build",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["read_file", "write_file"],
      history,
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    }));

    expect(prompt).not.toContain("Exact path strings mentioned earlier by the user in this session:");
    expect(prompt).not.toContain("date/time");
  });

  it("does not inject gemma4 model-specific guidance for unrelated models", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "qwen3:8b" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "prompt_2",
              choices: [{ index: 0, delta: { content: "Answer." } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "prompt_2",
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
      model: "qwen3:8b",
      mode: "cowork",
    });

    const debug = gemmaDesktop.describeSession(session.snapshot());
    expect(debug.systemPromptSections.every((section) => section.source !== "model")).toBe(true);

    await session.run("What are the other incidents?");

    const systemText = collectSystemText(
      (requests[0]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(systemText).not.toContain("Optimize for Gemma 4 31B style");
  });
});
