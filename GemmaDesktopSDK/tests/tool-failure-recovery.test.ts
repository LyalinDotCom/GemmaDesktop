import { describe, expect, it } from "vitest";
import {
  GemmaDesktopError,
  SessionEngine,
  contentPartsToText,
  type AdapterStreamEvent,
  type ChatRequest,
  type ChatResponse,
  type RuntimeAdapter,
  type RuntimeInspectionResult,
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
  reasoning?: string;
}): ChatResponse {
  return {
    text: input.text,
    content: [{ type: "text", text: input.text }],
    reasoning: input.reasoning,
    toolCalls: [
      {
        id: `call_${input.toolName}`,
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

function collectSystemText(messages: readonly ChatRequest["messages"][number][]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => contentPartsToText(message.content))
    .join("\n");
}

describe("tool failure recovery", () => {
  it("continues the turn after a tool returns structured failure metadata", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will initialize the project.",
        toolName: "exec_command",
        toolInput: {
          command: "cd .tmp && npm init -y",
        },
      }),
      createTextResponse(
        "The npm init command failed because .tmp is not a valid package name. I would recover by writing package.json directly with a valid name.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "exec_command",
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        return {
          output: "Command failed with exit code 1.\nnpm error Invalid name: \".tmp\"",
          structuredOutput: {
            ok: false,
            command: "cd .tmp && npm init -y",
            exitCode: 1,
            stdout: "",
            stderr: "npm error Invalid name: \".tmp\"",
            timedOut: false,
          },
          metadata: {
            toolError: true,
            errorKind: "nonzero_exit",
          },
        };
      },
    });

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 4,
    });

    const result = await engine.run("Create a web project in .tmp.");

    expect(result.text).toContain("writing package.json directly");
    expect(result.toolResults[0]?.metadata).toMatchObject({
      toolError: true,
      errorKind: "nonzero_exit",
    });
    expect(adapter.requests).toHaveLength(2);
    expect(collectSystemText(adapter.requests[1]?.messages ?? [])).toContain(
      "One or more tool calls in your previous step failed.",
    );
    expect(result.events.find((event) =>
      event.type === "tool.result"
      && (event.payload as Record<string, unknown>).error === result.toolResults[0]?.output
    )).toBeDefined();
  });

  it("preserves assistant reasoning on tool-call history during the same tool loop", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will inspect the file.",
        reasoning: "I need the file contents before I can answer.",
        toolName: "read_file",
        toolInput: {
          path: "package.json",
        },
      }),
      createTextResponse("The file is a package manifest."),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        return {
          output: "{\"name\":\"example\"}",
        };
      },
    });

    const engine = new SessionEngine({
      adapter,
      model: "gemma4:31b",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 4,
    });

    const result = await engine.run("What kind of file is package.json?");

    expect(result.text).toContain("package manifest");
    expect(adapter.requests).toHaveLength(2);

    const assistantToolMessage = adapter.requests[1]?.messages.find(
      (message) =>
        message.role === "assistant"
        && Array.isArray(message.toolCalls)
        && message.toolCalls.length === 1,
    );
    expect(assistantToolMessage?.reasoning).toBe(
      "I need the file contents before I can answer.",
    );
    expect(contentPartsToText(assistantToolMessage?.content ?? [])).toBe("");

    const persistedAssistantToolMessage = engine.snapshot().history.find(
      (message) =>
        message.role === "assistant"
        && Array.isArray(message.toolCalls)
        && message.toolCalls.length === 1,
    );
    expect(persistedAssistantToolMessage?.reasoning).toBe(
      "I need the file contents before I can answer.",
    );
  });

  it("forces a no-tool recovery step after repeated same-pattern tool failures", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will initialize the project.",
        toolName: "exec_command",
        toolInput: {
          command: "mkdir -p .tmp && cd .tmp && npm init -y",
        },
      }),
      createToolCallResponse({
        text: "I will retry with a package name.",
        toolName: "exec_command",
        toolInput: {
          command: "cd .tmp && npm init --name \"black-hole-sim\" -y",
        },
      }),
      createToolCallResponse({
        text: "I will retry with the flag at the end.",
        toolName: "exec_command",
        toolInput: {
          command: "mkdir -p .tmp && cd .tmp && npm init -y --name \"black-hole-sim\"",
        },
      }),
      createTextResponse(
        "The repeated blocker is npm deriving an invalid package name from .tmp. The recovery is to create package.json directly with a valid name instead of retrying npm init.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "exec_command",
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { command: string }) {
        return {
          output: [
            "Command failed with exit code 1.",
            "npm error Invalid name: \".tmp\"",
            `npm error A complete log of this run can be found in: /tmp/${input.command.length}/npm-debug.log`,
          ].join("\n"),
          structuredOutput: {
            ok: false,
            command: input.command,
            exitCode: 1,
            stdout: "",
            stderr: "npm error Invalid name: \".tmp\"",
            timedOut: false,
          },
          metadata: {
            toolError: true,
            errorKind: "nonzero_exit",
          },
        };
      },
    });

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 6,
    });

    const result = await engine.run("Create a web project in .tmp.");

    expect(result.text).toContain("create package.json directly");
    expect(result.toolResults).toHaveLength(3);
    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests[3]?.tools).toEqual([]);
    expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
      "A tool call has repeatedly failed with the same failure pattern.",
    );
    expect(result.warnings.some((warning) =>
      warning.includes("failed with the same pattern 3 times")
    )).toBe(true);
  });

  it("forces a no-tool recovery step after repeated identical tool calls", async () => {
    const repeatedRead = {
      path: "package.json",
    };
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will read the file.",
        toolName: "read_file",
        toolInput: repeatedRead,
      }),
      createToolCallResponse({
        text: "I will read it again.",
        toolName: "read_file",
        toolInput: {
          path: "package.json",
        },
      }),
      createToolCallResponse({
        text: "I will read it once more.",
        toolName: "read_file",
        toolInput: {
          path: "package.json",
        },
      }),
      createTextResponse(
        "The same read_file call repeated without new information, so I am stopping the loop and using the existing package.json evidence.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        return {
          output: "{\"name\":\"example\"}",
        };
      },
    });

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 6,
    });

    const result = await engine.run("Inspect package.json.");

    expect(result.text).toContain("stopping the loop");
    expect(result.toolResults).toHaveLength(2);
    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests[3]?.tools).toEqual([]);
    expect(collectSystemText(adapter.requests[3]?.messages ?? [])).toContain(
      "A tool call has repeated unchanged in this turn.",
    );
    expect(result.warnings.some((warning) =>
      warning.includes("repeated the same input 3 times")
    )).toBe(true);
  });

  it("continues the turn after a recoverable tool failure and persists only the tool-call structure", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I corrected the files.",
        toolName: "edit_file",
        toolInput: {
          path: "src/main.js",
          oldText: "OrbitControls",
          newText: "OrbitControls",
        },
      }),
      createTextResponse(
        "The edit failed because the target text was stale. I need a refreshed snapshot before I can finish it cleanly.",
      ),
    ]);

    const registry = new ToolRegistry();
    const editFileTool: RegisteredTool<{
      path: string;
      oldText: string;
      newText: string;
    }> = {
      name: "edit_file",
      description: "Edit part of a file.",
      inputSchema: {
        type: "object",
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        throw new Error(
          "Found 2 matches in src/main.js; set replaceAll to true or provide a more specific oldText.",
        );
      },
    };
    registry.register(editFileTool);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 4,
    });

    const result = await engine.run("Make the import compatible with npm.");

    expect(result.text).toContain("target text was stale");
    const failedToolResult = result.toolResults.find(
      (entry) => entry.toolName === "edit_file",
    );
    expect(failedToolResult).toBeDefined();
    expect(failedToolResult?.metadata).toMatchObject({
      toolError: true,
      errorKind: "tool_execution_failed",
    });
    expect(failedToolResult?.structuredOutput).toMatchObject({
      ok: false,
      error: 'Tool "edit_file" failed.',
      errorKind: "tool_execution_failed",
      causeMessage:
        "Found 2 matches in src/main.js; set replaceAll to true or provide a more specific oldText.",
    });
    expect(failedToolResult?.output).toContain('Tool "edit_file" failed.');
    expect(failedToolResult?.output).toContain("Cause: Found 2 matches in src/main.js");
    expect(adapter.requests).toHaveLength(2);

    const secondRequest = adapter.requests[1];
    expect(secondRequest).toBeDefined();
    expect(collectSystemText(secondRequest?.messages ?? [])).toContain(
      "One or more tool calls in your previous step failed.",
    );

    const assistantToolMessage = secondRequest?.messages.find(
      (message) =>
        message.role === "assistant"
        && Array.isArray(message.toolCalls)
        && message.toolCalls.length === 1,
    );
    expect(assistantToolMessage).toBeDefined();
    expect(contentPartsToText(assistantToolMessage?.content ?? [])).toBe("");

    const toolMessage = secondRequest?.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage).toBeDefined();
    expect(contentPartsToText(toolMessage?.content ?? [])).toContain(
      'Tool "edit_file" failed.',
    );
    expect(contentPartsToText(toolMessage?.content ?? [])).toContain(
      "Cause: Found 2 matches in src/main.js",
    );

    const snapshot = engine.snapshot();
    const persistedAssistantToolMessage = snapshot.history.find(
      (message) =>
        message.role === "assistant"
        && Array.isArray(message.toolCalls)
        && message.toolCalls.length === 1,
    );
    expect(persistedAssistantToolMessage).toBeDefined();
    expect(contentPartsToText(persistedAssistantToolMessage?.content ?? [])).toBe("");
  });

  it("keeps active-tool-surface errors non-recoverable", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will write the file now.",
        toolName: "write_file",
        toolInput: {
          path: "index.html",
          content: "<html></html>",
        },
      }),
    ]);

    const registry = new ToolRegistry();
    const writeFileTool: RegisteredTool<{
      path: string;
      content: string;
    }> = {
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
      async execute() {
        return {
          output: "ok",
        };
      },
    };
    registry.register(writeFileTool);
    registry.register({
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        return {
          output: "ok",
        };
      },
    } satisfies RegisteredTool<{ path: string }>);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
        toolNames: ["read_file"],
      }),
      maxSteps: 4,
    });

    await expect(engine.run("Write index.html.")).rejects.toMatchObject({
      message: 'Tool "write_file" is not registered in the active tool surface.',
    });
    expect(adapter.requests).toHaveLength(1);

    const snapshot = engine.snapshot();
    const assistantToolMessage = snapshot.history.find(
      (message) =>
        message.role === "assistant"
        && Array.isArray(message.toolCalls)
        && message.toolCalls.length === 1,
    );
    expect(assistantToolMessage).toBeDefined();
    expect(contentPartsToText(assistantToolMessage?.content ?? [])).toBe("");
  });

  it("continues non-build turns when a post-failure reply only promises another attempt", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "Let me check the flight tracker.",
        toolName: "fetch_url",
        toolInput: {
          url: "https://example.com/flight-status",
        },
      }),
      createTextResponse(
        "I'll try to find a more direct way to confirm the live status.",
      ),
      createTextResponse(
        "I couldn't confirm the live status because the available fetch failed, so I don't have grounded evidence from that source yet.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "fetch_url",
      description: "Fetch a URL.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        throw new Error("Failed to fetch https://example.com/flight-status: 403");
      },
    } satisfies RegisteredTool<{ url: string }>);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "cowork",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 4,
    });

    const result = await engine.run("Check JetBlue 1707 on their website.");

    expect(result.text).toContain("couldn't confirm the live status");
    expect(adapter.requests).toHaveLength(3);

    const thirdRequest = adapter.requests[2];
    expect(thirdRequest).toBeDefined();
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "Do not promise another attempt or say that you will keep looking.",
    );
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "either answer the user now or state the exact blocker plainly",
    );
  });

  it("continues non-build turns when a post-tool reply only announces the next lookup", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I'll search for the flight first.",
        toolName: "search_web",
        toolInput: {
          query: "JetBlue 1707 flight status",
        },
      }),
      createTextResponse(
        "I couldn't find the real-time status for JetBlue flight 1707 in the initial search. I'll try to look it up on a flight tracking service.",
      ),
      createToolCallResponse({
        text: "Opening FlightAware now.",
        toolName: "browser",
        toolInput: {
          action: "open",
          url: "https://flightaware.com/live/flight/B61707",
        },
      }),
      createTextResponse(
        "FlightAware couldn't find tracking data for B61707 yet, so I still can't confirm the live status from that source.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "search_web",
      description: "Search the web.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        return {
          output: "Returned broad search results that did not include a live status card.",
          structuredOutput: {
            ok: true,
          },
        };
      },
    } satisfies RegisteredTool<{ query: string }>);
    registry.register({
      name: "browser",
      description: "Use a browser.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string" },
          url: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute() {
        return {
          output: "Opened the requested flight tracking page.",
          structuredOutput: {
            ok: true,
          },
        };
      },
    } satisfies RegisteredTool<{ action: string; url?: string }>);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "cowork",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 6,
    });

    const result = await engine.run("Check JetBlue 1707 on their website.");

    expect(result.text).toContain("couldn't find tracking data");
    expect(adapter.requests).toHaveLength(4);

    const thirdRequest = adapter.requests[2];
    expect(thirdRequest).toBeDefined();
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "You already used tools in this turn.",
    );
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "If another materially different tool call is still needed, emit it now.",
    );
  });

  it("continues build turns when a post-tool reply only narrates partial browser progress", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "Opening JetBlue now.",
        toolName: "browser",
        toolInput: {
          action: "open",
          url: "https://www.jetblue.com",
        },
      }),
      createTextResponse(
        'I clicked on "Travel Info" to find the flight status section.',
      ),
      createToolCallResponse({
        text: "Checking the flight-status page now.",
        toolName: "browser",
        toolInput: {
          action: "snapshot",
        },
      }),
      createTextResponse(
        "JetBlue's tracker shows flight 1707 is en route to Las Vegas.",
      ),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "browser",
      description: "Use a browser.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string" },
          url: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute() {
        return {
          output: "Browser action completed.",
          structuredOutput: {
            ok: true,
          },
        };
      },
    } satisfies RegisteredTool<{ action: string; url?: string }>);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 6,
    });

    const result = await engine.run("Check JetBlue 1707 on their website.");

    expect(result.text).toContain("en route to Las Vegas");
    expect(adapter.requests).toHaveLength(4);

    const thirdRequest = adapter.requests[2];
    expect(thirdRequest).toBeDefined();
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "You already used tools in this turn.",
    );
    expect(collectSystemText(thirdRequest?.messages ?? [])).toContain(
      "If another materially different tool call is still needed, emit it now.",
    );
  });

  it("throws a clear recovery-exhausted error after repeated tool failures", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I updated the file.",
        toolName: "edit_file",
        toolInput: {
          path: "src/main.js",
          oldText: "OrbitControls",
          newText: "OrbitControls",
        },
      }),
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "edit_file",
      description: "Edit part of a file.",
      inputSchema: {
        type: "object",
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute() {
        throw new GemmaDesktopError(
          "tool_execution_failed",
          "Target text was stale.",
        );
      },
    } satisfies RegisteredTool<{
      path: string;
      oldText: string;
      newText: string;
    }>);

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({
        registry,
      }),
      maxSteps: 1,
    });

    await expect(engine.run("Apply the edit.")).rejects.toMatchObject({
      message: 'Tool "edit_file" failed and no steps remain for recovery.',
    });

    const snapshot = engine.snapshot();
    const toolMessage = [...snapshot.history].reverse().find(
      (message) => message.role === "tool",
    );
    expect(contentPartsToText(toolMessage?.content ?? [])).toContain(
      'Tool "edit_file" failed.',
    );
  });
});
