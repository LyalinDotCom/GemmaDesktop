import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioId } from "../../src/args.js";
import { runCli } from "../../src/cli.js";
import {
  isOllamaLiveEnabled,
  liveRuntimeCliEndpointArgs,
  withLiveRuntimeModel,
} from "../helpers/ollama-live.js";

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
  performance?: ScenarioPerformanceSummary;
  output?: unknown;
}

type LiveScenarioStatus = "running" | "passed" | "failed" | "timed_out" | "error";

interface LiveScenarioTarget {
  runtimeId: string;
  modelId: string;
  scenarioIds: ScenarioId[];
}

interface ScenarioPerformanceSummary {
  wallClockDurationMs: number;
  turnCount?: number;
  turnDurationMs?: number;
  timeToFirstTokenMs?: number;
  timeToFirstAssistantTokenMs?: number;
  tokenEventCount?: number;
  outputCharacters?: number;
}

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
  targets: LiveScenarioTarget[];
  diagnostics: Array<{
    scenarioId: ScenarioId;
    runtimeId: string;
    modelId: string;
    status: LiveScenarioStatus;
    durationMs?: number;
    exitCode?: number | null;
    failureReason?: string;
    performance?: ScenarioPerformanceSummary;
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

function parseLiveScenarioTargets(raw: string): Array<Omit<LiveScenarioTarget, "scenarioIds">> {
  return raw
    .split(/[;,\n]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(
          `Invalid live scenario target "${entry}". Use runtimeId=modelId, separated by semicolons for multiple targets.`,
        );
      }
      return {
        runtimeId: entry.slice(0, separator).trim(),
        modelId: entry.slice(separator + 1).trim(),
      };
    });
}

function resolveScenarioTargets(scenarios: ScenarioId[]): LiveScenarioTarget[] {
  const rawTargets = configuredEnvValue(
    "GEMMA_DESKTOP_CLI_SCENARIO_TARGETS",
    "GEMMA_DESKTOP_LIVE_TARGETS",
  );
  if (rawTargets) {
    return parseLiveScenarioTargets(rawTargets).map((target) => ({
      ...target,
      scenarioIds: scenarios,
    }));
  }

  const runtimeId = configuredEnvValue(
    "GEMMA_DESKTOP_CLI_SCENARIO_RUNTIME_ID",
    "GEMMA_DESKTOP_LIVE_RUNTIME_ID",
  ) ?? "ollama-native";
  return Array.from(groupScenariosByModel(scenarios).entries()).map(([modelId, scenarioIds]) => ({
    runtimeId,
    modelId,
    scenarioIds,
  }));
}

function runtimeIdForTargets(targets: readonly LiveScenarioTarget[]): string {
  const runtimeIds = Array.from(new Set(targets.map((target) => target.runtimeId)));
  return runtimeIds.length === 1 ? runtimeIds[0] ?? "unknown" : "matrix";
}

function plannedScenarioCount(targets: readonly LiveScenarioTarget[]): number {
  return targets.reduce((sum, target) => sum + target.scenarioIds.length, 0);
}

function safeLogFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "target";
}

function scenarioDiagnosticFileName(input: {
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
}): string {
  return [
    safeLogFileSegment(input.runtimeId),
    safeLogFileSegment(input.modelId),
    input.scenarioId,
  ].join("__");
}

function scenarioTargetKey(input: {
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
}): string {
  return `${input.runtimeId}\0${input.modelId}\0${input.scenarioId}`;
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

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumberProperty(records: readonly Record<string, unknown>[], key: string): number | undefined {
  for (const record of records) {
    const value = numberProperty(record, key);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function sumNumberProperty(records: readonly Record<string, unknown>[], key: string): number | undefined {
  const values = records
    .map((record) => numberProperty(record, key))
    .filter((value): value is number => value != null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function performanceSummaryFromOutput(
  output: unknown,
  wallClockDurationMs: number,
): ScenarioPerformanceSummary {
  const summary: ScenarioPerformanceSummary = { wallClockDurationMs };
  if (!isRecord(output) || !Array.isArray(output.turns)) {
    return summary;
  }

  const turnPerformanceRecords = output.turns
    .map((turn) => (isRecord(turn) && isRecord(turn.performance) ? turn.performance : undefined))
    .filter((performance): performance is Record<string, unknown> => performance != null);
  if (turnPerformanceRecords.length === 0) {
    return summary;
  }

  const turnDurationMs = sumNumberProperty(turnPerformanceRecords, "durationMs");
  const timeToFirstTokenMs = firstNumberProperty(turnPerformanceRecords, "timeToFirstTokenMs");
  const timeToFirstAssistantTokenMs = firstNumberProperty(turnPerformanceRecords, "timeToFirstAssistantTokenMs");
  const tokenEventCount = sumNumberProperty(turnPerformanceRecords, "tokenEventCount");
  const outputCharacters = sumNumberProperty(turnPerformanceRecords, "outputCharacters");
  return {
    ...summary,
    turnCount: turnPerformanceRecords.length,
    ...(turnDurationMs != null ? { turnDurationMs } : {}),
    ...(timeToFirstTokenMs != null ? { timeToFirstTokenMs } : {}),
    ...(timeToFirstAssistantTokenMs != null ? { timeToFirstAssistantTokenMs } : {}),
    ...(tokenEventCount != null ? { tokenEventCount } : {}),
    ...(outputCharacters != null ? { outputCharacters } : {}),
  };
}

function formatPerformanceSummary(performance?: ScenarioPerformanceSummary): string {
  if (!performance) {
    return "";
  }
  const ttft = performance.timeToFirstTokenMs != null
    ? `${performance.timeToFirstTokenMs}ms`
    : "n/a";
  const assistantTtft = performance.timeToFirstAssistantTokenMs != null
    ? `${performance.timeToFirstAssistantTokenMs}ms`
    : "n/a";
  return `, ttft ${ttft}, assistant-ttft ${assistantTtft}, completion ${performance.wallClockDurationMs}ms`;
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

function formatUnknownError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors
      .map((entry) => formatUnknownError(entry))
      .filter(Boolean)
      .join("; ") || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function targetSetupFailureDiagnostic(input: {
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
  error: unknown;
}): ScenarioDiagnostic {
  const message = formatUnknownError(input.error);
  return {
    scenarioId: input.scenarioId,
    runtimeId: input.runtimeId,
    modelId: input.modelId,
    status: "error",
    startedAt: currentIsoTime(),
    completedAt: currentIsoTime(),
    durationMs: 0,
    exitCode: null,
    stdout: "",
    stderr: "",
    performance: { wallClockDurationMs: 0 },
    failureReason: `Live runtime setup failed before scenario execution: ${message}`,
  };
}

function diagnosticSummary(diagnostic: ScenarioDiagnostic): LiveRunSummary["diagnostics"][number] {
  const failureReason = failureReasonForDiagnostic(diagnostic);
  return {
    scenarioId: diagnostic.scenarioId,
    runtimeId: diagnostic.runtimeId,
    modelId: diagnostic.modelId,
    status: diagnostic.status,
    durationMs: diagnostic.durationMs,
    exitCode: diagnostic.exitCode,
    ...(failureReason ? { failureReason } : {}),
    ...(diagnostic.performance ? { performance: diagnostic.performance } : {}),
  };
}

function summarizeDiagnostics(diagnostics: ScenarioDiagnostic[]): LiveRunSummary["diagnostics"] {
  return diagnostics.map(diagnosticSummary);
}

async function writeScenarioDiagnostic(input: {
  diagnostic: ScenarioDiagnostic;
  logRoot: string;
  resultsDirectory: string;
}): Promise<void> {
  const diagnosticFileName = `${scenarioDiagnosticFileName(input.diagnostic)}.json`;
  const diagnosticJson = `${JSON.stringify(input.diagnostic, null, 2)}\n`;
  await writeFile(path.join(input.resultsDirectory, diagnosticFileName), diagnosticJson, "utf8");
  await writeFile(path.join(input.logRoot, diagnosticFileName), diagnosticJson, "utf8");
}

async function writeRunSummary(input: {
  logRoot: string;
  runtimeId: string;
  targets: LiveScenarioTarget[];
  harnessRoot: string;
  resultsDirectory: string;
  scenarios: ScenarioId[];
  diagnostics: ScenarioDiagnostic[];
  startedAt: string;
}): Promise<void> {
  const allFinished = input.diagnostics.length === plannedScenarioCount(input.targets)
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
    targets: input.targets,
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
  const workingDirectory = path.join(input.harnessRoot, scenarioDiagnosticFileName(input));
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
    const durationMs = Date.now() - startedAt;
    const performance = performanceSummaryFromOutput(output, durationMs);
    const diagnostic: ScenarioDiagnostic = {
      scenarioId: input.scenarioId,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      status,
      startedAt: startedAtIso,
      completedAt: currentIsoTime(),
      durationMs,
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      performance,
      output,
    };
    const failureReason = failureReasonForDiagnostic(diagnostic);
    return {
      ...diagnostic,
      ...(failureReason ? { failureReason } : {}),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      scenarioId: input.scenarioId,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      status: "error",
      startedAt: startedAtIso,
      completedAt: currentIsoTime(),
      durationMs,
      exitCode: null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      performance: { wallClockDurationMs: durationMs },
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

  it("parses provider/model matrix targets for comparative live runs", () => {
    expect(
      parseLiveScenarioTargets(
        [
          "ollama-native=gemma4:26b-mlx-bf16",
          "lmstudio-openai=supergemma4-26b-uncensored-mlx-v2",
          "omlx-openai=gemma-4-26b-a4b-it-nvfp4",
        ].join(";"),
      ),
    ).toEqual([
      { runtimeId: "ollama-native", modelId: "gemma4:26b-mlx-bf16" },
      { runtimeId: "lmstudio-openai", modelId: "supergemma4-26b-uncensored-mlx-v2" },
      { runtimeId: "omlx-openai", modelId: "gemma-4-26b-a4b-it-nvfp4" },
    ]);
  });

  it("summarizes turn-level TTFT and completion timings from scenario JSON", () => {
    const performance = performanceSummaryFromOutput(
      {
        turns: [
          {
            performance: {
              durationMs: 1_200,
              timeToFirstTokenMs: 310,
              timeToFirstAssistantTokenMs: 420,
              tokenEventCount: 3,
              outputCharacters: 24,
            },
          },
          {
            performance: {
              durationMs: 800,
              timeToFirstTokenMs: 200,
              tokenEventCount: 2,
              outputCharacters: 10,
            },
          },
        ],
      },
      2_400,
    );

    expect(performance).toEqual({
      wallClockDurationMs: 2_400,
      turnCount: 2,
      turnDurationMs: 2_000,
      timeToFirstTokenMs: 310,
      timeToFirstAssistantTokenMs: 420,
      tokenEventCount: 5,
      outputCharacters: 34,
    });
  });

  it("records runtime setup failures as per-scenario diagnostics", () => {
    const diagnostic = targetSetupFailureDiagnostic({
      scenarioId: "web-hacker-news-frontpage",
      runtimeId: "lmstudio-openai",
      modelId: "gemma-4-26b-a4b-it-nvfp4",
      error: new Error("Failed to load model."),
    });

    expect(diagnostic.status).toBe("error");
    expect(diagnostic.exitCode).toBeNull();
    expect(diagnostic.failureReason).toContain("Live runtime setup failed");
    expect(diagnostic.failureReason).toContain("Failed to load model.");
  });
});

describe.sequential("CLI live headless scenarios", () => {
  itIfLive(
    "runs selected real-world scenarios and writes agent-reviewable diagnostics",
    async () => {
      const scenarios = parseScenarioSelection();
      const targets = resolveScenarioTargets(scenarios);
      const runtimeId = runtimeIdForTargets(targets);
      const harnessRoot = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-live-scenarios-"));
      const logRoot = await createLiveRunLogRoot();
      const resultsDirectory = path.join(harnessRoot, "results");
      await mkdir(resultsDirectory, { recursive: true });
      const diagnostics: ScenarioDiagnostic[] = [];
      const targetFailures: string[] = [];
      const startedAt = currentIsoTime();

      expect(scenarios.length).toBeGreaterThan(0);
      expect(targets.length).toBeGreaterThan(0);
      await appendRunEvent(logRoot, "run_started", {
        runtimeId,
        targets,
        harnessRoot,
        scenarios,
      });
      await writeRunSummary({
        logRoot,
        runtimeId,
        targets,
        harnessRoot,
        resultsDirectory,
        scenarios,
        diagnostics,
        startedAt,
      });

      for (const target of targets) {
        try {
          await withLiveRuntimeModel({ runtimeId: target.runtimeId, modelId: target.modelId }, async () => {
            for (const scenarioId of target.scenarioIds) {
              console.log(
                `[cli-live-scenarios] starting ${scenarioId} with ${target.runtimeId}/${target.modelId}`,
              );
              const runningDiagnostic: ScenarioDiagnostic = {
                scenarioId,
                runtimeId: target.runtimeId,
                modelId: target.modelId,
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
                runtimeId: target.runtimeId,
                modelId: target.modelId,
              });
              await writeRunSummary({
                logRoot,
                runtimeId,
                targets,
                harnessRoot,
                resultsDirectory,
                scenarios,
                diagnostics,
                startedAt,
              });
              const diagnostic = await runScenario({
                scenarioId,
                runtimeId: target.runtimeId,
                modelId: target.modelId,
                harnessRoot,
              });
              diagnostics.splice(diagnostics.indexOf(runningDiagnostic), 1, diagnostic);
              await writeScenarioDiagnostic({ diagnostic, logRoot, resultsDirectory });
              await appendRunEvent(logRoot, "scenario_completed", {
                scenarioId,
                runtimeId: target.runtimeId,
                modelId: target.modelId,
                status: diagnostic.status,
                durationMs: diagnostic.durationMs,
                performance: diagnostic.performance,
                exitCode: diagnostic.exitCode,
                failureReason: failureReasonForDiagnostic(diagnostic),
              });
              await writeRunSummary({
                logRoot,
                runtimeId,
                targets,
                harnessRoot,
                resultsDirectory,
                scenarios,
                diagnostics,
                startedAt,
              });
              console.log(
                [
                  `[cli-live-scenarios] completed ${scenarioId}`,
                  `with ${diagnostic.runtimeId}/${diagnostic.modelId}`,
                  `in ${diagnostic.durationMs}ms`,
                  `status ${diagnostic.status}`,
                  `exit ${diagnostic.exitCode}${formatPerformanceSummary(diagnostic.performance)}`,
                ].join(" "),
              );
            }
          });
        } catch (error) {
          const failureReason = formatUnknownError(error);
          targetFailures.push(`${target.runtimeId}/${target.modelId}: ${failureReason}`);
          console.error(
            `[cli-live-scenarios] target setup failed for ${target.runtimeId}/${target.modelId}: ${failureReason}`,
          );
          await appendRunEvent(logRoot, "target_setup_failed", {
            runtimeId: target.runtimeId,
            modelId: target.modelId,
            failureReason,
          });
          const existingDiagnostics = new Set(diagnostics.map(scenarioTargetKey));
          for (const scenarioId of target.scenarioIds) {
            const diagnostic = targetSetupFailureDiagnostic({
              scenarioId,
              runtimeId: target.runtimeId,
              modelId: target.modelId,
              error,
            });
            if (existingDiagnostics.has(scenarioTargetKey(diagnostic))) {
              continue;
            }
            diagnostics.push(diagnostic);
            existingDiagnostics.add(scenarioTargetKey(diagnostic));
            await writeScenarioDiagnostic({ diagnostic, logRoot, resultsDirectory });
            await appendRunEvent(logRoot, "scenario_completed", {
              scenarioId,
              runtimeId: target.runtimeId,
              modelId: target.modelId,
              status: diagnostic.status,
              durationMs: diagnostic.durationMs,
              performance: diagnostic.performance,
              exitCode: diagnostic.exitCode,
              failureReason: failureReasonForDiagnostic(diagnostic),
            });
            await writeRunSummary({
              logRoot,
              runtimeId,
              targets,
              harnessRoot,
              resultsDirectory,
              scenarios,
              diagnostics,
              startedAt,
            });
          }
        }
      }

      await appendRunEvent(logRoot, "run_completed", {
        status: diagnostics.every((diagnostic) => diagnostic.status === "passed") ? "passed" : "failed",
      });
      await writeFile(
        path.join(resultsDirectory, "summary.json"),
        `${JSON.stringify({
          runtimeId,
          targets,
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
        targets,
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
      expect(targetFailures).toEqual([]);
      expect(diagnostics.filter((entry) => entry.status !== "passed").map(diagnosticSummary)).toEqual([]);
    },
    90 * 60_000,
  );
});
