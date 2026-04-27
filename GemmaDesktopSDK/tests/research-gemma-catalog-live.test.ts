import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGemmaDesktop, type ResearchRunStatus } from "@gemma-desktop/sdk-node";
import { withLoadedLiveOllamaModel } from "./helpers/ollama-live.js";

const GEMMA_CATALOG_PROMPT =
  "I'd like you to research all the versions of Gemma models available and report back a summary of the models, types, sources";

const itIfLive = process.env.GEMMA_DESKTOP_RUN_LIVE_RESEARCH === "1" ? it : it.skip;

function resolveConfiguredRuntime(): string {
  return process.env.GEMMA_DESKTOP_RESEARCH_RUNTIME_ID?.trim() || "ollama-native";
}

function resolveConfiguredModel(): string {
  return process.env.GEMMA_DESKTOP_RESEARCH_MODEL_ID?.trim() || "gemma4:31b";
}

describe.sequential("live gemma catalog research", () => {
  itIfLive(
    "runs the exact Gemma catalog scenario end to end and writes inspectable artifacts",
    async () => {
      const runtimeId = resolveConfiguredRuntime();
      const modelId = resolveConfiguredModel();

      expect(
        runtimeId.startsWith("ollama"),
        `Live Ollama research suites only support Ollama runtimes so model cleanup can be enforced. Received "${runtimeId}".`,
      ).toBe(true);

      await withLoadedLiveOllamaModel({ modelId }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-gemma-catalog-"),
        );

        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
        });
        const environment = await gemmaDesktop.inspectEnvironment();
        const runtime = environment.runtimes.find(
          (entry) => entry.runtime.id === runtimeId,
        );
        const model = runtime?.models.find((entry) => entry.id === modelId);

        expect(runtime).toBeDefined();
        expect(model).toBeDefined();

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
          console.log("[live-gemma-catalog] status:", line);
        };

        let result;
        try {
          result = await session.runResearch(GEMMA_CATALOG_PROMPT, {
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
              console.log("[live-gemma-catalog] latestStatus:", latestStatus);
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
        const suspiciousOutputPattern = /<channel\|>|```|(?:^|\W)jsonset(?:\W|$)|\bthought:\s/i;

        console.log("[live-gemma-catalog] runtime:", runtimeId);
        console.log("[live-gemma-catalog] model:", modelId);
        console.log("[live-gemma-catalog] artifactDirectory:", result.artifactDirectory);
        console.log("[live-gemma-catalog] topics:", result.plan.topics.length);
        console.log("[live-gemma-catalog] sources:", result.sources.length);
        console.log("[live-gemma-catalog] summary:", result.summary);
        console.log(
          "[live-gemma-catalog] reportPreview:",
          result.finalReport.slice(0, 600),
        );

        expect(result.plan.topics.length).toBeGreaterThanOrEqual(3);
        expect(result.sources.length).toBeGreaterThanOrEqual(4);
        expect(result.summary.trim().length).toBeGreaterThan(0);
        expect(result.finalReport.trim().length).toBeGreaterThan(0);
        expect(result.summary).not.toMatch(suspiciousOutputPattern);
        expect(result.finalReport).not.toMatch(suspiciousOutputPattern);
        expect(finalReportText).not.toMatch(suspiciousOutputPattern);
        expect(finalReportText).toMatch(/Gemma/i);
        expect(finalReportText).toMatch(/version|type|source|family|download/i);
        expect(planText).toMatch(/Gemma/i);
        expect(planText).toMatch(/version|type|source/i);
        expect(sourceIndexText).toMatch(/deepmind|google|huggingface|ollama|gemma/i);
      });
    },
    20 * 60_000,
  );
});
