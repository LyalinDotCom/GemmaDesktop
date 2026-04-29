import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import {
  isOllamaLiveEnabled,
  withLoadedLiveOllamaModel,
} from "./helpers/ollama-live.js";

const itIfLive = isOllamaLiveEnabled() ? it : it.skip;

function resolveConfiguredModel(): string {
  return process.env.GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID?.trim() || "gemma4:26b";
}

describe.sequential("ollama live tool routing", () => {
  itIfLive(
    "executes fetch_url end to end in a direct-tool-only turn",
    async () => {
      const modelId = resolveConfiguredModel();

      await withLoadedLiveOllamaModel({ modelId }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-direct-tool-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: "ollama-native",
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
    3 * 60_000,
  );

  itIfLive(
    "prefers fetch_url over web_research_agent for one known page in cowork mode",
    async () => {
      const modelId = resolveConfiguredModel();

      await withLoadedLiveOllamaModel({ modelId }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-cowork-routing-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: "ollama-native",
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
    3 * 60_000,
  );

  itIfLive(
    "completes the MSNBC Fox News CNN comparison prompt through web_research_agent",
    async () => {
      const modelId = resolveConfiguredModel();

      await withLoadedLiveOllamaModel({ modelId }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), "gemma-desktop-live-ollama-web-research-"),
        );
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
        });
        const session = await gemmaDesktop.sessions.create({
          runtime: "ollama-native",
          model: modelId,
          mode: {
            base: "cowork",
            tools: ["web_research_agent"],
            withoutTools: ["search_web", "fetch_url", "fetch_url_safe"],
          },
          workingDirectory,
          maxSteps: 4,
        });

        const prompt =
          "Identify the latest top stories and main headlines from MSNBC, Fox News, and CNN. Compare the coverage to determine which stories are being broadly covered across all three and identify any notable differences in focus, framing, or specific stories emphasized by individual networks.";

        const result = await session.run(prompt, {
          maxSteps: 4,
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
        expect(toolResult?.metadata?.toolError).not.toBe(true);
        expect(structuredOutput?.summary ?? toolResult?.output ?? "").toMatch(/CNN|Fox|MSNBC/i);
        expect(structuredOutput?.sources?.length ?? 0).toBeGreaterThan(0);
        expect(result.text).toMatch(/CNN|Fox|MSNBC/i);
        expect(childTrace).toContain("search_web");
        expect(childTrace).toMatch(/fetch_url_safe|Fetched pages:/);
      });
    },
    4 * 60_000,
  );
});
