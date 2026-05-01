import { describe, expect, it } from "vitest";
import { ToolRegistry, ToolRuntime } from "@gemma-desktop/sdk-tools";

describe("tool runtime aliases", () => {
  function createBaseContext(toolCallId: string) {
    return {
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId,
      mode: "build" as const,
      workingDirectory: process.cwd(),
    };
  }

  function createExecCommandRuntime(): ToolRuntime {
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
          output: `ran ${input.command}`,
          structuredOutput: input,
        };
      },
    });

    return new ToolRuntime({
      registry,
      toolNames: ["exec_command"],
    });
  }

  function createWriteFileRuntime(): ToolRuntime {
    const registry = new ToolRegistry();
    registry.register({
      name: "write_file",
      description: "Write a file.",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { path: string; content: string }) {
        return {
          output: `wrote ${input.path}`,
          structuredOutput: input,
        };
      },
    });

    return new ToolRuntime({
      registry,
      toolNames: ["write_file"],
    });
  }

  function createWebRuntime(toolNames: string[]): ToolRuntime {
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
      async execute(input: { query: string }) {
        return {
          output: `searched ${input.query}`,
          structuredOutput: input,
        };
      },
    });
    registry.register({
      name: "web_research_agent",
      description: "Research the web.",
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { goal: string }) {
        return {
          output: `researched ${input.goal}`,
          structuredOutput: input,
        };
      },
    });

    return new ToolRuntime({
      registry,
      toolNames,
    });
  }

  function createBrowserRuntime(): ToolRuntime {
    const registry = new ToolRegistry();
    registry.register({
      name: "browser",
      description: "Control a managed browser session.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["open", "snapshot", "click"],
          },
          url: { type: "string" },
          uid: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input: { action: string; url?: string; uid?: string }) {
        return {
          output: `browser ${input.action}`,
          structuredOutput: input,
        };
      },
    });

    return new ToolRuntime({
      registry,
      toolNames: ["browser"],
    });
  }

  it("accepts execute_command as an alias for exec_command", async () => {
    const runtime = createExecCommandRuntime();

    const result = await runtime.execute(
      {
        id: "call_exec",
        name: "execute_command",
        input: {
          command: "echo hi",
        },
      },
      createBaseContext("call_exec"),
    );

    expect(result.toolName).toBe("exec_command");
    expect(result.output).toBe("ran echo hi");
    expect(result.structuredOutput).toEqual({
      command: "echo hi",
    });
  });

  it("accepts bash:run_command as an alias for exec_command", async () => {
    const runtime = createExecCommandRuntime();

    const result = await runtime.execute(
      {
        id: "call_exec",
        name: "bash:run_command",
        input: {
          command: "echo hi",
        },
      },
      createBaseContext("call_exec"),
    );

    expect(result.toolName).toBe("exec_command");
    expect(result.output).toBe("ran echo hi");
  });

  it("accepts functions.exec_command as a namespaced reference to exec_command", async () => {
    const runtime = createExecCommandRuntime();

    const result = await runtime.execute(
      {
        id: "call_exec",
        name: "functions.exec_command",
        input: {
          command: "echo hi",
        },
      },
      createBaseContext("call_exec"),
    );

    expect(result.toolName).toBe("exec_command");
    expect(result.output).toBe("ran echo hi");
  });

  it("accepts common write_file input aliases like contents", async () => {
    const runtime = createWriteFileRuntime();

    const result = await runtime.execute(
      {
        id: "call_write",
        name: "write_file",
        input: {
          path: "blackhole_sim.html",
          contents: "<html></html>",
        },
      },
      createBaseContext("call_write"),
    );

    expect(result.toolName).toBe("write_file");
    expect(result.output).toBe("wrote blackhole_sim.html");
    expect(result.structuredOutput).toEqual({
      path: "blackhole_sim.html",
      content: "<html></html>",
    });
  });

  it("accepts google_search as an alias for search_web and maps queries to query", async () => {
    const runtime = createWebRuntime(["search_web"]);

    const result = await runtime.execute(
      {
        id: "call_search",
        name: "google_search",
        input: {
          queries: ["current top stories cnn.com"],
        },
      },
      createBaseContext("call_search"),
    );

    expect(result.toolName).toBe("search_web");
    expect(result.output).toBe("searched current top stories cnn.com");
    expect(result.structuredOutput).toEqual({
      query: "current top stories cnn.com",
    });
  });

  it("does not silently route google_search to a delegated agent when search_web is not exposed", async () => {
    const runtime = createWebRuntime(["web_research_agent"]);

    await expect(
      runtime.execute(
        {
          id: "call_search",
          name: "google_search",
          input: {
            queries: ["current top stories cnn.com"],
          },
        },
        createBaseContext("call_search"),
      ),
    ).rejects.toThrow('Tool "google_search" is not registered in the active tool surface.');
  });

  it("accepts browser.open as an action alias for browser", async () => {
    const runtime = createBrowserRuntime();

    const result = await runtime.execute(
      {
        id: "call_browser_open",
        name: "browser.open",
        input: {
          url: "https://example.com",
        },
      },
      createBaseContext("call_browser_open"),
    );

    expect(result.toolName).toBe("browser");
    expect(result.output).toBe("browser open");
    expect(result.structuredOutput).toEqual({
      action: "open",
      url: "https://example.com",
    });
  });

  it("accepts browser.open_url as an old-style action alias for browser", async () => {
    const runtime = createBrowserRuntime();

    const result = await runtime.execute(
      {
        id: "call_browser_open_url",
        name: "browser.open_url",
        input: {
          url: "https://example.com",
        },
      },
      createBaseContext("call_browser_open_url"),
    );

    expect(result.toolName).toBe("browser");
    expect(result.output).toBe("browser open");
    expect(result.structuredOutput).toEqual({
      action: "open",
      url: "https://example.com",
    });
  });
});
