import { describe, expect, it } from "vitest";
import {
  createGemmaDesktop,
  describeSessionSnapshot,
} from "@gemma-desktop/sdk-node";
import {
  composeSystemPrompt,
  resolveSessionSystemInstructions,
} from "@gemma-desktop/sdk-core";

describe("custom tool surfaces", () => {
  const customTool = {
    name: "plan_question",
    description: "Ask the user a planning question.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute() {
      return {
        output: "ok",
      };
    },
  };

  it("includes app-provided tools in debug snapshots", async () => {
    const gemmaDesktop = await createGemmaDesktop({
      extraTools: [customTool],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "debug-model",
      mode: {
        base: "minimal",
        tools: ["plan_question"],
      },
      metadata: {
        test: true,
      },
    });

    const snapshot = session.snapshot();
    const instanceDebug = gemmaDesktop.describeSession(snapshot);
    const staticDebug = describeSessionSnapshot(snapshot, [customTool]);

    expect(instanceDebug.toolNames).toContain("plan_question");
    expect(instanceDebug.tools.some((tool) => tool.name === "plan_question")).toBe(true);
    expect(instanceDebug.requestPreview.tools.some((tool) => tool.name === "plan_question")).toBe(true);

    expect(staticDebug.toolNames).toContain("plan_question");
    expect(staticDebug.tools.some((tool) => tool.name === "plan_question")).toBe(true);
  });

  it("can restrict a preset to an explicit tool surface", async () => {
    const gemmaDesktop = await createGemmaDesktop();

    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "debug-model",
      mode: {
        base: "build",
        onlyTools: ["write_files", "exec_command", "finalize_build"],
      },
    });

    const debug = gemmaDesktop.describeSession(session.snapshot());

    expect(debug.toolNames).toEqual(["write_files", "exec_command", "finalize_build"]);
    expect(debug.requestPreview.tools.map((tool) => tool.name)).toEqual([
      "write_files",
      "exec_command",
      "finalize_build",
    ]);
  });

  it("shows a composed system prompt as one bootstrap system message", async () => {
    const gemmaDesktop = await createGemmaDesktop();

    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "debug-model",
      mode: "build",
      systemInstructions: "Custom tail instruction.",
    });

    const debug = gemmaDesktop.describeSession(session.snapshot());
    const systemMessages = debug.requestPreview.messages.filter((message) => message.role === "system");

    expect(debug.systemPromptSections.map((section) => section.source)).toEqual([
      "fallback",
      "environment",
      "tool_context",
      "mode",
      "custom",
    ]);
    expect(systemMessages).toHaveLength(1);
    expect(debug.systemPrompt).toContain("Be truthful about actions and results from this session only.");
    expect(debug.systemPrompt).toContain("Current date:");
    expect(debug.systemPrompt).toContain("Custom tail instruction.");
  });

  it("injects the current date into non-minimal system prompts", () => {
    const sections = resolveSessionSystemInstructions({
      modelId: "gemma4:31b",
      mode: "cowork",
      workingDirectory: "/tmp/gemma-desktop",
      availableTools: ["web_research_agent", "workspace_inspector_agent"],
      now: new Date("2026-04-07T15:30:00Z"),
      timeZone: "America/New_York",
    });

    expect(sections.map((section) => section.source)).toEqual([
      "fallback",
      "model",
      "environment",
      "tool_context",
      "mode",
    ]);
    expect(composeSystemPrompt(sections)).toContain(
      "Current date: Tuesday, April 7, 2026 (America/New_York).",
    );
  });
});
