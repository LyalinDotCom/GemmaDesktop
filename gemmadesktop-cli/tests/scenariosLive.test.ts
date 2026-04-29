import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioId } from "../src/args.js";
import { runCli } from "../src/cli.js";
import {
  isOllamaLiveEnabled,
  withLoadedLiveOllamaModel,
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
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: unknown;
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
  "act-multilang-python-go",
  "act-webapp-black-hole",
];

const itIfLive = isOllamaLiveEnabled() ? it : it.skip;

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
      || "gemma4:26b"
    );
  }

  if (scenarioId === "image-reading-card" || scenarioId === "video-placeholder-keyframes") {
    return (
      process.env.GEMMA_DESKTOP_CLI_MULTIMODAL_MODEL_ID?.trim()
      || process.env.GEMMA_DESKTOP_CLI_SCENARIO_MODEL_ID?.trim()
      || "gemma4:26b"
    );
  }

  return process.env.GEMMA_DESKTOP_CLI_SCENARIO_MODEL_ID?.trim() || "gemma4:26b";
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
  const args = [
    "scenario",
    "run",
    input.scenarioId,
    "--runtime",
    input.runtimeId,
    "--model",
    input.modelId,
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

  const exitCode = await runCli({
    argv: args,
    cwd: workingDirectory,
    env: process.env,
    stdin: new MemoryStream(),
    stdout,
    stderr,
  });
  const stdoutText = stdout.text();
  let output: unknown;
  try {
    output = JSON.parse(stdoutText) as unknown;
  } catch {
    output = undefined;
  }

  return {
    scenarioId: input.scenarioId,
    runtimeId: input.runtimeId,
    modelId: input.modelId,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdout: stdoutText,
    stderr: stderr.text(),
    output,
  };
}

describe.sequential("CLI live headless scenarios", () => {
  itIfLive(
    "runs selected real-world scenarios and writes agent-reviewable diagnostics",
    async () => {
      const runtimeId = process.env.GEMMA_DESKTOP_CLI_SCENARIO_RUNTIME_ID?.trim() || "ollama-native";
      const scenarios = parseScenarioSelection();
      const grouped = groupScenariosByModel(scenarios);
      const harnessRoot = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-cli-live-scenarios-"));
      const resultsDirectory = path.join(harnessRoot, "results");
      await mkdir(resultsDirectory, { recursive: true });
      const diagnostics: ScenarioDiagnostic[] = [];

      expect(scenarios.length).toBeGreaterThan(0);
      expect(
        runtimeId.startsWith("ollama"),
        `CLI live scenarios only support Ollama runtimes so model cleanup can be enforced. Received "${runtimeId}".`,
      ).toBe(true);

      for (const [modelId, scenarioIds] of grouped.entries()) {
        await withLoadedLiveOllamaModel({ modelId }, async () => {
          for (const scenarioId of scenarioIds) {
            console.log(`[cli-live-scenarios] starting ${scenarioId} with ${modelId}`);
            const diagnostic = await runScenario({
              scenarioId,
              runtimeId,
              modelId,
              harnessRoot,
            });
            diagnostics.push(diagnostic);
            await writeFile(
              path.join(resultsDirectory, `${scenarioId}.json`),
              `${JSON.stringify(diagnostic, null, 2)}\n`,
              "utf8",
            );
            console.log(
              `[cli-live-scenarios] completed ${scenarioId} in ${diagnostic.durationMs}ms with exit ${diagnostic.exitCode}`,
            );
            expect(diagnostic.exitCode).toBe(0);
            expect(diagnostic.stdout).toContain('"success": true');
          }
        });
      }

      await writeFile(
        path.join(resultsDirectory, "summary.json"),
        `${JSON.stringify({
          runtimeId,
          harnessRoot,
          scenarios,
          diagnostics: diagnostics.map((diagnostic) => ({
            scenarioId: diagnostic.scenarioId,
            modelId: diagnostic.modelId,
            durationMs: diagnostic.durationMs,
            exitCode: diagnostic.exitCode,
          })),
        }, null, 2)}\n`,
        "utf8",
      );

      console.log("[cli-live-scenarios] harnessRoot:", harnessRoot);
    },
    90 * 60_000,
  );
});
