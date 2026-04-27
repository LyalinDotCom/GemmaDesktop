import { describe, expect, it } from "vitest";
import {
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
}): ChatResponse {
  return {
    text: input.text,
    content: [{ type: "text", text: input.text }],
    toolCalls: [
      {
        id: `call_${input.toolName}`,
        name: input.toolName,
        input: input.toolInput,
      },
    ],
  };
}

function createReasoningOnlyResponse(reasoning: string): ChatResponse {
  return {
    text: "",
    reasoning,
    content: [],
    toolCalls: [],
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

function createWriteFileTool(): RegisteredTool<{ path: string; content: string }> {
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
    async execute(input) {
      return {
        output: `Wrote ${input.path}`,
        structuredOutput: {
          path: input.path,
          ok: true,
        },
      };
    },
  };
}

function createFailingWriteFileTool(): RegisteredTool<{ path: string; content: string }> {
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
    async execute() {
      throw new Error("Disk is full.");
    },
  };
}

describe("final assistant message after tool use", () => {
  it("continues the turn until the assistant provides user-facing text after tools", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will create the Vite files now.",
        toolName: "write_file",
        toolInput: {
          path: "package.json",
          content: "{\"name\":\"demo\"}",
        },
      }),
      createReasoningOnlyResponse("The files are in place."),
      createTextResponse("I created the scaffold files. I have not verified the app yet."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({ registry }),
      maxSteps: 4,
    });

    const result = await engine.run("Scaffold the app.");

    expect(result.text).toBe("I created the scaffold files. I have not verified the app yet.");
    expect(adapter.requests).toHaveLength(3);
    expect(collectSystemText(adapter.requests[2]?.messages ?? [])).toContain(
      "You already used tools in this turn.",
    );
  });

  it("returns completed tool work when the turn exhausts its summary retry after successful tools", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will write the file.",
        toolName: "write_file",
        toolInput: {
          path: "index.html",
          content: "<!doctype html>",
        },
      }),
      createReasoningOnlyResponse("The file exists now."),
      createReasoningOnlyResponse("The file still exists now."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({ registry }),
      maxSteps: 3,
    });

    const result = await engine.run("Create index.html.");

    expect(result.text).toBe("");
    expect(result.reasoning).toBe("The file still exists now.");
    expect(result.toolResults).toHaveLength(1);
    expect(adapter.requests).toHaveLength(3);
    expect(collectSystemText(adapter.requests[2]?.messages ?? [])).toContain(
      "Now send a short user-facing completion message.",
    );
  });

  it("still fails when tool work failed and the model gives no user-facing explanation", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will write the file.",
        toolName: "write_file",
        toolInput: {
          path: "index.html",
          content: "<!doctype html>",
        },
      }),
      createReasoningOnlyResponse("The file was not written."),
    ]);

    const registry = new ToolRegistry();
    registry.register(createFailingWriteFileTool());

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({ registry }),
      maxSteps: 2,
    });

    await expect(engine.run("Create index.html.")).rejects.toMatchObject({
      kind: "transport_error",
      message: "Turn used tools but finished without a user-facing completion message.",
    });
  });

  it("throws when the turn exhausts immediately after a tool call", async () => {
    const adapter = new MockAdapter([
      createToolCallResponse({
        text: "I will write the file.",
        toolName: "write_file",
        toolInput: {
          path: "index.html",
          content: "<!doctype html>",
        },
      }),
    ]);

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());

    const engine = new SessionEngine({
      adapter,
      model: "mock-model",
      mode: "build",
      workingDirectory: process.cwd(),
      tools: new ToolRuntime({ registry }),
      maxSteps: 1,
    });

    await expect(engine.run("Create index.html.")).rejects.toThrow(
      "Turn reached the maximum step count immediately after tool use",
    );
  });
});
