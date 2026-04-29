import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioId } from "../src/args.js";
import { runCli } from "../src/cli.js";
import {
  isOllamaLiveEnabled,
  liveRuntimeCliEndpointArgs,
  withLiveRuntimeModel,
} from "./helpers/ollama-live.js";

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

interface ScenarioDiagnostic {
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
  status: LiveScenarioStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failureReason?: string;
  output?: unknown;
}

type LiveScenarioStatus = "running" | "passed" | "failed" | "timed_out" | "error";

interface LiveRunSummary {
  runId: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  updatedAt: string;
  runtimeId: string;
  harnessRoot: string;
  logRoot: string;
  resultsDirectory: string;
  eventLogPath: string;
  scenarios: ScenarioId[];
  diagnostics: Array<{
    scenarioId: ScenarioId;
    modelId: string;
    status: LiveScenarioStatus;
    durationMs?: number;
    exitCode?: number | null;
    failureReason?: string;
  }>;
}

const DEFAULT_LIVE_SCENARIOS: ScenarioId[] = [
  "web-hacker-news-frontpage",
  "web-news-coverage-compare",
  "browser-rest-is-history-lyndon",
  "pdf-attention-authors",
  "research-gemma4-availability",
  "image-reading-card",
  "video-placeholder-keyframes",
  "audio-harvard-transcript",
  "act-fix-broken-tests",
  "act-compaction-checkpoint",
  "act-multilang-python-go",
  "act-webapp-black-hole",
];

const itIfLive = isOllamaLiveEnabled() ? it : it.skip;

function configuredEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseScenarioSelection(): ScenarioId[] {
  const raw = process.env.GEMMA_DESKTOP_CLI_SCENARIOS?.trim();
  if (!raw) {
    return DEFAULT_LIVE_SCENARIOS;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ScenarioId => entry.length > 0);
}

function scenarioEnvSuffix(scenarioId: ScenarioId): string {
  return scenarioId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function resolveModelForScenario(scenarioId: ScenarioId): string {
  const specific = process.env[`GEMMA_DESKTOP_CLI_SCENARIO_MODEL_${scenarioEnvSuffix(scenarioId)}`]?.trim();
  if (specific) {
    return specific;
  }

  if (scenarioId === "audio-harvard-transcript") {
    return (
      process.env.GEMMA_DESKTOP_CLI_AUDIO_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_CLI_MULTIMODAL_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_CLI_SCENARIO_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_LIVE_MODEL_ID?.trim()
      || "gemma4:26b"
    );
  }

  if (scenarioId === "image-reading-card" || scenarioId === "video-placeholder-keyframes") {
    return (
      process.env.GEMMA_DESKTOP_CLI_MULTIMODAL_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_CLI_SCENARIO_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_LIVE_MODEL_ID?.trim()
      || "gemma4:26b"
    );
  }

  return configuredEnvValue(
    "GEMMA_DESKTOP_CLI_SCENARIO_MODEL_ID",
    "GEMMA_DESKTOP_LIVE_MODEL_ID",
  ) ?? "gemma4:26b";
}

function groupScenariosByModel(scenarios: ScenarioId[]): Map<string, ScenarioId[]> {
  const groups = new Map<string, ScenarioId[]>();
  for (const scenarioId of scenarios) {
    const modelId = resolveModelForScenario(scenarioId);
    groups.set(modelId, [...(groups.get(modelId) ?? []), scenarioId]);
  }
  return groups;
}

function shouldUseYolo(scenarioId: ScenarioId): boolean {
  return scenarioId.startsWith("act-") || scenarioId === "pdf-attention-authors" || scenarioId === "research-gemma4-availability";
}

function currentIsoTime(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoRootFromCwd(): string {
  return path.basename(process.cwd()) === "gemmadesktop-cli"
    ? path.dirname(process.cwd())
    : process.cwd();
}

function defaultLiveLogBaseDirectory(): string {
  return path.join(repoRootFromCwd(), ".tmp", "live-tests");
}

function resolveLiveLogBaseDirectory(): string {
  return process.env.GEMMA_DESKTOP_CLI_LIVE_LOG_DIR?.trim() || defaultLiveLogBaseDirectory();
}

function formatRunId(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "Z");
}

async function createLiveRunLogRoot(): Promise<string> {
  const baseDirectory = resolveLiveLogBaseDirectory();
  await mkdir(baseDirectory, { recursive: true });
  return await mkdtemp(path.join(baseDirectory, `${formatRunId()}-${process.pid}-`));
}

async function appendRunEvent(logRoot: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await appendFile(
    path.join(logRoot, "events.ndjson"),
    `${JSON.stringify({ time: currentIsoTime(), type, ...payload })}\n`,
    "utf8",
  );
}

function evaluationFromOutput(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  return isRecord(output.evaluation) ? output.evaluation : undefined;
}

function outputSucceeded(output: unknown): boolean {
  return evaluationFromOutput(output)?.success === true;
}

function issuesFromOutput(output: unknown): string[] {
  const issues = evaluationFromOutput(output)?.issues;
  return Array.isArray(issues)
    ? issues.filter((issue): issue is string => typeof issue === "string")
    : [];
}

function scenarioTimedOut(stdout: string, stderr: string): boolean {
  return /timed out after \d+ms|timeout|timed out/i.test(`${stdout}\n${stderr}`);
}

function failureReasonForDiagnostic(diagnostic: ScenarioDiagnostic): string | undefined {
  if (diagnostic.status === "running") {
    return undefined;
  }

  if (diagnostic.status === "passed") {
    return undefined;
  }

  if (diagnostic.failureReason) {
    return diagnostic.failureReason;
  }

  if (scenarioTimedOut(diagnostic.stdout, diagnostic.stderr)) {
    return "Scenario hit a timeout. Inspect the per-scenario JSON stdout/stderr for the timed-out turn or tool.";
  }

  const issues = issuesFromOutput(diagnostic.output);
  if (issues.length > 0) {
    return `Scenario evaluator failed: ${issues.join(", ")}`;
  }

  if (diagnostic.exitCode !== 0) {
    return `Scenario command exited with ${diagnostic.exitCode}.`;
  }

  return "Scenario did not report success.";
}

function diagnosticSummary(diagnostic: ScenarioDiagnostic): LiveRunSummary["diagnostics"][number] {
  const failureReason = failureReasonForDiagnostic(diagnostic);
  return {
    scenarioId: diagnostic.scenarioId,
    modelId: diagnostic.modelId,
    status: diagnostic.status,
    durationMs: diagnostic.durationMs,
    exitCode: diagnostic.exitCode,
    ...(failureReason ? { failureReason } : {}),
  };
}

function summarizeDiagnostics(diagnostics: ScenarioDiagnostic[]): LiveRunSummary["diagnostics"] {
  return diagnostics.map(diagnosticSummary);
}

async function writeRunSummary(input: {
  logRoot: string;
  runtimeId: string;
  harnessRoot: string;
  resultsDirectory: string;
  scenarios: ScenarioId[];
  diagnostics: ScenarioDiagnostic[];
  startedAt: string;
}): Promise<void> {
  const allFinished = input.diagnostics.length === input.scenarios.length
    && input.diagnostics.every((diagnostic) => diagnostic.status !== "running");
  const failed = input.diagnostics.some((diagnostic) => diagnostic.status !== "passed");
  const summary: LiveRunSummary = {
    runId: path.basename(input.logRoot),
    status: allFinished ? (failed ? "failed" : "passed") : "running",
    startedAt: input.startedAt,
    updatedAt: currentIsoTime(),
    runtimeId: input.runtimeId,
    harnessRoot: input.harnessRoot,
    logRoot: input.logRoot,
    resultsDirectory: input.resultsDirectory,
    eventLogPath: path.join(input.logRoot, "events.ndjson"),
    scenarios: input.scenarios,
    diagnostics: summarizeDiagnostics(input.diagnostics),
  };
  await writeFile(
    path.join(input.logRoot, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

async function runScenario(input: {
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
  harnessRoot: string;
}): Promise<ScenarioDiagnostic> {
  const workingDirectory = path.join(input.harnessRoot, input.scenarioId);
  await mkdir(workingDirectory, { recursive: true });
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const startedAt = Date.now();
  const startedAtIso = currentIsoTime();
  const args = [
    "scenario",
    "run",
    input.scenarioId,
    "--runtime",
    input.runtimeId,
    "--model",
    input.modelId,
    ...liveRuntimeCliEndpointArgs(),
    "--cwd",
    workingDirectory,
    "--turn-timeout-ms",
    process.env.GEMMA_DESKTOP_CLI_SCENARIO_TURN_TIMEOUT_MS?.trim() || "480000",
    "--max-steps",
    process.env.GEMMA_DESKTOP_CLI_SCENARIO_MAX_STEPS?.trim() || "12",
    "--json",
  ];

  if (shouldUseYolo(input.scenarioId)) {
    args.push("--approval-mode", "yolo");
  }

  if (process.env.GEMMA_DESKTOP_CLI_SCENARIO_SHOW_EVENTS === "1") {
    args.push("--show-events");
  }

  try {
    const exitCode = await runCli({
      argv: args,
      cwd: workingDirectory,
      env: process.env,
      stdin: new MemoryStream(),
      stdout,
      stderr,
    });
    const stdoutText = stdout.text();
    const stderrText = stderr.text();
    let output: unknown;
    try {
      output = JSON.parse(stdoutText) as unknown;
    } catch {
      output = undefined;
    }
    const status: LiveScenarioStatus = exitCode === 0 && outputSucceeded(output)
      ? "passed"
      : scenarioTimedOut(stdoutText, stderrText)
        ? "timed_out"
        : "failed";
    const diagnostic: ScenarioDiagnostic = {
      scenarioId: input.scenarioId,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      status,
      startedAt: startedAtIso,
      completedAt: currentIsoTime(),
      durationMs: Date.now() - startedAt,
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      output,
    };
    const failureReason = failureReasonForDiagnostic(diagnostic);
    return {
      ...diagnostic,
      ...(failureReason ? { failureReason } : {}),
    };
  } catch (error) {
    return {
      scenarioId: input.scenarioId,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      status: "error",
      startedAt: startedAtIso,
      completedAt: currentIsoTime(),
      durationMs: Date.now() - startedAt,
      exitCode: null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("CLI live scenario logging", () => {
  it("defaults to the repo-local ignored live-test log directory", () => {
    expect(defaultLiveLogBaseDirectory()).toContain(`${path.sep}.tmp${path.sep}live-tests`);
  });

  it("summarizes timeout failures for durable run logs", () => {
    const diagnostic: ScenarioDiagnostic = {
      scenarioId: "act-webapp-black-hole",
      runtimeId: "ollama-native",
      modelId: "gemma4:26b",
      status: "timed_out",
      startedAt: "2026-04-29T00:00:00.000Z",
      completedAt: "2026-04-29T00:10:00.000Z",
      durationMs: 600_000,
      exitCode: 1,
      stdout: "",
      stderr: "Scenario turn timed out after 600000ms.",
    };

    expect(failureReasonForDiagnostic(diagnostic)).toContain("timeout");
  });
});

describe.sequential("CLI live headless scenarios", () => {
  itIfLive(
    "runs selected real-world scenarios and writes agent-reviewable diagnostics",
    async () => {
      const runtimeId = configuredEnvValue(
        "GEMMA_DESKTOP_CLI_SCENARIO_RUNTIME_ID",
        "GEMMA_DESKTOP_LIVE_RUNTIME_ID",
      ) ?? "ollama-native";
      const scenarios = parseScenarioSelection();
      const grouped = groupScenariosByModel(scenarios);
      const harnessRoot = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-live-scenarios-"));
      const logRoot = await createLiveRunLogRoot();
      const resultsDirectory = path.join(harnessRoot, "results");
      await mkdir(resultsDirectory, { recursive: true });
      const diagnostics: ScenarioDiagnostic[] = [];
      const startedAt = currentIsoTime();

      expect(scenarios.length).toBeGreaterThan(0);
      await appendRunEvent(logRoot, "run_started", {
        runtimeId,
        harnessRoot,
        scenarios,
      });
      await writeRunSummary({
        logRoot,
        runtimeId,
        harnessRoot,
        resultsDirectory,
        scenarios,
        diagnostics,
        startedAt,
      });

      for (const [modelId, scenarioIds] of grouped.entries()) {
        await withLiveRuntimeModel({ runtimeId, modelId }, async () => {
          for (const scenarioId of scenarioIds) {
            console.log(`[cli-live-scenarios] starting ${scenarioId} with ${modelId}`);
            const runningDiagnostic: ScenarioDiagnostic = {
              scenarioId,
              runtimeId,
              modelId,
              status: "running",
              startedAt: currentIsoTime(),
              completedAt: "",
              durationMs: 0,
              exitCode: null,
              stdout: "",
              stderr: "",
            };
            diagnostics.push(runningDiagnostic);
            await appendRunEvent(logRoot, "scenario_started", {
              scenarioId,
              modelId,
            });
            await writeRunSummary({
              logRoot,
              runtimeId,
              harnessRoot,
              resultsDirectory,
              scenarios,
              diagnostics,
              startedAt,
            });
            const diagnostic = await runScenario({
              scenarioId,
              runtimeId,
              modelId,
              harnessRoot,
            });
            diagnostics.splice(diagnostics.indexOf(runningDiagnostic), 1, diagnostic);
            await writeFile(
              path.join(resultsDirectory, `${scenarioId}.json`),
              `${JSON.stringify(diagnostic, null, 2)}\n`,
              "utf8",
            );
            await writeFile(
              path.join(logRoot, `${scenarioId}.json`),
              `${JSON.stringify(diagnostic, null, 2)}\n`,
              "utf8",
            );
            await appendRunEvent(logRoot, "scenario_completed", {
              scenarioId,
              modelId,
              status: diagnostic.status,
              durationMs: diagnostic.durationMs,
              exitCode: diagnostic.exitCode,
              failureReason: failureReasonForDiagnostic(diagnostic),
            });
            await writeRunSummary({
              logRoot,
              runtimeId,
              harnessRoot,
              resultsDirectory,
              scenarios,
              diagnostics,
              startedAt,
            });
            console.log(
              `[cli-live-scenarios] completed ${scenarioId} in ${diagnostic.durationMs}ms with ${diagnostic.status} exit ${diagnostic.exitCode}`,
            );
          }
        });
      }

      await appendRunEvent(logRoot, "run_completed", {
        status: diagnostics.every((diagnostic) => diagnostic.status === "passed") ? "passed" : "failed",
      });
      await writeFile(
        path.join(resultsDirectory, "summary.json"),
        `${JSON.stringify({
          runtimeId,
          harnessRoot,
          logRoot,
          scenarios,
          diagnostics: summarizeDiagnostics(diagnostics),
        }, null, 2)}\n`,
        "utf8",
      );
      await writeRunSummary({
        logRoot,
        runtimeId,
        harnessRoot,
        resultsDirectory,
        scenarios,
        diagnostics,
        startedAt,
      });

      console.log("[cli-live-scenarios] harnessRoot:", harnessRoot);
      console.log("[cli-live-scenarios] logRoot:", logRoot);
      for (const diagnostic of diagnostics.filter((entry) => entry.status === "passed")) {
        expect(diagnostic.exitCode).toBe(0);
        expect(diagnostic.stdout).toContain('"success": true');
      }
      expect(diagnostics.filter((entry) => entry.status !== "passed").map(diagnosticSummary)).toEqual([]);
    },
    90 * 60_000,
  );
});
