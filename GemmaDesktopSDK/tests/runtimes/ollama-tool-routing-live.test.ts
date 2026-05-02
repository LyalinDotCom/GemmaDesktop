import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import {
  createLiveRuntimeAdapters,
  isOllamaLiveEnabled,
  withLiveRuntimeModel,
} from "../helpers/ollama-live.js";

const itIfLive = isOllamaLiveEnabled() ? it : it.skip;
const DIRECT_TOOL_LIVE_TIMEOUT_MS =
  Number(process.env.GEMMA_DESKTOP_TOOL_ROUTING_DIRECT_TIMEOUT_MS?.trim() || "")
  || 10 * 60_000;
const WEB_RESEARCH_LIVE_TIMEOUT_MS =
  Number(process.env.GEMMA_DESKTOP_TOOL_ROUTING_WEB_RESEARCH_TIMEOUT_MS?.trim() || "")
  || 10 * 60_000;

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
    "GEMMA_DESKTOP_TOOL_ROUTING_RUNTIME_ID",
    "GEMMA_DESKTOP_LIVE_RUNTIME_ID",
  ) ?? "ollama-native";
}

function resolveConfiguredModel(): string {
  return configuredEnvValue(
    "GEMMA_DESKTOP_TOOL_ROUTING_MODEL_ID",
    "GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID",
    "GEMMA_DESKTOP_LIVE_MODEL_ID",
  ) ?? "gemma4:31b";
}

describe("live tool routing configuration", () => {
  it("defaults to the 31B Gemma model for live acceptance coverage", () => {
    const saved = {
      GEMMA_DESKTOP_TOOL_ROUTING_MODEL_ID: process.env.GEMMA_DESKTOP_TOOL_ROUTING_MODEL_ID,
      GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID: process.env.GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID,
      GEMMA_DESKTOP_LIVE_MODEL_ID: process.env.GEMMA_DESKTOP_LIVE_MODEL_ID,
    };
    delete process.env.GEMMA_DESKTOP_TOOL_ROUTING_MODEL_ID;
    delete process.env.GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID;
    delete process.env.GEMMA_DESKTOP_LIVE_MODEL_ID;

    try {
      expect(resolveConfiguredModel()).toBe("gemma4:31b");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe.sequential("live tool routing", () => {
  itIfLive(
    "executes fetch_url end to end in a direct-tool-only turn",
    async () => {
      const runtimeId = resolveConfiguredRuntime();
      const modelId = resolveConfiguredModel();
      const adapters = createLiveRuntimeAdapters();

      await withLiveRuntimeModel({ runtimeId, modelId, adapters }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-direct-tool-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
          adapters,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: runtimeId,
          model: modelId,
          mode: {
            base: "minimal",
            tools: ["fetch_url"],
          },
          workingDirectory,
          maxSteps: 3,
        });

        const result = await session.run(
          "Fetch https://news.ycombinator.com and summarize the first five front-page stories. Use the available tool before answering.",
          {
            maxSteps: 3,
          },
        );

        expect(result.toolResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolName: "fetch_url",
            }),
          ]),
        );

        const fetchResult = result.toolResults.find(
          (toolResult) => toolResult.toolName === "fetch_url",
        );
        const structuredOutput = fetchResult?.structuredOutput as
          | { resolvedUrl?: string; headlines?: unknown[]; content?: string }
          | undefined;

        expect(structuredOutput?.resolvedUrl ?? "").toContain(
          "news.ycombinator.com",
        );
        expect(
          Array.isArray(structuredOutput?.headlines)
            ? structuredOutput?.headlines.length
            : 0,
        ).toBeGreaterThan(0);
        expect(result.text).toMatch(
          /Hacker News|news\.ycombinator\.com|headline|story/i,
        );
        expect(
          result.toolResults.some((toolResult) => toolResult.toolName.endsWith("_agent")),
        ).toBe(false);
      });
    },
    DIRECT_TOOL_LIVE_TIMEOUT_MS,
  );

  itIfLive(
    "prefers fetch_url over web_research_agent for one known page in cowork mode",
    async () => {
      const runtimeId = resolveConfiguredRuntime();
      const modelId = resolveConfiguredModel();
      const adapters = createLiveRuntimeAdapters();

      await withLiveRuntimeModel({ runtimeId, modelId, adapters }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-cowork-routing-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
          adapters,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: runtimeId,
          model: modelId,
          mode: "cowork",
          workingDirectory,
          maxSteps: 4,
        });

        const result = await session.run(
          "Hacker News is the front page at https://news.ycombinator.com/. Please fetch that page and summarize the first five latest story titles.",
          {
            maxSteps: 4,
          },
        );

        expect(
          result.toolResults.some((toolResult) => toolResult.toolName === "fetch_url"),
        ).toBe(true);
        expect(
          result.toolResults.some(
            (toolResult) => toolResult.toolName === "web_research_agent",
          ),
        ).toBe(false);
        expect(result.text).toMatch(/Hacker News|story|headline/i);
      });
    },
    DIRECT_TOOL_LIVE_TIMEOUT_MS,
  );

  itIfLive(
    "completes the MSNBC Fox News CNN comparison prompt through web_research_agent",
    async () => {
      const runtimeId = resolveConfiguredRuntime();
      const modelId = resolveConfiguredModel();
      const adapters = createLiveRuntimeAdapters();

      await withLiveRuntimeModel({ runtimeId, modelId, adapters }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-web-research-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
          adapters,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: runtimeId,
          model: modelId,
          mode: {
            base: "cowork",
            tools: ["web_research_agent"],
            withoutTools: ["search_web", "fetch_url", "fetch_url_safe"],
          },
          workingDirectory,
          maxSteps: 6,
        });

        const prompt =
          "Use web_research_agent once to fetch https://www.cnn.com/, https://www.foxnews.com/, and https://www.msnbc.com/. Return one current headline or lead topic from each source, then a one-sentence comparison. Do not do open-ended searching beyond those three direct outlet pages unless a direct fetch fails.";

        const result = await session.run(prompt, {
          maxSteps: 6,
        });

        const toolResult = result.toolResults.find(
          (candidate) => candidate.toolName === "web_research_agent",
        );
        const childTrace =
          typeof toolResult?.metadata?.childTrace === "string"
            ? toolResult.metadata.childTrace
            : "";
        const structuredOutput =
          toolResult?.structuredOutput && typeof toolResult.structuredOutput === "object"
            ? toolResult.structuredOutput as { summary?: string; sources?: string[]; error?: string }
            : undefined;

        expect(toolResult).toBeDefined();
        if (toolResult?.metadata?.toolError === true) {
          console.log(
            "[live-tool-routing] web_research_agent failure:",
            JSON.stringify({
              output: toolResult.output,
              structuredOutput,
              metadata: toolResult.metadata,
              childTrace: childTrace.slice(0, 4_000),
            }, null, 2),
          );
        }
        expect(toolResult?.metadata?.toolError).not.toBe(true);
        expect(structuredOutput?.summary ?? toolResult?.output ?? "").toMatch(/CNN|Fox|MSNBC/i);
        expect(structuredOutput?.sources?.length ?? 0).toBeGreaterThan(0);
        expect(result.text).toMatch(/CNN|Fox|MSNBC/i);
        expect(childTrace).toContain("search_web");
        expect(childTrace).toMatch(/fetch_url_safe|Fetched pages:/);
      });
    },
    WEB_RESEARCH_LIVE_TIMEOUT_MS,
  );
});
