import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliCommand, type SessionCliOptions } from "../../src/args.js";
import { REQUEST_PREFERENCES_METADATA_KEY } from "../../src/metadata.js";

function parseSession(argv: string[]): SessionCliOptions {
  const command = parseCliCommand(argv, "/tmp/gemma-project");
  if (command.command !== "run" && command.command !== "preview") {
    throw new Error(`Expected a session command, got ${command.command}.`);
  }
  return command;
}

describe("CLI argument parsing", () => {
  it("parses a desktop-parity run command with model, mode, tools, and request preferences", () => {
    const command = parseSession([
      "run",
      "Explain local inference",
      "--model",
      "gemma4:e2b",
      "--runtime",
      "ollama-native",
      "--mode",
      "build",
      "--tool",
      "read_file",
      "--without-tool",
      "exec_command",
      "--approval-mode",
      "yolo",
      "--reasoning",
      "on",
      "--ollama-option",
      "num_ctx=8192",
      "--ollama-keep-alive",
      "24h",
      "--ollama-response-header-timeout-ms",
      "30000",
      "--ollama-stream-idle-timeout-ms",
      "45000",
      "--omlx-option",
      "temperature=0.8",
      "--omlx-endpoint",
      "http://localhost:8001",
      "--omlx-api-key",
      "1234",
      "--metadata-json",
      `{"${REQUEST_PREFERENCES_METADATA_KEY}":{"legacy":true},"source":"test"}`,
      "--json",
    ]);

    expect(command.command).toBe("run");
    expect(command.prompt).toBe("Explain local inference");
    expect(command.modelId).toBe("gemma4:e2b");
    expect(command.runtimeId).toBe("ollama-native");
    expect(command.outputJson).toBe(true);
    expect(command.approvalMode).toBe("yolo");
    expect(command.endpoints.omlx).toBe("http://localhost:8001");
    expect(command.omlxApiKey).toBe("1234");
    expect(command.ollamaResponseHeaderTimeoutMs).toBe(30000);
    expect(command.ollamaStreamIdleTimeoutMs).toBe(45000);
    expect(command.mode).toEqual({
      base: "build",
      tools: ["read_file"],
      withoutTools: ["exec_command"],
      requiredTools: ["write_file", "edit_file", "exec_command"],
    });
    expect(command.requestPreferences).toEqual({
      reasoningMode: "on",
      ollamaOptions: { num_ctx: 8192 },
      ollamaKeepAlive: "24h",
      omlxOptions: { temperature: 0.8 },
    });
    expect(command.extraMetadata).toEqual({
      [REQUEST_PREFERENCES_METADATA_KEY]: { legacy: true },
      source: "test",
    });
  });

  it("defaults unknown first tokens to positional run prompt text", () => {
    const command = parseSession(["Summarize", "this"]);

    expect(command.command).toBe("run");
    expect(command.prompt).toBe("Summarize this");
    expect(command.approvalMode).toBe("require_approval");
  });

  it("rejects unsupported approval modes", () => {
    expect(() =>
      parseCliCommand(["run", "hello", "--approval-mode", "maybe"], "/tmp/gemma-project"),
    ).toThrow(CliArgumentError);
  });

  it("rejects malformed numeric request preferences", () => {
    expect(() =>
      parseCliCommand(["run", "hello", "--ollama-option", "num_ctx=big"], "/tmp/gemma-project"),
    ).toThrow(CliArgumentError);
  });

  it("accepts explicit reasoning off request preferences", () => {
    const command = parseSession(["run", "hello", "--reasoning", "off"]);

    expect(command.requestPreferences).toEqual({
      reasoningMode: "off",
    });
  });

  it("parses restrictive tool selections without changing mode semantics", () => {
    const command = parseSession([
      "run",
      "build it",
      "--mode",
      "build",
      "--only-tool",
      "write_files",
      "--only-tool",
      "exec_command",
      "--require-tool",
      "write_files",
    ]);

    expect(command.mode).toEqual({
      base: "build",
      onlyTools: ["write_files", "exec_command"],
      requiredTools: ["write_files"],
    });
    expect(command.selectedToolNames).toEqual(["write_files", "exec_command"]);
  });

  it("parses ACT build policy and scenario runner flags", () => {
    const runCommand = parseSession([
      "run",
      "build it",
      "--mode",
      "build",
      "--build-turns",
      "30",
      "--build-verifier",
      "deterministic",
    ]);
    const scenarioCommand = parseCliCommand([
      "scenario",
      "run",
      "act-webapp-black-hole",
      "--model",
      "gemma4:31b",
      "--runtime",
      "ollama-native",
      "--build-turns",
      "32",
      "--json",
    ], "/tmp/gemma-project");

    expect(runCommand.buildPolicy).toEqual({
      samplingTurns: 30,
      requireFinalizationAfterMutation: true,
      completionVerifier: "deterministic",
    });
    expect(scenarioCommand).toMatchObject({
      command: "scenario",
      action: "run",
      scenarioId: "act-webapp-black-hole",
      modelId: "gemma4:31b",
      buildPolicy: {
        samplingTurns: 32,
        requireFinalizationAfterMutation: true,
        completionVerifier: "off",
      },
      outputJson: true,
    });
  });

  it("requires finalization evidence for ACT run commands even without extra build flags", () => {
    const command = parseSession(["run", "build it", "--mode", "build"]);

    expect(command.mode).toEqual({
      base: "build",
      requiredTools: ["write_file", "edit_file", "exec_command"],
    });
    expect(command.buildPolicy).toEqual({
      requireFinalizationAfterMutation: true,
    });
    expect(command.requestPreferences).toMatchObject({
      reasoningMode: "off",
    });
  });

  it("preserves explicit reasoning preferences for ACT run commands", () => {
    const command = parseSession(["run", "build it", "--mode", "build", "--reasoning", "on"]);

    expect(command.requestPreferences).toMatchObject({
      reasoningMode: "on",
    });
  });

  it("parses the on-demand headless scenario catalog", () => {
    const scenarioIds = [
      "act-webapp-black-hole",
      "act-fix-broken-tests",
      "act-compaction-checkpoint",
      "act-multilang-python-go",
      "browser-rest-is-history-lyndon",
      "pdf-attention-authors",
      "web-hacker-news-frontpage",
      "web-news-coverage-compare",
      "research-gemma4-availability",
      "image-reading-card",
      "audio-harvard-transcript",
      "video-placeholder-keyframes",
    ];

    for (const scenarioId of scenarioIds) {
      expect(parseCliCommand([
        "scenario",
        "run",
        scenarioId,
        "--model",
        "gemma4:31b",
      ], "/tmp/gemma-project")).toMatchObject({
        command: "scenario",
        action: "run",
        scenarioId,
        modelId: "gemma4:31b",
      });
    }
  });
});
