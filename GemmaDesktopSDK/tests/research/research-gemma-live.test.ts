import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGemmaDesktop, type ResearchRunStatus } from "@gemma-desktop/sdk-node";
import {
  createLiveRuntimeAdapters,
  withLiveRuntimeModel,
} from "../helpers/ollama-live.js";

const GEMMA_PROMPT =
  "I need to understand all the variations of gemma taht exists on ollama, LM studio, hugging face, etc";

const itIfLive = process.env.GEMMA_DESKTOP_RUN_LIVE_RESEARCH === "1" ? it : it.skip;

function configuredEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveConfiguredRuntime(): string {
  return configuredEnvValue(
    "GEMMA_DESKTOP_RESEARCH_RUNTIME_ID",
    "GEMMA_DESKTOP_LIVE_RUNTIME_ID",
  ) ?? "ollama-native";
}

function resolveConfiguredModel(): string {
  return configuredEnvValue(
    "GEMMA_DESKTOP_RESEARCH_MODEL_ID",
    "GEMMA_DESKTOP_LIVE_MODEL_ID",
  ) ?? "gemma4:31b";
}

describe.sequential("live gemma research", () => {
  itIfLive(
    "runs the real Gemma research scenario and generates inspectable artifacts",
    async () => {
      const runtimeId = resolveConfiguredRuntime();
      const modelId = resolveConfiguredModel();
      const adapters = createLiveRuntimeAdapters();

      await withLiveRuntimeModel({ runtimeId, modelId, adapters }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-gemma-research-"),
        );

        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
          adapters,
        });
        const environment = await gemmaDesktop.inspectEnvironment();
        const runtime = environment.runtimes.find(
          (entry) => entry.runtime.id === runtimeId,
        );
        const model = runtime?.models.find((entry) => entry.id === modelId);

        expect(
          runtime,
          `Runtime "${runtimeId}" was not available. Found: ${environment.runtimes.map((entry) => entry.runtime.id).join(", ")}`,
        ).toBeDefined();
        expect(
          model,
          `Model "${modelId}" was not available on runtime "${runtimeId}". Found: ${runtime?.models.map((entry) => entry.id).join(", ") ?? "none"}`,
        ).toBeDefined();

        const session = await gemmaDesktop.sessions.create({
          runtime: runtimeId,
          model: modelId,
          mode: "cowork",
          workingDirectory,
        });

        let lastProgressLine = "";
        const logStatus = (status: ResearchRunStatus): void => {
          const active = status.activities?.[status.activities.length - 1];
          const activeSummary = active
            ? `${active.phase}${active.topicTitle ? `:${active.topicTitle}` : ""}:assistant=${active.assistantDeltaCount}:reasoning=${active.reasoningDeltaCount}:last=${active.lastEventType ?? "none"}`
            : "idle";
          const topicSummary = status.topicStatuses
            .map((topic) => `${topic.title}:${topic.status}`)
            .join(" | ");
          const line = `${status.stage} :: ${activeSummary}${topicSummary ? ` :: ${topicSummary}` : ""}`;
          if (line === lastProgressLine) {
            return;
          }
          lastProgressLine = line;
          console.log("[live-gemma-research] status:", line);
        };

        let result;
        try {
          result = await session.runResearch(GEMMA_PROMPT, {
            profile: "deep",
            onStatus: async (status) => {
              logStatus(status);
            },
          });
        } catch (error) {
          try {
            const researchRunsDirectory = path.join(
              workingDirectory,
              ".gemma",
              "research",
            );
            const runIds = await readdir(researchRunsDirectory);
            const latestRunId = runIds.sort().at(-1);
            if (latestRunId) {
              const latestStatus = await readFile(
                path.join(researchRunsDirectory, latestRunId, "status.json"),
                "utf8",
              );
              console.log("[live-gemma-research] latestStatus:", latestStatus);
            }
          } catch {
            // Best-effort diagnostics only.
          }
          throw error;
        }

        const finalReportText = await readFile(
          path.join(result.artifactDirectory, "final", "report.md"),
          "utf8",
        );
        const planText = await readFile(
          path.join(result.artifactDirectory, "plan.json"),
          "utf8",
        );
        const sourceIndexText = await readFile(
          path.join(result.artifactDirectory, "sources", "index.json"),
          "utf8",
        );
        const dossierTexts = await Promise.all(
          result.plan.topics.map(async (topic) =>
            await readFile(
              path.join(result.artifactDirectory, "dossiers", `${topic.id}.json`),
              "utf8",
            )),
        );
        const suspiciousOutputPattern = /<channel\|>|```|(?:^|\W)jsonset(?:\W|$)|\bthought:\s/i;

        console.log("[live-gemma-research] runtime:", runtimeId);
        console.log("[live-gemma-research] model:", modelId);
        console.log("[live-gemma-research] artifactDirectory:", result.artifactDirectory);
        console.log("[live-gemma-research] topics:", result.plan.topics.length);
        console.log("[live-gemma-research] sources:", result.sources.length);
        console.log("[live-gemma-research] summary:", result.summary);
        console.log(
          "[live-gemma-research] reportPreview:",
          result.finalReport.slice(0, 600),
        );

        expect(result.plan.topics.length).toBeGreaterThanOrEqual(2);
        expect(result.sources.length).toBeGreaterThanOrEqual(3);
        expect(result.summary.trim().length).toBeGreaterThan(0);
        expect(result.finalReport.trim().length).toBeGreaterThan(0);
        expect(result.plan.topics.some((topic) => /^title:/i.test(topic.title))).toBe(false);
        expect(result.plan.topics.some((topic) => /LM Studio/i.test(topic.title))).toBe(true);
        expect(result.summary).not.toMatch(suspiciousOutputPattern);
        expect(result.finalReport).not.toMatch(suspiciousOutputPattern);
        expect(finalReportText).not.toMatch(suspiciousOutputPattern);
        for (const dossierText of dossierTexts) {
          expect(dossierText).not.toMatch(suspiciousOutputPattern);
        }
        expect(finalReportText).toContain("Gemma");
        expect(planText).toMatch(/Ollama|Hugging Face|LM Studio|Gemma/i);
        expect(sourceIndexText).toMatch(/ollama|huggingface|google|lmstudio/i);
      });
    },
    15 * 60_000,
  );
});
