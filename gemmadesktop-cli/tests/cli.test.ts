import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEvent,
  type EnvironmentInspectionResult,
  type SessionSnapshot,
  type TurnResult,
} from "@gemma-desktop/sdk-core";
import type { CreateGemmaDesktopOptions, CreateSessionOptions, SessionDebugSnapshot } from "@gemma-desktop/sdk-node";
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
}): CliDependencies {
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
            completed: Promise.resolve(makeTurnResult({
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
        "--reasoning",
        "off",
        "--ollama-option",
        "num_ctx=8192",
        "--ollama-keep-alive",
        "24h",
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
        surface: "default",
        storageScope: "project",
      },
      [REQUEST_PREFERENCES_METADATA_KEY]: {
        reasoningMode: "off",
        ollamaOptions: { num_ctx: 8192 },
        ollamaKeepAlive: "24h",
      },
    });
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
});
