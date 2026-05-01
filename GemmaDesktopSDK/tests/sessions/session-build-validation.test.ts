import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FINALIZE_BUILD_TOOL_NAME,
  SessionEngine,
  type AdapterStreamEvent,
  type ChatRequest,
  type ChatResponse,
  type RuntimeAdapter,
  type RuntimeInspectionResult,
  type ShellCommandResult,
} from "@gemma-desktop/sdk-core";
import {
  ToolRegistry,
  ToolRuntime,
  type RegisteredTool,
} from "@gemma-desktop/sdk-tools";

function createInspectionResult(identity: RuntimeAdapter["identity"]): RuntimeInspectionResult {
  return {
    runtime: identity,
    installed: true,
    reachable: true,
    healthy: true,
    capabilities: [],
    models: [],
    loadedInstances: [],
    warnings: [],
    diagnosis: [],
  };
}

class MockAdapter implements RuntimeAdapter {
  public readonly identity = {
    id: "mock-runtime",
    family: "unknown" as const,
    kind: "server" as const,
    displayName: "Mock Runtime",
    endpoint: "http://mock.local",
  };

  public readonly requests: ChatRequest[] = [];

  public constructor(
    private readonly responses: ChatResponse[],
  ) {}

  public async inspect(): Promise<RuntimeInspectionResult> {
    return createInspectionResult(this.identity);
  }

  public async generate(): Promise<ChatResponse> {
    throw new Error("Mock adapter generate() is not used in this test.");
  }

  public async *stream(request: ChatRequest): AsyncIterable<AdapterStreamEvent> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("Unexpected extra chat request.");
    }

    yield {
      type: "response.complete",
      response: next,
    };
  }
}

function createToolCallResponse(input: {
  text: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): ChatResponse {
  return {
    text: input.text,
    content: [{ type: "text", text: input.text }],
    toolCalls: [
      {
        id: `call_${input.toolName}_${Math.random().toString(16).slice(2)}`,
        name: input.toolName,
        input: input.toolInput,
      },
    ],
  };
}

function createTextResponse(text: string): ChatResponse {
  return {
    text,
    content: [{ type: "text", text }],
    toolCalls: [],
  };
}

function collectSystemText(messages: ChatRequest["messages"]): string {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function createWriteFileTool(
  options: { writeToDisk?: boolean } = {},
): RegisteredTool<{ path: string; content: string }> {
  return {
    name: "write_file",
    description: "Write a full file.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      if (options.writeToDisk) {
        const resolvedPath = path.resolve(context.workingDirectory, input.path);
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, input.content, "utf8");
      }
      return {
        output: `Wrote ${input.path}`,
        structuredOutput: {
          path: input.path,
          bytes: input.content.length,
        },
      };
    },
  };
}

function createWriteFilesTool(): RegisteredTool<{ files: Array<{ path: string; content: string }> }> {
  return {
    name: "write_files",
    description: "Write multiple full files.",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "content"],
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      return {
        output: `Wrote ${input.files.length} files`,
        structuredOutput: {
          files: input.files.map((file) => ({ path: file.path })),
        },
      };
    },
  };
}

function createPeekBackgroundProcessTool(
  result: ShellCommandResult & { processId?: string },
): RegisteredTool<{ processId: string }> {
  return {
    name: "peek_background_process",
    description: "Peek a tracked background process.",
    inputSchema: {
      type: "object",
      required: ["processId"],
      properties: {
        processId: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const status = result.exitCode == null ? "running" : "exited";
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return {
        output,
        structuredOutput: {
          processId: input.processId,
          command: result.command,
          workingDirectory: process.cwd(),
          status,
          exitCode: result.exitCode,
          startedAt: Date.now() - 1000,
          completedAt: result.exitCode == null ? undefined : Date.now(),
          output,
          outputChars: output.length,
          retainedTranscriptChars: output.length,
          peekTruncated: false,
          storageTruncated: false,
        },
      };
    },
  };
}

function createOpenProjectBrowserTool(
  result: {
    title?: string;
    url?: string;
    readyState?: string;
    excerpt?: string;
    consoleErrorCount?: number;
    timedOut?: boolean;
    lastError?: string | null;
  } = {},
): RegisteredTool<{ url: string }> {
  return {
    name: "open_project_browser",
    description: "Open the project browser.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const url = result.url ?? input.url;
      const title = result.title ?? "Black Hole Simulation";
      const readyState = result.readyState ?? "complete";
      const consoleErrorCount = result.consoleErrorCount ?? 0;
      const timedOut = result.timedOut ?? false;
      const excerpt = result.excerpt ?? "Black Hole Simulation";
      return {
        output: [
          `Opened Project Browser at ${url}.`,
          `Title: ${title}`,
          `Ready state: ${readyState}`,
          timedOut ? "Loading did not finish." : "Page load finished.",
          `Recent console errors: ${consoleErrorCount}`,
          "",
          "Visible text excerpt:",
          excerpt,
        ].join("\n"),
        structuredOutput: {
          action: "open",
          title,
          url,
          readyState,
          excerpt,
          excerptTruncated: false,
          consoleErrorCount,
          timedOut,
          lastError: result.lastError ?? null,
        },
      };
    },
  };
}

function createExecCommandTool(
  execute: (input: { command: string; cwd?: string }) => ShellCommandResult | Promise<ShellCommandResult>,
): RegisteredTool<{ command: string; cwd?: string }> {
  return {
    name: "exec_command",
    description: "Run one shell command.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const result = await execute(input);
      const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return {
        output: combined.length > 0 ? combined : `Ran ${input.command}`,
        structuredOutput: result,
      };
    },
  };
}

function createFinalizeBuildTool(): RegisteredTool<{
  summary: string;
  artifacts: string[];
  validation: Array<{ command: string; status: "passed" | "failed" | "blocked"; notes?: string }>;
  instructionChecklist: string[];
  blockers?: string[];
}> {
  return {
    name: FINALIZE_BUILD_TOOL_NAME,
    description: "Record build completion evidence.",
    inputSchema: {
      type: "object",
      required: ["summary", "artifacts", "validation", "instructionChecklist"],
      properties: {
        summary: { type: "string" },
        artifacts: { type: "array", items: { type: "string" } },
        validation: { type: "array", items: { type: "object" } },
        instructionChecklist: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    async execute(input) {
      return {
        output: `Recorded ${FINALIZE_BUILD_TOOL_NAME}`,
        structuredOutput: {
          ...input,
          blockers: input.blockers ?? [],
        },
      };
    },
  };
}

async function createWorkspaceWithPackageJson(scripts: Record<string, string>): Promise<string> {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
  await writeFile(
    path.join(workingDirectory, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      scripts,
    }, null, 2),
    "utf8",
  );
  return workingDirectory;
}

describe("build mode verification enforcement", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const target = cleanup.pop();
      if (target) {
        await rm(target, { recursive: true, force: true });
      }
    }
  });

  it("starts build turns with required tools when an explicit required surface is configured", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-compact-web-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "",
        toolName: "write_files",
        toolInput: {
          files: [{ path: "index.html", content: "<main>ok</main>" }],
        },
      }),
      createTextResponse("Blocked because validation has not run yet."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFilesTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "validated",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: {
        base: "build",
        onlyTools: ["write_files", "exec_command", FINALIZE_BUILD_TOOL_NAME],
        requiredTools: ["write_files"],
      },
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 2,
    });

    await engine.run("Create a tiny static app.");

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["write_files"]);
    expect(adapter.requests[1]?.tools?.map((tool) => tool.name)).toEqual([
      "write_files",
      "exec_command",
      FINALIZE_BUILD_TOOL_NAME,
    ]);
    expect(collectSystemText(adapter.requests[0]?.messages ?? [])).toContain(
      "Call one of these tools as soon as it can advance the task: write_files.",
    );
  });

  it("records missing verification without auto-coaching the assistant", async () => {
    const workingDirectory = await createWorkspaceWithPackageJson({
      build: "vite build",
    });
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the file.",
        toolName: "write_file",
        toolInput: {
          path: "src/main.ts",
          content: "console.log('hi');",
        },
      }),
      createTextResponse("I created the file."),
      createTextResponse("This response should not be requested."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "built",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Create the file.");

    expect(result.text).toBe("I created the file.");
    expect(adapter.requests).toHaveLength(2);
    expect(result.build?.verification?.attempted).toBe(false);
    expect(result.build?.verification?.recommendedCommands).toContain("npm run build");
    expect(result.warnings).toEqual([]);
  });

  it("does not loop on repeated text-only replies when verification is missing", async () => {
    const workingDirectory = await createWorkspaceWithPackageJson({
      build: "vite build",
    });
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the file.",
        toolName: "write_file",
        toolInput: {
          path: "src/main.ts",
          content: "console.log('hi');",
        },
      }),
      createTextResponse("I created the file."),
      createTextResponse("I created the file and it is ready."),
      createTextResponse("This response should not be requested."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "built",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 8,
    });

    const result = await engine.run("Create the file.");

    expect(result.text).toBe("I created the file.");
    expect(adapter.requests).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(result.build?.verification?.attempted).toBe(false);
  });

  it("detects verification scripts in a nested npm project created during the turn", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the nested npm app.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: { build: "vite build" },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will run the nested build.",
        toolName: "exec_command",
        toolInput: {
          command: "cd black && npm run build",
        },
      }),
      createTextResponse("I created the nested app and cd black && npm run build passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "built",
      stderr: "",
      timedOut: false,
    })));

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        maxSteps: 4,
      });

      const result = await engine.run("Create a nested npm app in black.");

      expect(result.text).toBe("I created the nested app and cd black && npm run build passed.");
      expect(adapter.requests).toHaveLength(3);
      expect(result.build?.verification?.passed).toBe(true);
      expect(result.build?.verification?.latestAttempt?.command).toBe("cd black && npm run build");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("accepts npm test shorthand as meaningful build verification", async () => {
    const workingDirectory = await createWorkspaceWithPackageJson({
      test: "node validate.mjs",
    });
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the file.",
        toolName: "write_file",
        toolInput: {
          path: "src/main.ts",
          content: "console.log('hi');",
        },
      }),
      createToolCallResponse({
        text: "I will run npm test.",
        toolName: "exec_command",
        toolInput: {
          command: "npm test",
        },
      }),
      createTextResponse("I created the file and npm test passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 3,
    });

    const result = await engine.run("Create the file.");

    expect(result.text).toBe("I created the file and npm test passed.");
    expect(result.build?.verification?.passed).toBe(true);
    expect(result.build?.verification?.latestAttempt?.command).toBe("npm test");
  });

  it("does not require finalize_build evidence after validation by default", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the black hole simulator package.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: { build: "vite build" },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will run the build.",
        toolName: "exec_command",
        toolInput: {
          command: "cd black && npm run build",
        },
      }),
      createTextResponse("Done. The black hole simulator package builds with npm."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "built",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        maxSteps: 4,
      });

      const result = await engine.run("Create a black hole simulator in a folder called black.");

      expect(result.text).toBe("Done. The black hole simulator package builds with npm.");
      expect(adapter.requests).toHaveLength(3);
      expect(result.build?.verification?.passed).toBe(true);
      expect(result.build?.finalization).toBeUndefined();
      expect(result.build?.verifier).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not require duplicate finalize_build evidence when later validation does not mutate files", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG.",
        toolName: "write_file",
        toolInput: {
          path: "cat-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Cat</title><desc>Cat on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will validate the SVG markup.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout cat-bicycle.svg",
        },
      }),
      createToolCallResponse({
        text: "I will record completion evidence.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created and validated cat-bicycle.svg.",
          artifacts: ["cat-bicycle.svg"],
          validation: [{
            command: "xmllint --noout cat-bicycle.svg",
            status: "passed",
          }],
          instructionChecklist: [
            "Created an SVG file.",
            "Kept the topic as a cat on a bicycle.",
            "Validated the SVG.",
          ],
        },
      }),
      createToolCallResponse({
        text: "I will run a second non-mutating parser check.",
        toolName: "exec_command",
        toolInput: {
          command: "node validate-svgs.mjs",
        },
      }),
      createTextResponse("Done. cat-bicycle.svg was created and parser validation passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          requireFinalizationAfterMutation: true,
          completionVerifier: "deterministic",
        },
        maxSteps: 6,
      });

      const result = await engine.run("Create an SVG of a cat on a bicycle.");

      expect(result.text).toBe("Done. cat-bicycle.svg was created and parser validation passed.");
      expect(adapter.requests).toHaveLength(5);
      expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
        "write_file",
        "exec_command",
        FINALIZE_BUILD_TOOL_NAME,
        "exec_command",
      ]);
      expect(result.build?.finalization?.passed).toBe(true);
      expect(result.build?.verification?.latestAttempt?.command).toBe("node validate-svgs.mjs");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not auto-coach weak finalize_build evidence toward later validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG.",
        toolName: "write_file",
        toolInput: {
          path: "svg4/cat-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Cat</title><desc>Cat on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will list the output folder.",
        toolName: "exec_command",
        toolInput: {
          command: "ls svg4/",
        },
      }),
      createToolCallResponse({
        text: "I will record completion evidence.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created cat-bicycle.svg.",
          artifacts: ["svg4/cat-bicycle.svg"],
          validation: [{
            command: "ls svg4/",
            status: "passed",
          }],
          instructionChecklist: [
            "Created the svg4 folder.",
            "Created an SVG file.",
            "Kept the topic as a cat on a bicycle.",
          ],
        },
      }),
      createTextResponse("I created svg4/cat-bicycle.svg and listed the folder."),
      createToolCallResponse({
        text: "I will run the parser validation.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout svg4/cat-bicycle.svg",
        },
      }),
      createTextResponse("Done. svg4/cat-bicycle.svg was created and xmllint passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          requireFinalizationAfterMutation: true,
          completionVerifier: "deterministic",
        },
        maxSteps: 6,
      });

      const result = await engine.run("Create an SVG of a cat on a bicycle in a folder called svg4.");

      expect(result.text).toBe("I created svg4/cat-bicycle.svg and listed the folder.");
      expect(adapter.requests).toHaveLength(4);
      expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
        "write_file",
        "exec_command",
        FINALIZE_BUILD_TOOL_NAME,
      ]);
      expect(result.build?.verification?.attempted).toBe(false);
      expect(result.build?.finalization).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("accepts a final user summary paired with the finalize_build tool call", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG.",
        toolName: "write_file",
        toolInput: {
          path: "cat-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Cat</title><desc>Cat on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will validate the SVG markup.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout cat-bicycle.svg",
        },
      }),
      createToolCallResponse({
        text: "Done. cat-bicycle.svg was created and parser validation passed.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created and validated cat-bicycle.svg.",
          artifacts: ["cat-bicycle.svg"],
          validation: [{
            command: "xmllint --noout cat-bicycle.svg",
            status: "passed",
          }],
          instructionChecklist: [
            "Created an SVG file.",
            "Kept the topic as a cat on a bicycle.",
            "Validated the SVG.",
          ],
        },
      }),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          requireFinalizationAfterMutation: true,
          completionVerifier: "deterministic",
        },
        maxSteps: 3,
      });

      const result = await engine.run("Create an SVG of a cat on a bicycle.");

      expect(result.text).toBe("Done. cat-bicycle.svg was created and parser validation passed.");
      expect(adapter.requests).toHaveLength(3);
      expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
        "write_file",
        "exec_command",
        FINALIZE_BUILD_TOOL_NAME,
      ]);
      expect(result.build?.verification?.passed).toBe(true);
      expect(result.build?.finalization?.passed).toBe(true);
      expect(result.build?.verifier?.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects finalize_build validation commands that were not actually observed", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG.",
        toolName: "write_file",
        toolInput: {
          path: "cat-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Cat</title><desc>Cat on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will validate the SVG markup.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout cat-bicycle.svg",
        },
      }),
      createToolCallResponse({
        text: "Done. cat-bicycle.svg was created.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created cat-bicycle.svg.",
          artifacts: ["cat-bicycle.svg"],
          validation: [{
            command: "ls svg3",
            status: "passed",
          }],
          instructionChecklist: [
            "Created an SVG file.",
            "Kept the topic as a cat on a bicycle.",
          ],
        },
      }),
      createToolCallResponse({
        text: "I will fix the completion evidence.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created and validated cat-bicycle.svg.",
          artifacts: ["cat-bicycle.svg"],
          validation: [{
            command: "xmllint --noout cat-bicycle.svg",
            status: "passed",
          }],
          instructionChecklist: [
            "Created an SVG file.",
            "Kept the topic as a cat on a bicycle.",
            "Validated the SVG.",
          ],
        },
      }),
      createTextResponse("Done. cat-bicycle.svg was created and parser validation passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          requireFinalizationAfterMutation: true,
          completionVerifier: "deterministic",
        },
        maxSteps: 5,
      });

      const result = await engine.run("Create an SVG of a cat on a bicycle.");

      expect(result.text).toBe("Done. cat-bicycle.svg was created and parser validation passed.");
      expect(adapter.requests).toHaveLength(5);
      expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
        "finalize_build must list a passing verification command that was observed after the latest file changes.",
      );
      expect(result.build?.finalization?.passed).toBe(true);
      expect(result.build?.finalization?.latestFinalization?.validation[0]?.command)
        .toBe("xmllint --noout cat-bicycle.svg");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("records artifact-only SVG turns without auto-coaching parser validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the animal bicycle SVG.",
        toolName: "write_file",
        toolInput: {
          path: "cat-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"50\" r=\"20\" /></svg>\n",
        },
      }),
      createTextResponse("I created cat-bicycle.svg."),
      createToolCallResponse({
        text: "I will validate the SVG with an XML parser.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout cat-bicycle.svg",
        },
      }),
      createTextResponse("I created cat-bicycle.svg and xmllint passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Create a cat on a bicycle as an SVG.");

    expect(result.text).toBe("I created cat-bicycle.svg.");
    expect(adapter.requests).toHaveLength(2);
    expect(result.build?.verification?.attempted).toBe(false);
    expect(result.build?.verification?.recommendedCommands).toContain("xmllint --noout cat-bicycle.svg");
  });

  it("recognizes focused Node artifact validators as meaningful SVG verification", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create several animal bicycle SVGs.",
        toolName: "write_file",
        toolInput: {
          path: "fox-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"100\" height=\"100\" /></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will run the SVG validator.",
        toolName: "exec_command",
        toolInput: {
          command: "node validate-svgs.mjs",
        },
      }),
      createTextResponse("I created fox-bicycle.svg and node validate-svgs.mjs passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "all svg files parsed",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 3,
    });

    const result = await engine.run("Create a fox on a bicycle as an SVG.");

    expect(result.text).toBe("I created fox-bicycle.svg and node validate-svgs.mjs passed.");
    expect(adapter.requests).toHaveLength(3);
  });

  it("continues after a fixable self-authored validation script failure", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG artifact.",
        toolName: "write_file",
        toolInput: {
          path: "owl-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Owl</title><desc>Owl on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will run the SVG validator.",
        toolName: "exec_command",
        toolInput: {
          command: "node validate-svgs.mjs",
        },
      }),
      createTextResponse("The validation script failed with a SyntaxError, so I will not re-attempt it."),
      createToolCallResponse({
        text: "I will fix the validator and rerun it.",
        toolName: "exec_command",
        toolInput: {
          command: "node validate-svgs.mjs",
        },
      }),
      createTextResponse("I fixed the validator and node validate-svgs.mjs passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    let commandAttempts = 0;
    registry.register(createExecCommandTool(async (input) => {
      commandAttempts += 1;
      return {
        command: input.command,
        exitCode: commandAttempts === 1 ? 1 : 0,
        stdout: commandAttempts === 1 ? "" : "all svg files parsed",
        stderr: commandAttempts === 1 ? "SyntaxError: Invalid or unexpected token" : "",
        timedOut: false,
      };
    }));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 5,
    });

    const result = await engine.run("Create an owl on a bicycle as an SVG.");

    expect(result.text).toBe("I fixed the validator and node validate-svgs.mjs passed.");
    expect(adapter.requests).toHaveLength(5);
    expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
      "The latest verification command failed: node validate-svgs.mjs (exit 1).",
    );
  });

  it("tracks SVG artifacts created by shell redirection without auto-coaching validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the SVG through a shell command.",
        toolName: "exec_command",
        toolInput: {
          command: "cat > axolotl-bicycle.svg <<'SVG'\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Axolotl</title><desc>Axolotl on a bicycle</desc></svg>\nSVG",
        },
      }),
      createTextResponse("I generated axolotl-bicycle.svg."),
      createToolCallResponse({
        text: "I will validate the shell-created SVG.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout axolotl-bicycle.svg",
        },
      }),
      createTextResponse("I generated axolotl-bicycle.svg and xmllint passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Create an axolotl on a bicycle as an SVG.");

    expect(result.text).toBe("I generated axolotl-bicycle.svg.");
    expect(adapter.requests).toHaveLength(2);
    expect(result.build?.verification?.attempted).toBe(false);
    expect(result.build?.verification?.recommendedCommands).toContain("xmllint --noout axolotl-bicycle.svg");
  });

  it("does not auto-coach when the assistant drafts file creation commands in markdown", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createTextResponse([
        "Here is the file:",
        "```bash",
        "cat <<'SVG' > axolotl-bicycle.svg",
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Axolotl</title><desc>Axolotl on a bicycle</desc></svg>",
        "SVG",
        "```",
      ].join("\n")),
      createToolCallResponse({
        text: "I will create the actual SVG file now.",
        toolName: "write_file",
        toolInput: {
          path: "axolotl-bicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Axolotl</title><desc>Axolotl on a bicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I will validate the SVG.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout axolotl-bicycle.svg",
        },
      }),
      createTextResponse("I created axolotl-bicycle.svg on disk and xmllint passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Create an axolotl on a bicycle as an SVG.");

    expect(result.text).toContain("Here is the file:");
    expect(adapter.requests).toHaveLength(1);
    expect(result.toolResults).toEqual([]);
    const historyText = engine.snapshot().history
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(historyText).toContain("Here is the file:");
  });

  it("does not auto-coach after a premature file-creation completion claim", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createTextResponse([
        "I have created the svg7 folder and populated it with 5 detailed SVGs.",
        "",
        "Files created:",
        "svg7/elephant_unicycle.svg",
        "svg7/giraffe_unicycle.svg",
      ].join("\n")),
      createToolCallResponse({
        text: "I'm creating the actual SVG file now because the previous message did not write it to disk.",
        toolName: "write_file",
        toolInput: {
          path: "svg7/elephant_unicycle.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Elephant</title><desc>Elephant on a unicycle</desc></svg>\n",
        },
      }),
      createToolCallResponse({
        text: "I'm validating the SVG as XML because generated SVGs should parse cleanly.",
        toolName: "exec_command",
        toolInput: {
          command: "xmllint --noout svg7/elephant_unicycle.svg",
        },
      }),
      createTextResponse("I created svg7/elephant_unicycle.svg on disk and xmllint passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Create five animal unicycle SVGs in svg7.");

    expect(result.text).toContain("I have created the svg7 folder");
    expect(adapter.requests).toHaveLength(1);
    expect(result.toolResults).toEqual([]);
    const historyText = engine.snapshot().history
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(historyText).toContain("I have created the svg7 folder");
  });

  it("continues the turn after failed verification when the assistant has not stated a concrete blocker", async () => {
    const workingDirectory = await createWorkspaceWithPackageJson({
      build: "vite build",
    });
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the file.",
        toolName: "write_file",
        toolInput: {
          path: "src/main.ts",
          content: "console.log('hi');",
        },
      }),
      createToolCallResponse({
        text: "I will run the build.",
        toolName: "exec_command",
        toolInput: {
          command: "npm run build",
        },
      }),
      createTextResponse("I updated the file."),
      createToolCallResponse({
        text: "I will rerun the build after fixing the issue.",
        toolName: "exec_command",
        toolInput: {
          command: "npm run build",
        },
      }),
      createTextResponse("I created the file and npm run build passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    let commandAttempts = 0;
    registry.register(createExecCommandTool(async (input) => {
      commandAttempts += 1;
      return {
        command: input.command,
        exitCode: commandAttempts === 1 ? 1 : 0,
        stdout: commandAttempts === 1 ? "" : "built",
        stderr: commandAttempts === 1 ? "src/main.ts:1:1: error" : "",
        timedOut: false,
      };
    }));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 5,
    });

    const result = await engine.run("Create the file.");

    expect(result.text).toBe("I created the file and npm run build passed.");
    expect(adapter.requests).toHaveLength(5);
    expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
      "The latest verification command failed: npm run build (exit 1).",
    );
  });

  it("treats a failed background dev server peek as failed build validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the nested npm app.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: {
              dev: "vite",
              build: "vite build",
            },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will inspect the dev server.",
        toolName: "peek_background_process",
        toolInput: {
          processId: "terminal-1",
        },
      }),
      createTextResponse("I checked the server."),
      createToolCallResponse({
        text: "I will fix it by running the build path.",
        toolName: "exec_command",
        toolInput: {
          command: "cd black && npm run build",
        },
      }),
      createTextResponse("I fixed the dev-server issue and cd black && npm run build passed."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createPeekBackgroundProcessTool({
      command: "cd black && npm run dev",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find native binding",
      timedOut: false,
    }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "built",
      stderr: "",
      timedOut: false,
    })));

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        maxSteps: 5,
      });

      const result = await engine.run("Create a nested npm app in black.");

      expect(result.text).toBe("I fixed the dev-server issue and cd black && npm run build passed.");
      expect(adapter.requests).toHaveLength(5);
      expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
        "The latest verification command failed: cd black && npm run dev (exit 1).",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("accepts a running background dev server peek as passing build validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the nested npm app.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: {
              dev: "vite",
              build: "vite build",
            },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will inspect the running dev server.",
        toolName: "peek_background_process",
        toolInput: {
          processId: "terminal-1",
        },
      }),
      createToolCallResponse({
        text: "The app is running and verified.",
        toolName: FINALIZE_BUILD_TOOL_NAME,
        toolInput: {
          summary: "Created a Vite app in black.",
          artifacts: ["black/package.json"],
          validation: [{
            command: "npm run dev",
            status: "passed",
          }],
          instructionChecklist: [
            "Created the black folder.",
            "Created an npm web app.",
            "Verified the dev server starts.",
          ],
        },
      }),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createPeekBackgroundProcessTool({
      command: "cd black && npm run dev",
      exitCode: null,
      stdout: "VITE v8.0.10 ready in 342 ms\nLocal: http://localhost:5173/",
      stderr: "",
      timedOut: false,
    }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));
    registry.register(createFinalizeBuildTool());

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          requireFinalizationAfterMutation: true,
          completionVerifier: "off",
        },
        maxSteps: 3,
      });

      const result = await engine.run("Create a nested npm app in black.");

      expect(result.text).toBe("The app is running and verified.");
      expect(adapter.requests).toHaveLength(3);
      expect(result.build?.verification?.passed).toBe(true);
      expect(result.build?.verification?.latestAttempt?.command).toBe("cd black && npm run dev");
      expect(result.build?.finalization?.passed).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("accepts successful Project Browser evidence after mutation as passing build validation", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the nested web app.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: { build: "vite build" },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will verify it in the Project Browser.",
        toolName: "open_project_browser",
        toolInput: {
          url: "http://localhost:5173/",
        },
      }),
      createTextResponse("Done. The web app loads in the Project Browser with no console errors."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createOpenProjectBrowserTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        maxSteps: 4,
      });

      const result = await engine.run("Create a nested web app in black.");

      expect(result.text).toBe("Done. The web app loads in the Project Browser with no console errors.");
      expect(adapter.requests).toHaveLength(3);
      expect(result.build?.verification?.passed).toBe(true);
      expect(result.build?.verification?.latestAttempt).toBeUndefined();
      expect(result.build?.verification?.latestBrowserEvidence).toMatchObject({
        toolName: "open_project_browser",
        readyState: "complete",
        consoleErrorCount: 0,
        timedOut: false,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects completion after failed Project Browser verification without a concrete blocker", async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-build-mode-"));
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the nested web app.",
        toolName: "write_file",
        toolInput: {
          path: "black/package.json",
          content: JSON.stringify({
            scripts: { build: "vite build" },
          }),
        },
      }),
      createToolCallResponse({
        text: "I will verify it in the Project Browser.",
        toolName: "open_project_browser",
        toolInput: {
          url: "http://localhost:5173/",
        },
      }),
      createTextResponse("Done. The web app loads in the Project Browser."),
      createTextResponse("Done. The web app loads in the Project Browser."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool({ writeToDisk: true }));
    registry.register(createOpenProjectBrowserTool({
      title: "Gemma",
      excerpt: "Gemma Desktop",
      consoleErrorCount: 4,
    }));
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })));

    const originalCwd = process.cwd();
    process.chdir(workingDirectory);
    try {
      const engine = new SessionEngine({
        adapter,
        model: "mock-model",
        mode: "build",
        workingDirectory,
        tools: new ToolRuntime({ registry }),
        buildPolicy: {
          verificationContinuationLimit: 1,
        },
        maxSteps: 5,
      });

      await expect(engine.run("Create a nested web app in black.")).rejects.toThrow(
        "Build turn ended with failing verification and no concrete blocker.",
      );
      expect(adapter.requests).toHaveLength(4);
      expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
        "The latest browser/runtime verification failed or was inconclusive",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("allows a concrete blocker after a failed verification command", async () => {
    const workingDirectory = await createWorkspaceWithPackageJson({
      build: "vite build",
    });
    cleanup.push(workingDirectory);

    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the file.",
        toolName: "write_file",
        toolInput: {
          path: "src/main.ts",
          content: "console.log('hi');",
        },
      }),
      createToolCallResponse({
        text: "I will run the build.",
        toolName: "exec_command",
        toolInput: {
          command: "npm run build",
        },
      }),
      createTextResponse("The build failed because vite is missing, so I stopped there."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExecCommandTool(async (input) => ({
      command: input.command,
      exitCode: 1,
      stdout: "",
      stderr: "sh: vite: command not found",
      timedOut: false,
    })));

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory,
      tools: new ToolRuntime({ registry }),
      maxSteps: 3,
    });

    const result = await engine.run("Create the file.");

    expect(result.text).toBe("The build failed because vite is missing, so I stopped there.");
    expect(adapter.requests).toHaveLength(3);
  });
});
