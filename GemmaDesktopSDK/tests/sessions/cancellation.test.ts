import { describe, expect, it } from "vitest";
import {
  GemmaDesktopError,
  SessionEngine,
  type AdapterStreamEvent,
  type ChatRequest,
  type ChatResponse,
  type RuntimeAdapter,
  type RuntimeInspectionResult,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResult,
} from "@gemma-desktop/sdk-core";

const DELEGATE_TOOL: ToolDefinition = {
  name: "delegate_task",
  description: "Delegate work to a child session.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
  },
};

function createToolCallResponse(): ChatResponse {
  return {
    text: "",
    content: [],
    toolCalls: [
      {
        id: "call_delegate",
        name: DELEGATE_TOOL.name,
        input: {},
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class MockAdapter implements RuntimeAdapter {
  public readonly identity = {
    id: "mock-runtime",
    family: "unknown" as const,
    kind: "server" as const,
    displayName: "Mock Runtime",
    endpoint: "http://mock.local",
  };

  private requestCount = 0;

  public async inspect(): Promise<RuntimeInspectionResult> {
    return createInspectionResult(this.identity);
  }

  public async generate(): Promise<ChatResponse> {
    throw new Error("Mock adapter generate() is not used in this test.");
  }

  public async *stream(request: ChatRequest): AsyncIterable<AdapterStreamEvent> {
    const callIndex = this.requestCount++;
    if (callIndex === 0) {
      yield {
        type: "response.complete",
        response: createToolCallResponse(),
      };
      return;
    }

    if (request.signal?.aborted) {
      throw new GemmaDesktopError("cancellation", "Turn cancelled.");
    }

    yield {
      type: "response.complete",
      response: createTextResponse("done"),
    };
  }
}

function createDelegatingTools(
  execute: (context: Parameters<ToolExecutor["execute"]>[1]) => Promise<Omit<ToolResult, "callId" | "toolName">>,
): ToolExecutor {
  return {
    listTools() {
      return [DELEGATE_TOOL];
    },
    async execute(toolCall, context) {
      const result = await execute(context);
      return {
        callId: toolCall.id,
        toolName: toolCall.name,
        ...result,
      };
    },
  };
}

describe("session cancellation", () => {
  it("forwards the parent abort signal into delegated subsessions", async () => {
    let forwardedSignal: AbortSignal | undefined;

    const engine = new SessionEngine({
      adapter: new MockAdapter(),
      model: "mock-model",
      mode: "cowork",
      workingDirectory: process.cwd(),
      tools: createDelegatingTools(async (context) => {
        const child = await context.runSubsession?.({
          prompt: "Child task",
        });

        return {
          output: child?.outputText ?? "missing child result",
        };
      }),
      runSubsession: async (request) => {
        forwardedSignal = request.signal;
        return {
          sessionId: "child-session",
          turnId: "child-turn",
          events: [],
          outputText: "child complete",
        };
      },
    });

    const controller = new AbortController();
    const result = await engine.run("Start", {
      signal: controller.signal,
    });

    expect(result.text).toBe("done");
    expect(forwardedSignal).toBe(controller.signal);
  });

  it("closes the streamed event queue immediately after cancellation", async () => {
    const engine = new SessionEngine({
      adapter: new MockAdapter(),
      model: "mock-model",
      mode: "cowork",
      workingDirectory: process.cwd(),
      tools: createDelegatingTools(async () => {
        await sleep(120);
        return {
          output: "finished too late",
        };
      }),
    });

    const controller = new AbortController();
    const streamed = await engine.runStreamed("Start", {
      signal: controller.signal,
    });
    const iterator = streamed.events[Symbol.asyncIterator]();

    let sawToolCall = false;
    while (!sawToolCall) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error("Event stream ended before the tool call was emitted.");
      }
      sawToolCall = next.value.type === "tool.call";
    }

    controller.abort();

    const afterAbort = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 40);
      }),
    ]);

    expect(afterAbort).not.toBe("timeout");
    if (afterAbort !== "timeout") {
      expect(afterAbort.done).toBe(true);
    }

    await expect(streamed.completed).rejects.toMatchObject({
      kind: "cancellation",
    });
  });
});
