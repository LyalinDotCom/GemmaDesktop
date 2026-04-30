import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "./helpers/mock-server.js";

describe("delegated tool coverage", () => {
  const cleanup: Array<() => Promise<void>> = [];
  const tempDirectories: string[] = [];

  function collectSystemText(messages: Array<Record<string, unknown>>): string {
    return messages
      .filter((message) => message.role === "system")
      .map((message) => {
        const content = message.content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          return content
            .map((part) => String((part as Record<string, unknown>).text ?? ""))
            .join("\n");
        }
        return "";
      })
      .join("\n");
  }

  async function createWorkspace(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-delegated-tools-"));
    tempDirectories.push(directory);
    return directory;
  }

  afterEach(async () => {
    delete process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT;
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("delegates workspace_inspector_agent through a read-only worker session", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "src"), { recursive: true });
    await writeFile(path.join(workingDirectory, "src", "index.ts"), "export const ready = true;\n", "utf8");
    const requests: Array<Record<string, unknown>> = [];

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_inspect",
                    type: "function",
                    function: {
                      name: "workspace_inspector_agent",
                      arguments: JSON.stringify({ goal: "Describe the workspace layout." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_list",
                    type: "function",
                    function: {
                      name: "list_tree",
                      arguments: JSON.stringify({ path: "src", depth: 1 }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "The workspace has a src folder with index.ts.",
                  evidence: ["src/index.ts"],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Inspection complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
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
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["workspace_inspector_agent"],
        withoutTools: ["web_research_agent"],
      },
    });

    const result = await session.run("Inspect the workspace.");

    expect(result.text).toContain("Inspection complete.");
    expect(result.toolResults[0]?.toolName).toBe("workspace_inspector_agent");
    expect(result.toolResults[0]?.output).toContain("src/index.ts");
    expect(result.events.some((event) => event.type === "tool.subsession.started")).toBe(true);
    expect(result.events.some((event) => event.type === "tool.subsession.completed")).toBe(true);
    const startedEvent = result.events.find((event) => event.type === "tool.subsession.started");
    expect((startedEvent?.payload as Record<string, unknown>)?.childSessionId).toEqual(expect.any(String));
    expect((startedEvent?.payload as Record<string, unknown>)?.childTurnId).toEqual(expect.any(String));

    const workerTools = ((requests[1]?.tools as Array<Record<string, unknown>>) ?? [])
      .map((tool) => String(((tool.function as Record<string, unknown>) ?? {}).name ?? ""));
    expect(workerTools).toContain("list_tree");
    expect(workerTools).toContain("search_paths");
    expect(workerTools).not.toContain("write_file");

    const workerSystemText = collectSystemText((requests[1]?.messages as Array<Record<string, unknown>>) ?? []);
    expect(workerSystemText).toContain("delegated internal worker session");
  }, 10_000);

  it("lets delegated workspace search discover nested projects with search_paths", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "clients", "solar-system-sim", "src"), {
      recursive: true,
    });
    await writeFile(
      path.join(workingDirectory, "clients", "solar-system-sim", "src", "main.ts"),
      "export const ready = true;\n",
      "utf8",
    );
    const requests: Array<Record<string, unknown>> = [];

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "workspace_search_agent",
                      arguments: JSON.stringify({ goal: "Find the solar-system project folder." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search_paths",
                    type: "function",
                    function: {
                      name: "search_paths",
                      arguments: JSON.stringify({
                        query: "solar-system",
                        type: "directory",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "Found the nested solar-system project under clients/solar-system-sim/.",
                  evidence: ["clients/solar-system-sim/"],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Nested project found.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
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
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["workspace_search_agent"],
      },
    });

    const result = await session.run("Find the nested project.");

    expect(result.text).toContain("Nested project found.");
    expect(result.toolResults[0]?.toolName).toBe("workspace_search_agent");
    expect(result.toolResults[0]?.output).toContain("clients/solar-system-sim/");
    const childRequestTools = ((requests[1]?.tools as Array<Record<string, unknown>>) ?? [])
      .map((tool) => String(((tool.function as Record<string, unknown>) ?? {}).name ?? ""));
    expect(childRequestTools).toContain("search_paths");
  });

  it("delegates workspace_editor_agent and applies returned writes with escaped newlines normalized", async () => {
    const workingDirectory = await createWorkspace();
    await writeFile(path.join(workingDirectory, "README.md"), "line one\nline two\n", "utf8");

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_edit_workspace",
                    type: "function",
                    function: {
                      name: "workspace_editor_agent",
                      arguments: JSON.stringify({ goal: "Update README.md with a third line." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
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
                      arguments: JSON.stringify({ path: "README.md" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "Updated README.md with the requested content.",
                  writes: [
                    {
                      path: "README.md",
                      content: "line one\\nline two\\nline three\\n",
                    },
                  ],
                  filesChanged: ["README.md"],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "README updated.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
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
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "build",
        tools: ["workspace_editor_agent"],
      },
    });

    const result = await session.run("Update the README.");
    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      appliedWrites: Array<{
        path: string;
        bytes: number;
        edit?: {
          changeType: "created" | "edited";
          addedLines: number;
          removedLines: number;
          diff: string;
        };
      }>;
    };

    expect(result.text).toContain("README updated.");
    expect(toolResult?.toolName).toBe("workspace_editor_agent");
    expect(toolResult?.output).toContain("Files changed: README.md");
    expect(structured.appliedWrites).toMatchObject([
      {
        path: "README.md",
        bytes: "line one\nline two\nline three\n".length,
        edit: {
          changeType: "edited",
          addedLines: 1,
          removedLines: 0,
        },
      },
    ]);
    expect(structured.appliedWrites[0]?.edit?.diff).toContain("+++ b/README.md");
    expect(structured.appliedWrites[0]?.edit?.diff).toContain("+line three");
    expect(await readFile(path.join(workingDirectory, "README.md"), "utf8")).toBe("line one\nline two\nline three\n");
  });

  it("delegates workspace_command_agent and executes returned commands inside the workspace", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "scripts"), { recursive: true });

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_run_workspace_command",
                    type: "function",
                    function: {
                      name: "workspace_command_agent",
                      arguments: JSON.stringify({ goal: "Create a marker file under scripts." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "Created the marker file.",
                  commands: [
                    {
                      command: "printf 'done' > result.txt && pwd",
                      cwd: "scripts",
                    },
                  ],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Command execution complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
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
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "build",
        tools: ["workspace_command_agent"],
      },
    });

    const result = await session.run("Create a marker file.");
    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      executions: Array<{ stdout: string; exitCode: number | null }>;
    };

    expect(result.text).toContain("Command execution complete.");
    expect(toolResult?.toolName).toBe("workspace_command_agent");
    expect(toolResult?.output).toContain("Created the marker file.");
    expect(toolResult?.output).toContain(path.join(workingDirectory, "scripts"));
    expect(structured.executions[0]?.exitCode).toBe(0);
    expect(await readFile(path.join(workingDirectory, "scripts", "result.txt"), "utf8")).toBe("done");
  }, 10_000);

  it("delegates web_research_agent through a worker session that uses web tools", async () => {
    const workingDirectory = await createWorkspace();
    const requests: Array<Record<string, unknown>> = [];

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_research",
                    type: "function",
                    function: {
                      name: "web_research_agent",
                      arguments: JSON.stringify({ goal: "Research the pelican benchmark story." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "search_web",
                      arguments: JSON.stringify({ query: "pelican benchmark", includeDomains: ["cnn.com"] }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "CNN reported the pelican benchmark release.",
                  sources: ["https://cnn.com/pelican-benchmark"],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Research complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
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
      if (request.path.startsWith("/html")) {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://cnn.com/pelican-benchmark">Pelican benchmark released</a></h2>
                  <div class="b_caption"><p>CNN covers the benchmark release.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT = `${server.url}/html`;

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["web_research_agent"],
      },
    });

    const result = await session.run("Research the pelican benchmark.");
    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      sources: string[];
    };

    expect(result.text).toContain("Research complete.");
    expect(toolResult?.toolName).toBe("web_research_agent");
    expect(toolResult?.output).toContain("CNN reported the pelican benchmark release.");
    expect(structured.sources).toEqual(["https://cnn.com/pelican-benchmark"]);

    const workerTools = ((requests[1]?.tools as Array<Record<string, unknown>>) ?? [])
      .map((tool) => String(((tool.function as Record<string, unknown>) ?? {}).name ?? ""));
    expect(workerTools).toEqual(expect.arrayContaining(["search_web", "fetch_url_safe"]));
    expect(workerTools).not.toContain("exec_command");
  });

  it("normalizes web_research_agent output when the child omits sources", async () => {
    const workingDirectory = await createWorkspace();
    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_research",
                    type: "function",
                    function: {
                      name: "web_research_agent",
                      arguments: JSON.stringify({ goal: "Compare top headlines." }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "search_web",
                      arguments: JSON.stringify({ query: "headline comparison", depth: "quick" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary: "The major outlets are all leading with the same developing story.",
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Research complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
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
      if (request.path.startsWith("/html")) {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: "<html><body>ok</body></html>",
        };
      }
      if (request.path === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT = `${server.url}/html`;

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["web_research_agent"],
      },
    });

    const result = await session.run("Compare top headlines.");
    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      summary?: string;
      sources?: string[];
    };

    expect(toolResult?.toolName).toBe("web_research_agent");
    expect(toolResult?.output).toContain("The major outlets are all leading with the same developing story.");
    expect(structured.summary).toBe("The major outlets are all leading with the same developing story.");
    expect(structured.sources).toEqual([]);
  });

  it("backfills web_research_agent sources from fetched outlet pages when the child omits sources", async () => {
    const workingDirectory = await createWorkspace();
    const goal =
      "Identify the latest top stories and main headlines from MSNBC, Fox News, and CNN. Compare the coverage to determine which stories are being broadly covered across all three and identify any notable differences in focus, framing, or specific stories emphasized by individual networks.";

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_research",
                    type: "function",
                    function: {
                      name: "web_research_agent",
                      arguments: JSON.stringify({ goal }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_msnbc",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.msnbc.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_fox",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.foxnews.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-3",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_cnn",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.cnn.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-3",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-4",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary:
                    "CNN, Fox News, and MSNBC all lead with the same major national story, while each outlet frames the implications differently.",
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-4",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Research complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
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
      if (request.path.startsWith("/html")) {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: "<html><body>ok</body></html>",
        };
      }
      if (request.path === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT = `${server.url}/html`;

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["web_research_agent"],
      },
    });

    const result = await session.run(goal);
    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      summary?: string;
      sources?: string[];
    };
    const sources = structured.sources ?? [];

    expect(toolResult?.toolName).toBe("web_research_agent");
    expect(structured.summary).toContain("CNN, Fox News, and MSNBC");
    expect(sources).toEqual(expect.arrayContaining([
      "https://www.foxnews.com/",
      "https://www.cnn.com/",
    ]));
    expect(sources.some((source) => source.includes("msnbc.com") || source.includes("ms.now"))).toBe(true);
    expect(toolResult?.output).toContain("Sources:");
  }, 10_000);

  it("completes the msnbc fox cnn headline comparison flow with room to synthesize", async () => {
    const workingDirectory = await createWorkspace();
    const requests: Array<Record<string, unknown>> = [];
    const goal =
      "Identify the latest top stories and main headlines from MSNBC, Fox News, and CNN. Compare the coverage to determine which stories are being broadly covered across all three and identify any notable differences in focus, framing, or specific stories emphasized by individual networks.";

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_research",
                    type: "function",
                    function: {
                      name: "web_research_agent",
                      arguments: JSON.stringify({ goal }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "search_web",
                      arguments: JSON.stringify({
                        query: "latest top stories MSNBC Fox News CNN April 20 2026",
                        depth: "quick",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_msnbc",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.msnbc.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-2",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-3",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_fox",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.foxnews.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-3",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-4",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fetch_cnn",
                    type: "function",
                    function: {
                      name: "fetch_url_safe",
                      arguments: JSON.stringify({ url: "https://www.cnn.com/" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-4",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "child-5",
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  summary:
                    "All three outlets prominently feature the same developing national story, but MSNBC emphasizes policy implications, Fox News leans into conflict framing, and CNN stays closer to a straight headline mix.",
                  sources: [
                    "https://www.msnbc.com/",
                    "https://www.foxnews.com/",
                    "https://www.cnn.com/",
                  ],
                }),
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "child-5",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Research complete.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-2",
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
      if (request.path.startsWith("/html")) {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: "<html><body>ok</body></html>",
        };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT = `${server.url}/html`;

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "cowork",
        tools: ["web_research_agent"],
      },
    });

    const result = await session.run(
      "Identify the latest top stories and main headlines from MSNBC, Fox News, and CNN. Compare the coverage to determine which stories are being broadly covered across all three and identify any notable differences in focus, framing, or specific stories emphasized by individual networks.",
    );

    const toolResult = result.toolResults[0];
    const structured = toolResult?.structuredOutput as {
      summary?: string;
      sources?: string[];
    };
    const sources = structured.sources ?? [];
    const workerTools = ((requests[1]?.tools as Array<Record<string, unknown>>) ?? [])
      .map((tool) => String(((tool.function as Record<string, unknown>) ?? {}).name ?? ""));

    expect(toolResult?.toolName).toBe("web_research_agent");
    expect(toolResult?.output).toContain("All three outlets prominently feature the same developing national story");
    expect(sources).toEqual(expect.arrayContaining([
      "https://www.foxnews.com/",
      "https://www.cnn.com/",
    ]));
    expect(sources.some((source) => source.includes("msnbc.com") || source.includes("ms.now"))).toBe(true);
    expect(workerTools).toEqual(expect.arrayContaining(["search_web", "fetch_url_safe"]));
    expect((requests[1]?.messages as Array<Record<string, unknown>>)?.some((message) =>
      typeof message.content === "string"
      && message.content.includes(goal),
    )).toBe(true);
    expect((requests[1]?.messages as Array<Record<string, unknown>>)?.some((message) =>
      typeof message.content === "string"
      && message.content.includes("Prefer fetching MSNBC directly from https://www.msnbc.com/"),
    )).toBe(true);
  }, 15_000);
});
