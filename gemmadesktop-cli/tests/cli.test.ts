import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEvent,
  type EnvironmentInspectionResult,
  type SessionSnapshot,
  type TurnResult,
} from "@gemma-desktop/sdk-core";
import type {
  CreateGemmaDesktopOptions,
  CreateSessionOptions,
  ResearchRunResult,
  SessionDebugSnapshot,
} from "@gemma-desktop/sdk-node";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies, type SessionLike } from "../src/cli.js";
import { DESKTOP_PARITY_RUNTIME_ADAPTER_IDS } from "../src/desktopParity.js";
import { APP_SESSION_METADATA_KEY, REQUEST_PREFERENCES_METADATA_KEY } from "../src/metadata.js";

class MemoryStream implements AsyncIterable<unknown> {
  public readonly chunks: string[] = [];
  public isTTY = true;

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public text(): string {
    return this.chunks.join("");
  }

  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => Promise.resolve({ done: true, value: undefined }),
    };
  }
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    schemaVersion: 2,
    sessionId: "session-1",
    runtimeId: "ollama-native",
    modelId: "gemma4:e2b",
    mode: "explore",
    workingDirectory: "/tmp/gemma-project",
    maxSteps: 8,
    history: [],
    started: false,
    savedAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    runtimeId: "ollama-native",
    modelId: "gemma4:e2b",
    text: "Hello from Gemma",
    warnings: [],
    steps: 1,
    toolResults: [],
    events: [],
    ...overrides,
  };
}

function makeDebugSnapshot(snapshot: SessionSnapshot): SessionDebugSnapshot {
  return {
    sessionId: snapshot.sessionId,
    runtimeId: snapshot.runtimeId,
    modelId: snapshot.modelId,
    mode: snapshot.mode,
    workingDirectory: snapshot.workingDirectory,
    savedAt: snapshot.savedAt,
    started: snapshot.started,
    maxSteps: snapshot.maxSteps,
    metadata: snapshot.metadata,
    historyMessageCount: snapshot.history.length,
    toolNames: ["read_file"],
    tools: [],
    systemPromptSections: [],
    systemPrompt: "",
    requestPreview: {
      model: snapshot.modelId,
      messages: [],
      tools: [],
      settings: {
        mode: snapshot.mode,
        sessionMetadata: snapshot.metadata,
      },
    },
  };
}

function makeInspection(): EnvironmentInspectionResult {
  return {
    inspectedAt: "2026-04-24T00:00:00.000Z",
    machine: {
      platform: "darwin",
      release: "25.0.0",
      arch: "arm64",
      totalMemoryBytes: 64 * 1024 ** 3,
      cpuModel: "Apple",
      cpuCount: 12,
      hostname: "gemma-test",
    },
    runtimes: [],
    warnings: [],
    diagnosis: [],
  };
}

function makeDependencies(calls: {
  createOptions: CreateGemmaDesktopOptions[];
  sessionOptions: CreateSessionOptions[];
  inputs: unknown[];
}, turnResult?: TurnResult): CliDependencies {
  return {
    createGemmaDesktop: (options) => {
      calls.createOptions.push(options);
      const snapshot = makeSnapshot();
      const session: SessionLike = {
        id: snapshot.sessionId,
        snapshot: () => snapshot,
        runStreamed: (input) => {
          calls.inputs.push(input);
          const event = createEvent(
            "content.delta",
            { channel: "assistant", delta: "Hello from Gemma" },
            {
              sessionId: snapshot.sessionId,
              turnId: "turn-1",
              runtimeId: snapshot.runtimeId,
              modelId: snapshot.modelId,
            },
          );
          return Promise.resolve({
            turnId: "turn-1",
            events: (async function* () {
              await Promise.resolve();
              yield event;
            })(),
            completed: Promise.resolve(turnResult ?? makeTurnResult({
              events: [event],
            })),
          });
        },
      };
      return Promise.resolve({
        inspectEnvironment: () => Promise.resolve(makeInspection()),
        describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
        sessions: {
          create: (sessionOptions) => {
            calls.sessionOptions.push(sessionOptions);
            return Promise.resolve(session);
          },
        },
      });
    },
  };
}

describe("headless CLI", () => {
  it("runs a prompt through createGemmaDesktop with desktop-parity adapters and metadata", async () => {
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    const code = await runCli({
      argv: [
        "run",
        "hello",
        "--model",
        "gemma4:e2b",
        "--runtime",
        "ollama-native",
        "--mode",
        "build",
        "--tool",
        "read_file",
        "--approval-mode",
        "yolo",
        "--reasoning",
        "on",
        "--ollama-option",
        "num_ctx=8192",
        "--ollama-keep-alive",
        "24h",
        "--omlx-option",
        "temperature=0.8",
      ],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr,
      dependencies: makeDependencies(calls),
    });

    expect(code).toBe(0);
    expect(stdout.text()).toBe("Hello from Gemma\n");
    expect(stderr.text()).toBe("");
    expect(typeof calls.createOptions[0]?.toolPolicy?.authorize).toBe("function");
    expect(calls.inputs).toEqual(["hello"]);
    expect(calls.createOptions[0]?.adapters?.map((adapter) => adapter.identity.id)).toEqual(
      [...DESKTOP_PARITY_RUNTIME_ADAPTER_IDS],
    );
    expect(calls.sessionOptions[0]).toMatchObject({
      runtime: "ollama-native",
      model: "gemma4:e2b",
      workingDirectory: "/tmp/gemma-project",
      mode: {
        base: "build",
        tools: ["read_file"],
      },
    });
    expect(calls.sessionOptions[0]?.metadata).toMatchObject({
      [APP_SESSION_METADATA_KEY]: {
        baseMode: "build",
        preferredRuntimeId: "ollama-native",
        approvalMode: "yolo",
        surface: "default",
        storageScope: "project",
      },
      [REQUEST_PREFERENCES_METADATA_KEY]: {
        reasoningMode: "on",
        ollamaOptions: { num_ctx: 8192 },
        ollamaKeepAlive: "24h",
        omlxOptions: { temperature: 0.8 },
      },
    });
  });

  it("prints missing-verification build summaries without treating them as CLI failures", async () => {
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    const code = await runCli({
      argv: [
        "run",
        "Create the file.",
        "--model",
        "gemma4:e2b",
        "--runtime",
        "ollama-native",
        "--mode",
        "build",
        "--json",
      ],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr,
      dependencies: makeDependencies(calls, makeTurnResult({
        text: "I created the file.",
        build: {
          policy: {
            samplingTurns: 30,
            requireVerificationAfterMutation: true,
            requireFinalizationAfterMutation: false,
            completionVerifier: "off",
            verificationContinuationLimit: 3,
            finalizationContinuationLimit: 3,
            verifierAttemptLimit: 2,
          },
          changedPaths: ["src/main.ts"],
          verification: {
            attempted: false,
            passed: false,
            changedPaths: ["src/main.ts"],
            recommendedCommands: ["npm run build"],
            rationale: "package.json exposes a build script",
          },
          browserEvidence: [],
        },
      })),
    });

    expect(code).toBe(0);
    expect(stderr.text()).toBe("");
    const output = JSON.parse(stdout.text()) as { result: TurnResult };
    expect(output.result.text).toBe("I created the file.");
    expect(output.result.build?.verification?.attempted).toBe(false);
    expect(output.result.build?.verification?.recommendedCommands).toEqual(["npm run build"]);
  });

  it("prints JSON inspection output without creating a session", async () => {
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const code = await runCli({
      argv: ["inspect", "--json"],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr: new MemoryStream(),
      dependencies: makeDependencies(calls),
    });

    expect(code).toBe(0);
    expect(calls.sessionOptions).toHaveLength(0);
    expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
      parity: {
        adapterIds: [...DESKTOP_PARITY_RUNTIME_ADAPTER_IDS],
      },
      environment: {
        machine: {
          platform: "darwin",
        },
      },
    });
  });

  it("prints a debug preview for the SDK session request", async () => {
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const code = await runCli({
      argv: ["preview", "--model", "gemma4:e2b", "--runtime", "ollama-native", "--json"],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr: new MemoryStream(),
      dependencies: makeDependencies(calls),
    });

    expect(code).toBe(0);
    expect(calls.inputs).toEqual([]);
    expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
      sessionId: "session-1",
      runtimeId: "ollama-native",
      modelId: "gemma4:e2b",
      toolNames: ["read_file"],
    });
  });

  it("runs the black hole ACT scenario and reports evaluator success", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-scenario-"));
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: (options) => {
        calls.createOptions.push(options);
        const snapshot = makeSnapshot({
          mode: "build",
          workingDirectory: tempDirectory,
          maxSteps: 30,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: async (input) => {
            calls.inputs.push(input);
            const blackDirectory = path.join(tempDirectory, "black");
            await mkdir(blackDirectory, { recursive: true });
            await writeFile(
              path.join(blackDirectory, "package.json"),
              JSON.stringify({
                name: "black-hole-simulator",
                private: true,
                scripts: {
                  dev: "vite --host 127.0.0.1",
                  build: "node validate.mjs",
                },
              }, null, 2),
              "utf8",
            );
            await writeFile(
              path.join(blackDirectory, "validate.mjs"),
              "import { readFileSync } from 'node:fs';\nreadFileSync('index.html', 'utf8');\n",
              "utf8",
            );
            await writeFile(
              path.join(blackDirectory, "index.html"),
              [
                "<h1>Black hole simulator</h1>",
                "<p>Event horizon, accretion, gravitational lensing, and gravity readout.</p>",
                "<button>Pause</button><button>Reset</button>",
                "<label>Mass</label><label>Accretion speed</label><label>Lensing intensity</label>",
                "<section>Stats metrics readout</section>",
              ].join("\n"),
              "utf8",
            );
            return {
              turnId: `turn-${calls.inputs.length}`,
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: `turn-${calls.inputs.length}`,
                text: "Black hole simulator updated and validated.",
                steps: 1,
                toolResults: [{
                  callId: "call-build",
                  toolName: "exec_command",
                  output: "built",
                  structuredOutput: {
                    command: "npm run build",
                    exitCode: 0,
                    stdout: "built",
                    stderr: "",
                    timedOut: false,
                  },
                }],
                build: {
                  policy: {
                    samplingTurns: 30,
                    requireVerificationAfterMutation: true,
                    requireFinalizationAfterMutation: false,
                    completionVerifier: "off",
                    verificationContinuationLimit: 3,
                    finalizationContinuationLimit: 3,
                    verifierAttemptLimit: 2,
                  },
                  changedPaths: ["black/index.html", "black/package.json"],
                  verification: {
                    attempted: true,
                    passed: true,
                    changedPaths: ["black/index.html", "black/package.json"],
                    recommendedCommands: ["npm run build"],
                    rationale: "scenario validated with npm",
                  },
                  browserEvidence: [],
                },
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    try {
      const code = await runCli({
        argv: [
          "scenario",
          "run",
          "act-webapp-black-hole",
          "--model",
          "gemma4:e2b",
          "--runtime",
          "ollama-native",
          "--cwd",
          tempDirectory,
          "--json",
        ],
        cwd: "/tmp/gemma-project",
        env: {},
        stdin: new MemoryStream(),
        stdout,
        stderr: new MemoryStream(),
        dependencies,
      });

      expect(code).toBe(0);
      expect(calls.inputs).toHaveLength(4);
      expect(calls.sessionOptions[0]).toMatchObject({
        runtime: "ollama-native",
        model: "gemma4:e2b",
        mode: "build",
        workingDirectory: tempDirectory,
        buildPolicy: {
          samplingTurns: 6,
          completionVerifier: "off",
        },
      });
      expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
        scenarioId: "act-webapp-black-hole",
        artifactDirectory: path.join(tempDirectory, "black"),
        evaluation: {
          success: true,
          checks: {
            validationPassed: true,
            topicStayedBlackHole: true,
            requestedUiChangesPresent: true,
          },
        },
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs a web catalog scenario with explore-mode tools and reports evaluator success", async () => {
    const calls = {
      createOptions: [] as CreateGemmaDesktopOptions[],
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: (options) => {
        calls.createOptions.push(options);
        const snapshot = makeSnapshot({
          mode: "explore",
          workingDirectory: "/tmp/gemma-project",
          maxSteps: 30,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: async (input) => {
            await Promise.resolve();
            calls.inputs.push(input);
            return {
              turnId: "turn-hn",
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: "turn-hn",
                text: [
                  "Current Hacker News front-page update from https://news.ycombinator.com/:",
                  "1. Story Alpha - 120 points, 34 comments",
                  "2. Story Beta - 88 points, 12 comments",
                  "3. Story Gamma - 55 points, 7 comments",
                  "4. Story Delta - 42 points, 5 comments",
                  "5. Story Epsilon - 31 points, 2 comments",
                ].join("\n"),
                steps: 1,
                toolResults: [{
                  callId: "call-fetch-hn",
                  toolName: "fetch_url",
                  output: "Fetched https://news.ycombinator.com/ Hacker News front page.",
                  structuredOutput: {
                    requestedUrl: "https://news.ycombinator.com/",
                    finalUrl: "https://news.ycombinator.com/",
                  },
                }],
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    const code = await runCli({
      argv: [
        "scenario",
        "run",
        "web-hacker-news-frontpage",
        "--model",
        "gemma4:31b",
        "--runtime",
        "ollama-native",
        "--json",
      ],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr: new MemoryStream(),
      dependencies,
    });

    expect(code).toBe(0);
    expect(calls.inputs).toHaveLength(1);
    expect(calls.sessionOptions[0]).toMatchObject({
      runtime: "ollama-native",
      model: "gemma4:31b",
      mode: "explore",
      workingDirectory: "/tmp/gemma-project",
    });
    expect(calls.sessionOptions[0]).not.toHaveProperty("buildPolicy");
    expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
      scenarioId: "web-hacker-news-frontpage",
      evaluation: {
        success: true,
        checks: {
          webToolUsed: true,
          sourceIsHackerNews: true,
          reportsMultipleItems: true,
        },
      },
    });
  });

  it("runs the research scenario through the SDK research runner and reports artifacts", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-research-scenario-"));
    const calls = {
      sessionOptions: [] as CreateSessionOptions[],
      researchInputs: [] as unknown[],
      researchOptions: [] as unknown[],
    };
    const stdout = new MemoryStream();
    const sources: ResearchRunResult["sources"] = [
      {
        id: "source-1",
        requestedUrl: "https://ai.google.dev/gemma/docs",
        resolvedUrl: "https://ai.google.dev/gemma/docs",
        title: "Gemma docs",
        description: "Official Gemma documentation",
        kind: "html",
        extractedWith: "readability",
        blockedLikely: false,
        fetchedAt: "2026-04-30T00:00:00.000Z",
        topicIds: ["official-gemma-1"],
        domain: "ai.google.dev",
        sourceFamily: "official",
        pageRole: "article",
        contentPreview: "Official Gemma 4 documentation.",
        contentLength: 1200,
      },
      {
        id: "source-2",
        requestedUrl: "https://ollama.com/library/gemma4",
        resolvedUrl: "https://ollama.com/library/gemma4",
        title: "Gemma 4 on Ollama",
        description: "Ollama runtime catalog",
        kind: "html",
        extractedWith: "readability",
        blockedLikely: false,
        fetchedAt: "2026-04-30T00:00:00.000Z",
        topicIds: ["runtime-gemma-2"],
        domain: "ollama.com",
        sourceFamily: "reference_github_docs",
        pageRole: "article",
        contentPreview: "Runtime catalog includes Gemma 4 26B and 31B.",
        contentLength: 900,
      },
    ];

    const dependencies: CliDependencies = {
      createGemmaDesktop: () => {
        const snapshot = makeSnapshot({
          mode: "cowork",
          workingDirectory: tempDirectory,
          maxSteps: 20,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: () => {
            throw new Error("research scenario should use runResearch, not runStreamed");
          },
          runResearch: async (input, options) => {
            await Promise.resolve();
            calls.researchInputs.push(input);
            calls.researchOptions.push(options);
            return {
              runId: "research-run-1",
              profile: "deep",
              artifactDirectory: path.join(tempDirectory, ".gemma-headless", "gemma4-research", "research-run-1"),
              plan: {
                objective: "Research Gemma 4 availability",
                scopeSummary: "Official and runtime catalog coverage.",
                topics: [],
                risks: [],
                stopConditions: [],
              },
              sources,
              dossiers: [],
              finalReport: [
                "Gemma 4 availability report.",
                "Official docs: https://ai.google.dev/gemma/docs.",
                "Runtime catalog: https://ollama.com/library/gemma4.",
                "Gemma 4 26B and Gemma 4 31B are covered with availability details.",
              ].join("\n"),
              summary: "Gemma 4 26B and 31B availability covered.",
              sourceIds: ["source-1", "source-2"],
              confidence: 0.82,
              completedAt: "2026-04-30T00:00:00.000Z",
              taskType: "catalog-status",
              passCount: 2,
              sourceFamilies: ["official", "reference_github_docs"],
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    try {
      const code = await runCli({
        argv: [
          "scenario",
          "run",
          "research-gemma4-availability",
          "--model",
          "gemma4:26b",
          "--runtime",
          "ollama-native",
          "--cwd",
          tempDirectory,
          "--json",
        ],
        cwd: tempDirectory,
        env: {},
        stdin: new MemoryStream(),
        stdout,
        stderr: new MemoryStream(),
        dependencies,
      });

      expect(code).toBe(0);
      expect(calls.researchInputs).toHaveLength(1);
      expect(calls.researchOptions[0]).toMatchObject({
        profile: "deep",
        artifactDirectory: path.join(tempDirectory, ".gemma-headless", "gemma4-research"),
      });
      expect(calls.sessionOptions[0]).toMatchObject({
        runtime: "ollama-native",
        model: "gemma4:26b",
        mode: "cowork",
        workingDirectory: tempDirectory,
      });
      const output = JSON.parse(stdout.text()) as {
        evaluation: { success: boolean; checks: Record<string, boolean> };
        turns: Array<{ toolNames?: string[]; research?: { sourceCount: number } }>;
      };
      expect(output.evaluation.success).toBe(true);
      expect(output.evaluation.checks).toMatchObject({
        researchToolUsed: true,
        researchArtifactsWritten: true,
        sourcesCollected: true,
      });
      expect(output.turns[0]?.toolNames).toEqual(["research_runner"]);
      expect(output.turns[0]?.research?.sourceCount).toBe(2);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs the ACT repair fixture scenario and validates the fixed project", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-repair-scenario-"));
    const calls = {
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: () => {
        const snapshot = makeSnapshot({
          mode: "build",
          workingDirectory: tempDirectory,
          maxSteps: 30,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: async (input) => {
            calls.inputs.push(input);
            await writeFile(
              path.join(tempDirectory, "broken", "index.js"),
              [
                "export function add(a, b) {",
                "  return a + b;",
                "}",
                "",
                "export function formatTotal(value) {",
                "  return `Total: ${value}`;",
                "}",
                "",
              ].join("\n"),
              "utf8",
            );
            return {
              turnId: "turn-repair",
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: "turn-repair",
                text: "Fixed add(), preserved the tests, and npm test passed.",
                steps: 1,
                toolResults: [{
                  callId: "call-test",
                  toolName: "exec_command",
                  output: "broken fixture tests passed",
                  structuredOutput: {
                    command: "npm test",
                    exitCode: 0,
                    stdout: "broken fixture tests passed\n",
                    stderr: "",
                    timedOut: false,
                  },
                }],
                build: {
                  policy: {
                    samplingTurns: 30,
                    requireVerificationAfterMutation: true,
                    requireFinalizationAfterMutation: false,
                    completionVerifier: "off",
                    verificationContinuationLimit: 3,
                    finalizationContinuationLimit: 3,
                    verifierAttemptLimit: 2,
                  },
                  changedPaths: ["broken/index.js"],
                  verification: {
                    attempted: true,
                    passed: true,
                    changedPaths: ["broken/index.js"],
                    recommendedCommands: ["npm test"],
                    rationale: "scenario validated with npm test",
                  },
                  browserEvidence: [],
                },
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    try {
      const code = await runCli({
        argv: [
          "scenario",
          "run",
          "act-fix-broken-tests",
          "--model",
          "gemma4:26b",
          "--runtime",
          "ollama-native",
          "--cwd",
          tempDirectory,
          "--json",
        ],
        cwd: "/tmp/gemma-project",
        env: {},
        stdin: new MemoryStream(),
        stdout,
        stderr: new MemoryStream(),
        dependencies,
      });

      expect(code).toBe(0);
      expect(calls.inputs).toHaveLength(1);
      expect(calls.sessionOptions[0]).toMatchObject({
        runtime: "ollama-native",
        model: "gemma4:26b",
        mode: "build",
        workingDirectory: tempDirectory,
      });
      expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
        scenarioId: "act-fix-broken-tests",
        artifactDirectory: path.join(tempDirectory, "broken"),
        evaluation: {
          success: true,
          checks: {
            implementationFixed: true,
            testsPreserved: true,
            validationPassed: true,
          },
        },
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs the ACT polyglot Python/Go scenario and validates the project", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-polyglot-scenario-"));
    const calls = {
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: () => {
        const snapshot = makeSnapshot({
          mode: "build",
          workingDirectory: tempDirectory,
          maxSteps: 30,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: async (input) => {
            calls.inputs.push(input);
            const polyglotDirectory = path.join(tempDirectory, "polyglot");
            await mkdir(path.join(polyglotDirectory, "python"), { recursive: true });
            await mkdir(path.join(polyglotDirectory, "go-backend"), { recursive: true });
            await writeFile(
              path.join(polyglotDirectory, "python", "summarize.py"),
              [
                "import sys",
                "values = [int(line.strip()) for line in open(sys.argv[1], encoding='utf8') if line.strip()]",
                "print(f'python count={len(values)} sum={sum(values)} average={sum(values) // len(values)}')",
                "",
              ].join("\n"),
              "utf8",
            );
            await writeFile(
              path.join(polyglotDirectory, "go-backend", "go.mod"),
              "module example.com/polyglot\n\ngo 1.22\n",
              "utf8",
            );
            await writeFile(
              path.join(polyglotDirectory, "go-backend", "main.go"),
              [
                "package main",
                "",
                "import (",
                '  "encoding/json"',
                '  "net/http"',
                ")",
                "",
                "func main() {",
                '  http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(map[string]string{"status":"ok"}) })',
                '  http.HandleFunc("/summary", func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(map[string]int{"count":6,"sum":108}) })',
                '  _ = http.ListenAndServe(":8080", nil)',
                "}",
                "",
              ].join("\n"),
              "utf8",
            );
            await writeFile(
              path.join(polyglotDirectory, "validate.sh"),
              [
                "set -eu",
                "python3 python/summarize.py data/sample.txt",
                "if command -v go >/dev/null 2>&1; then",
                "  (cd go-backend && go test ./...)",
                "else",
                "  grep -q 'module ' go-backend/go.mod",
                "  grep -q 'package main' go-backend/main.go",
                "  grep -q 'net/http' go-backend/main.go",
                "  grep -q '/health' go-backend/main.go",
                "  grep -q '/summary' go-backend/main.go",
                "  echo 'go toolchain unavailable, static Go validation passed'",
                "fi",
                "",
              ].join("\n"),
              "utf8",
            );
            return {
              turnId: "turn-polyglot",
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: "turn-polyglot",
                text: "Created Python CLI and Go HTTP backend; sh validate.sh passed.",
                steps: 1,
                toolResults: [{
                  callId: "call-validate",
                  toolName: "exec_command",
                  output: "python count=6 sum=108 average=18\ngo toolchain unavailable, static Go validation passed",
                  structuredOutput: {
                    command: "sh validate.sh",
                    exitCode: 0,
                    stdout: "python count=6 sum=108 average=18\ngo toolchain unavailable, static Go validation passed\n",
                    stderr: "",
                    timedOut: false,
                  },
                }],
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    try {
      const code = await runCli({
        argv: [
          "scenario",
          "run",
          "act-multilang-python-go",
          "--model",
          "gemma4:31b",
          "--runtime",
          "ollama-native",
          "--cwd",
          tempDirectory,
          "--json",
        ],
        cwd: "/tmp/gemma-project",
        env: {},
        stdin: new MemoryStream(),
        stdout,
        stderr: new MemoryStream(),
        dependencies,
      });

      expect(code).toBe(0);
      expect(calls.inputs).toHaveLength(1);
      expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
        scenarioId: "act-multilang-python-go",
        artifactDirectory: path.join(tempDirectory, "polyglot"),
        evaluation: {
          success: true,
          checks: {
            pythonSourcePresent: true,
            goBackendPresent: true,
            validationPassed: true,
          },
        },
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs the ACT compaction checkpoint scenario and forces SDK compaction between turns", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-compaction-scenario-"));
    const calls = {
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
      compactOptions: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: () => {
        const snapshot = makeSnapshot({
          mode: "build",
          workingDirectory: tempDirectory,
          maxSteps: 30,
        });
        let turnIndex = 0;
        const session: SessionLike & {
          compact(options?: unknown): Promise<unknown>;
        } = {
          id: snapshot.sessionId,
          snapshot: () => ({
            ...snapshot,
            compaction: calls.compactOptions.length > 0
              ? { count: calls.compactOptions.length, lastCompactedAt: "2026-04-29T00:00:00.000Z" }
              : undefined,
          }),
          compact: (options) => {
            calls.compactOptions.push(options);
            return Promise.resolve({
              sessionId: "session-1",
              runtimeId: "ollama-native",
              modelId: "gemma4:e2b",
              compactedAt: "2026-04-29T00:00:00.000Z",
              summary: "AURORA-17 on port 4173 with north-star checksum: 918273.",
              previousHistoryCount: 4,
              retainedMessageCount: 0,
              historyCount: 1,
            });
          },
          runStreamed: async (input) => {
            calls.inputs.push(input);
            const labDirectory = path.join(tempDirectory, "compaction-lab");
            await mkdir(labDirectory, { recursive: true });
            if (turnIndex === 0) {
              await writeFile(
                path.join(labDirectory, "checkpoint.json"),
                JSON.stringify({
                  codename: "AURORA-17",
                  targetPort: 4173,
                  checksum: "north-star checksum: 918273",
                  milestones: ["ingest", "design", "verify"],
                }, null, 2),
                "utf8",
              );
              await writeFile(
                path.join(labDirectory, "notes.md"),
                [
                  "# AURORA-17",
                  "",
                  "target port: 4173",
                  "north-star checksum: 918273",
                  "- ingest",
                  "- design",
                  "- verify",
                  "",
                ].join("\n"),
                "utf8",
              );
              await writeFile(
                path.join(labDirectory, "package.json"),
                JSON.stringify({
                  type: "module",
                  scripts: {
                    test: "node -e \"console.log('checkpoint ready')\"",
                  },
                }, null, 2),
                "utf8",
              );
            } else {
              await writeFile(
                path.join(labDirectory, "verify.js"),
                [
                  "import { readFileSync } from 'node:fs';",
                  "const checkpoint = JSON.parse(readFileSync('checkpoint.json', 'utf8'));",
                  "const notes = readFileSync('notes.md', 'utf8');",
                  "const required = ['AURORA-17', '4173', 'north-star checksum: 918273', 'ingest', 'design', 'verify'];",
                  "for (const value of required) {",
                  "  if (!notes.includes(value) && !JSON.stringify(checkpoint).includes(value)) throw new Error(`missing ${value}`);",
                  "}",
                  "console.log('compaction checkpoint verified');",
                  "",
                ].join("\n"),
                "utf8",
              );
              await writeFile(
                path.join(labDirectory, "package.json"),
                JSON.stringify({
                  type: "module",
                  scripts: {
                    test: "node verify.js",
                  },
                }, null, 2),
                "utf8",
              );
            }
            turnIndex += 1;
            return {
              turnId: `turn-compaction-${turnIndex}`,
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: `turn-compaction-${turnIndex}`,
                text: turnIndex === 1
                  ? "Created checkpoint and ran npm test."
                  : "Continued after compaction and ran npm test.",
                steps: 1,
                toolResults: [{
                  callId: `call-compaction-${turnIndex}`,
                  toolName: "exec_command",
                  output: "npm test passed",
                  structuredOutput: {
                    command: "npm test",
                    exitCode: 0,
                    stdout: "compaction checkpoint verified\n",
                    stderr: "",
                    timedOut: false,
                  },
                }],
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    try {
      const code = await runCli({
        argv: [
          "scenario",
          "run",
          "act-compaction-checkpoint",
          "--model",
          "gemma4:31b",
          "--runtime",
          "ollama-native",
          "--cwd",
          tempDirectory,
          "--json",
        ],
        cwd: "/tmp/gemma-project",
        env: {},
        stdin: new MemoryStream(),
        stdout,
        stderr: new MemoryStream(),
        dependencies,
      });

      expect(code).toBe(0);
      expect(calls.inputs).toHaveLength(2);
      expect(calls.compactOptions).toHaveLength(1);
      const output = JSON.parse(stdout.text()) as {
        turns: Array<{ compaction?: { status?: string } }>;
      };
      expect(output.turns[0]?.compaction).toMatchObject({
        status: "completed",
      });
      expect(output).toMatchObject({
        scenarioId: "act-compaction-checkpoint",
        artifactDirectory: path.join(tempDirectory, "compaction-lab"),
        evaluation: {
          success: true,
          checks: {
            compactionCompleted: true,
            validationPassed: true,
          },
        },
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs multimodal fixture scenarios with structured session inputs", async () => {
    const originalFetch = globalThis.fetch;
    const fixtureBytes = new Uint8Array([1, 2, 3, 4]);
    const mockFetch: typeof fetch = () =>
      Promise.resolve(new Response(fixtureBytes, {
        status: 200,
        headers: {
          "content-length": String(fixtureBytes.byteLength),
        },
      }));
    globalThis.fetch = mockFetch;

    const scenarios = [
      {
        id: "image-reading-card",
        expectedInputType: "image_url",
        text: "The image says ORION 47, TOTAL 128.50, STATUS READY.",
      },
      {
        id: "audio-harvard-transcript",
        expectedInputType: "audio_url",
        text: "Open Speech Repository Harvard sentence: The birch canoe slid on the smooth planks.",
      },
      {
        id: "video-placeholder-keyframes",
        expectedInputType: "image_url",
        text: "The prepared video keyframe shows a 640x360 placeholder video.",
      },
    ] as const;

    try {
      for (const scenario of scenarios) {
        const tempDirectory = await mkdtemp(path.join(os.tmpdir(), `gemma-desktop-cli-${scenario.id}-`));
        const calls = {
          inputs: [] as unknown[],
        };
        const stdout = new MemoryStream();
        const dependencies: CliDependencies = {
          createGemmaDesktop: () => {
            const snapshot = makeSnapshot({
              mode: "explore",
              workingDirectory: tempDirectory,
              maxSteps: 30,
            });
            const session: SessionLike = {
              id: snapshot.sessionId,
              snapshot: () => snapshot,
              runStreamed: async (input) => {
                await Promise.resolve();
                calls.inputs.push(input);
                return {
                  turnId: `turn-${scenario.id}`,
                  events: (async function* () {})(),
                  completed: Promise.resolve(makeTurnResult({
                    turnId: `turn-${scenario.id}`,
                    text: scenario.text,
                    steps: 1,
                    toolResults: [],
                  })),
                };
              },
            };
            return Promise.resolve({
              inspectEnvironment: () => Promise.resolve(makeInspection()),
              describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
              sessions: {
                create: () => Promise.resolve(session),
              },
            });
          },
        };

        try {
          const code = await runCli({
            argv: [
              "scenario",
              "run",
              scenario.id,
              "--model",
              "gemma4:26b",
              "--runtime",
              "ollama-native",
              "--cwd",
              tempDirectory,
              "--json",
            ],
            cwd: "/tmp/gemma-project",
            env: {},
            stdin: new MemoryStream(),
            stdout,
            stderr: new MemoryStream(),
            dependencies,
          });

          expect(code).toBe(0);
          expect(calls.inputs).toHaveLength(1);
          expect(Array.isArray(calls.inputs[0])).toBe(true);
          expect((calls.inputs[0] as Array<{ type: string }>).some((part) =>
            part.type === scenario.expectedInputType,
          )).toBe(true);
          expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
            scenarioId: scenario.id,
            evaluation: {
              success: true,
            },
          });
        } finally {
          await rm(tempDirectory, { recursive: true, force: true });
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs the managed-browser episode search scenario through the browser tool", async () => {
    const calls = {
      sessionOptions: [] as CreateSessionOptions[],
      inputs: [] as unknown[],
    };
    const stdout = new MemoryStream();

    const dependencies: CliDependencies = {
      createGemmaDesktop: () => {
        const snapshot = makeSnapshot({
          mode: "explore",
          workingDirectory: "/tmp/gemma-project",
          maxSteps: 30,
        });
        const session: SessionLike = {
          id: snapshot.sessionId,
          snapshot: () => snapshot,
          runStreamed: async (input) => {
            await Promise.resolve();
            calls.inputs.push(input);
            return {
              turnId: "turn-browser",
              events: (async function* () {})(),
              completed: Promise.resolve(makeTurnResult({
                turnId: "turn-browser",
                text: [
                  "Used the browser to open https://therestishistory.com/, navigate to Episodes, find the search box, and search for Lyndon.",
                  "- The American Century: Lyndon B. Johnson - https://therestishistory.com/episodes/lyndon-johnson",
                ].join("\n"),
                steps: 4,
                toolResults: [{
                  callId: "call-browser",
                  toolName: "browser",
                  output: "Browser search results for Lyndon on therestishistory.com episodes.",
                  structuredOutput: {
                    action: "snapshot",
                    data: {
                      snapshot: "Episodes search results Lyndon https://therestishistory.com/episodes/lyndon-johnson",
                    },
                  },
                }],
              })),
            };
          },
        };
        return Promise.resolve({
          inspectEnvironment: () => Promise.resolve(makeInspection()),
          describeSession: (targetSnapshot) => makeDebugSnapshot(targetSnapshot),
          sessions: {
            create: (sessionOptions) => {
              calls.sessionOptions.push(sessionOptions);
              return Promise.resolve(session);
            },
          },
        });
      },
    };

    const code = await runCli({
      argv: [
        "scenario",
        "run",
        "browser-rest-is-history-lyndon",
        "--model",
        "gemma4:31b",
        "--runtime",
        "ollama-native",
        "--json",
      ],
      cwd: "/tmp/gemma-project",
      env: {},
      stdin: new MemoryStream(),
      stdout,
      stderr: new MemoryStream(),
      dependencies,
    });

    expect(code).toBe(0);
    expect(calls.sessionOptions[0]?.mode).toMatchObject({
      base: "explore",
      tools: ["browser"],
      withoutTools: ["fetch_url", "search_web", "web_research_agent"],
    });
    expect(JSON.parse(stdout.text()) as unknown).toMatchObject({
      scenarioId: "browser-rest-is-history-lyndon",
      evaluation: {
        success: true,
        checks: {
          browserToolUsed: true,
          lyndonResultsReturned: true,
          episodeLinksReturned: true,
        },
      },
    });
  });
});
