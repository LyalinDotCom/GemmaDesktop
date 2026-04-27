import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FINALIZE_BUILD_TOOL_NAME, parseToolCallInput } from "@gemma-desktop/sdk-core";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createMockServer } from "./helpers/mock-server.js";

describe("delegated tool sessions", () => {
  const cleanup: Array<() => Promise<void>> = [];

  function countSystemMessages(messages: Array<Record<string, unknown>>): number {
    return messages.filter((message) => message.role === "system").length;
  }

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

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("repairs streamed tool-call JSON with a missing array closer before validation", () => {
    const repaired = parseToolCallInput(
      "{\"question\": \"What celestial bodies would you like to include?\", \"options\": [\"8 planets only\\nPlanet Sun + 8 planets + asteroid belt\\nEverything else\"}",
    );

    expect(repaired).toEqual({
      question: "What celestial bodies would you like to include?",
      options: ["8 planets only\nPlanet Sun + 8 planets + asteroid belt\nEverything else"],
    });
  });

  it("runs built-in code tools as delegated worker sessions and keeps the parent result compact", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
    await mkdir(path.join(tempDirectory, "src"), { recursive: true });
    await writeFile(path.join(tempDirectory, "src", "session.ts"), "export class SessionEngine {}\n", "utf8");
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
                    id: "call_parent",
                    type: "function",
                    function: {
                      name: "workspace_search_agent",
                      arguments: JSON.stringify({ goal: "Find where SessionEngine lives." }),
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
                    id: "call_child_read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "src/session.ts" }),
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
                  summary: "SessionEngine lives in src/session.ts.",
                  evidence: ["src/session.ts"],
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
                content: "SessionEngine lives in src/session.ts.",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
      mode: {
        base: "cowork",
        tools: ["workspace_search_agent"],
        withoutTools: ["workspace_inspector_agent", "web_research_agent"],
      },
    });

    const result = await session.run("Find where SessionEngine lives.");

    expect(result.text).toContain("src/session.ts");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolName).toBe("workspace_search_agent");
    expect(result.events.some((event) => event.type === "tool.subsession.event")).toBe(true);
    const parentMessages = (requests[0]?.messages as Array<Record<string, unknown>>) ?? [];
    const workerMessages = (requests[1]?.messages as Array<Record<string, unknown>>) ?? [];
    const parentSystemText = collectSystemText(parentMessages);
    const workerSystemText = collectSystemText(workerMessages);
    expect(countSystemMessages(parentMessages)).toBe(1);
    expect(countSystemMessages(workerMessages)).toBe(1);
    expect(parentSystemText).toContain("You are Gemma Desktop for local and open-model workflows.");
    expect(parentSystemText).toContain("If a tool fails, say so briefly");
    expect(workerSystemText).toContain("You are Gemma Desktop for local and open-model workflows.");
    expect(workerSystemText).toContain("delegated internal worker session");
  });

  it("executes direct host tools in build mode without requiring a delegated planning hop", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
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
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "test1/machine_info.py",
                        content: "print('machine info')\n",
                        createDirectories: true,
                      }),
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
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created test1/machine_info.py.",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
    });

    const result = await session.run("Create a machine info script in test1.");

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolName).toBe("write_file");
    expect(await readFile(path.join(tempDirectory, "test1", "machine_info.py"), "utf8")).toContain("machine info");

    const parentTools = ((requests[0]?.tools as Array<Record<string, unknown>>) ?? [])
      .map((tool) => String(((tool.function as Record<string, unknown>) ?? {}).name ?? ""));
    expect(parentTools).toContain("write_file");
    expect(parentTools).toContain("workspace_editor_agent");
    expect(parentTools).toContain("workspace_command_agent");
  });

  it("executes namespaced command tool calls in build mode", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));

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
                    id: "call_exec",
                    type: "function",
                    function: {
                      name: "bash:run_command",
                      arguments: JSON.stringify({
                        command: "printf '%s\\n' '#!/bin/zsh' 'echo hello' > hello.sh",
                      }),
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
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created hello.sh.",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
    });

    const result = await session.run("Create a simple shell script.");

    expect(result.text).toContain("Created hello.sh.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolName).toBe("exec_command");
    expect(await readFile(path.join(tempDirectory, "hello.sh"), "utf8")).toContain("echo hello");
  }, 10_000);

  it("repairs malformed streamed tool-call arguments before executing strict tools", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
    const capturedInputs: Array<Record<string, unknown>> = [];

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
                    id: "call_plan",
                    type: "function",
                    function: {
                      name: "ask_plan_question",
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
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    type: "function",
                    function: {
                      arguments: "{\"question\":\"Which renderer should we use?\",\"options\":[\"Three.js\",",
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
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    type: "function",
                    function: {
                      arguments: "\"Canvas API",
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
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Question queued.",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory: tempDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
      extraTools: [
        {
          name: "ask_plan_question",
          description: "Ask the user a planning question.",
          inputSchema: {
            type: "object",
            required: ["question"],
            properties: {
              question: { type: "string" },
              options: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
          async execute(input: Record<string, unknown>) {
            capturedInputs.push(input);
            return {
              output: "Three.js",
            };
          },
        },
      ],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "minimal",
        tools: ["ask_plan_question"],
      },
    });

    const result = await session.run("Plan the renderer choice.");

    expect(result.text).toContain("Question queued.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolName).toBe("ask_plan_question");
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual({
      question: "Which renderer should we use?",
      options: ["Three.js", "Canvas API"],
    });
  });

  it("continues plan-mode turns until a required planning tool is called", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
    const requests: Array<Record<string, unknown>> = [];

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                content: "Here's the plan: use Three.js, create an index.html, and add orbit animation.",
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
                tool_calls: [
                  {
                    index: 0,
                    id: "call_prepare",
                    type: "function",
                    function: {
                      name: "prepare_plan_execution",
                      arguments: JSON.stringify({
                        summary: "Build a simple Three.js solar system in .tmp/solar3.",
                        executionPrompt: "Create the requested web app in .tmp/solar3 using simple colored spheres.",
                        recommendedTarget: "current_session",
                      }),
                    },
                  },
                ],
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
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-3",
          choices: [
            {
              index: 0,
              delta: {
                content: "Plan ready for execution.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-3",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory: tempDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
      extraTools: [
        {
          name: "prepare_plan_execution",
          description: "Prepare a plan for execution.",
          inputSchema: {
            type: "object",
            required: ["summary", "executionPrompt"],
            properties: {
              summary: { type: "string" },
              executionPrompt: { type: "string" },
              recommendedTarget: { type: "string" },
            },
            additionalProperties: false,
          },
          async execute(input: Record<string, unknown>) {
            return {
              output: JSON.stringify(input),
              structuredOutput: input,
            };
          },
        },
      ],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: {
        base: "minimal",
        tools: ["prepare_plan_execution"],
        requiredTools: ["prepare_plan_execution"],
      },
    });

    const result = await session.run("Plan this build.");

    expect(result.text).toContain("Plan ready");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolName).toBe("prepare_plan_execution");

    const continuedSystemText = collectSystemText((requests[1]?.messages as Array<Record<string, unknown>>) ?? []);
    expect(continuedSystemText).toContain("Before you end the turn, call at least one of these tools: prepare_plan_execution.");
  });

  it("auto-continues build turns when the model only announces the next step after tool use", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
    await writeFile(path.join(tempDirectory, "penguin-unicycle.html"), "<html></html>\n", "utf8");
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
                    id: "call_read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path: "penguin-unicycle.html",
                      }),
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
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "Now I'll create a new SVG pelican riding a unicycle:",
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
      [
        `data: ${JSON.stringify({
          id: "main-3",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "pelican-unicycle.svg",
                        content: "<svg><circle cx=\"10\" cy=\"10\" r=\"5\" /></svg>\n",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-3",
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
          id: "main-4",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created pelican-unicycle.svg.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-4",
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
          id: "main-5",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_validate",
                    type: "function",
                    function: {
                      name: "exec_command",
                      arguments: JSON.stringify({
                        command: "xmllint --noout pelican-unicycle.svg",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-5",
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
          id: "main-6",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created pelican-unicycle.svg and xmllint passed.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-6",
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
          id: "main-7",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_finalize",
                    type: "function",
                    function: {
                      name: FINALIZE_BUILD_TOOL_NAME,
                      arguments: JSON.stringify({
                        summary: "Created a pelican riding a unicycle SVG and validated it.",
                        artifacts: ["pelican-unicycle.svg"],
                        validation: [{
                          command: "xmllint --noout pelican-unicycle.svg",
                          status: "passed",
                        }],
                        instructionChecklist: [
                          "Generated an SVG artifact.",
                          "Kept the topic as a pelican riding a unicycle.",
                          "Validated the SVG parser path.",
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-7",
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
          id: "main-8",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created pelican-unicycle.svg, validated it with xmllint, and recorded completion evidence.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-8",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
      buildPolicy: {
        requireFinalizationAfterMutation: true,
      },
    });

    const result = await session.run("Generate an SVG of a pelican riding a unicycle.");

    expect(result.text).toContain("Created pelican-unicycle.svg, validated it with xmllint, and recorded completion evidence.");
    expect(result.toolResults).toHaveLength(4);
    expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
      "read_file",
      "write_file",
      "exec_command",
      FINALIZE_BUILD_TOOL_NAME,
    ]);
    expect(await readFile(path.join(tempDirectory, "pelican-unicycle.svg"), "utf8")).toContain("<svg>");

    const continuationSystemText = collectSystemText(
      (requests[2]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(continuationSystemText).toContain("Do not stop at intent, promises, or next steps.");
  });

  it("auto-continues when the model hides the next-step promise behind factual setup text", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
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
                    id: "call_list",
                    type: "function",
                    function: {
                      name: "list_tree",
                      arguments: JSON.stringify({
                        path: ".",
                        includeHidden: true,
                      }),
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
          id: "main-2",
          choices: [
            {
              index: 0,
              delta: {
                content: "The folder doesn't exist yet. I'll create the complete solar system simulation with two files:\n\nFiles to Create\n1. index.html\n2. style.css",
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
      [
        `data: ${JSON.stringify({
          id: "main-3",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: ".tmp/solar3/index.html",
                        content: "<html><body>solar</body></html>\n",
                        createDirectories: true,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-3",
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
          id: "main-4",
          choices: [
            {
              index: 0,
              delta: {
                content: "Created .tmp/solar3/index.html.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-4",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
    });

    const result = await session.run("Build a simple solar system page in .tmp/solar3.");

    expect(result.text).toContain("Created .tmp/solar3/index.html.");
    expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
      "list_tree",
      "write_file",
    ]);
    expect(await readFile(path.join(tempDirectory, ".tmp", "solar3", "index.html"), "utf8")).toContain("solar");

    const continuationSystemText = collectSystemText(
      (requests[2]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(continuationSystemText).toContain("Do not stop at intent, promises, or next steps.");
  }, 10_000);

  it("auto-continues build turns when the first reply only announces a read step", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-"));
    await writeFile(path.join(tempDirectory, "main.js"), "const planets = [];\n", "utf8");
    const requests: Array<Record<string, unknown>> = [];

    const queuedChatResponses = [
      [
        `data: ${JSON.stringify({
          id: "main-1",
          choices: [
            {
              index: 0,
              delta: {
                content: "I will inspect main.js first so I can base the orbital offsets on the current date.",
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
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path: "main.js",
                      }),
                    },
                  },
                ],
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
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ],
      [
        `data: ${JSON.stringify({
          id: "main-3",
          choices: [
            {
              index: 0,
              delta: {
                content: "Checked main.js and I am ready to update the planet initialization.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "main-3",
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
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return {
          sse: next,
        };
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
    });

    const result = await session.run("Can the planets load closer to where they really are based on date/time?");

    expect(result.text).toContain("Checked main.js");
    expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
      "read_file",
    ]);

    const continuationSystemText = collectSystemText(
      (requests[1]?.messages as Array<Record<string, unknown>>) ?? [],
    );
    expect(continuationSystemText).toContain("Do not stop at intent or next steps.");
  });

  it("includes exact user-provided paths in build-mode system guidance", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "main-1",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: "Done.",
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
                  finish_reason: "stop",
                },
              ],
            })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory: "/tmp",
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "build",
    });

    await session.run("Create a poem in .tmp/peom01.md about the future of space explorations");

    const messages = (requests[0]?.messages as Array<Record<string, unknown>>) ?? [];
    const systemText = collectSystemText(messages);

    expect(systemText).toContain("You are Gemma Desktop for local and open-model workflows.");
    expect(systemText).toContain("Act mode is active.");
    expect(systemText).toContain("Read before editing existing files.");
    expect(systemText).toContain(".tmp/peom01.md");
    expect(systemText).toContain("Do not normalize, rename, or silently fix them.");
  });

  it("does not inject shared agent instructions in minimal mode by default", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return {
          status: 200,
          text: "ok",
        };
      }

      if (request.path === "/v1/models") {
        return {
          json: {
            data: [{ id: "mock-model" }],
          },
        };
      }

      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "main-1",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: "Minimal reply.",
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
                  finish_reason: "stop",
                },
              ],
            })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory: "/tmp",
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "minimal",
    });

    await session.run("Say hi");

    const systemText = collectSystemText((requests[0]?.messages as Array<Record<string, unknown>>) ?? []);
    expect(systemText).toBe("");
  });
});
