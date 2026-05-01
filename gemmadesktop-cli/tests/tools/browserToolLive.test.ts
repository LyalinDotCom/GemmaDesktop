import { afterAll, describe, expect, it } from "vitest";
import type { ToolExecutionContext, ToolResult } from "@gemma-desktop/sdk-core";
import { createCliBrowserTool } from "../../src/browserTool.js";

const runLiveBrowser = process.env.GEMMA_DESKTOP_RUN_BROWSER_TOOL_LIVE === "1";
const describeLive = runLiveBrowser ? describe : describe.skip;
type BrowserToolResult = Omit<ToolResult, "callId" | "toolName">;

function createContext(sessionId: string, toolCallId: string): ToolExecutionContext {
  return {
    sessionId,
    turnId: "browser-tool-live-turn",
    toolCallId,
    mode: "build",
    workingDirectory: process.cwd(),
  };
}

function readTabs(result: BrowserToolResult): Array<{ tabId?: string; active?: boolean }> {
  const structured = result.structuredOutput;
  if (!structured || typeof structured !== "object" || !("data" in structured)) {
    return [];
  }
  const data = structured.data;
  if (!data || typeof data !== "object" || !("tabs" in data) || !Array.isArray(data.tabs)) {
    return [];
  }
  return data.tabs as Array<{ tabId?: string; active?: boolean }>;
}

function readStructuredData(result: BrowserToolResult): Record<string, unknown> {
  const structured = result.structuredOutput;
  if (!structured || typeof structured !== "object" || !("data" in structured)) {
    return {};
  }
  return structured.data && typeof structured.data === "object" && !Array.isArray(structured.data)
    ? structured.data as Record<string, unknown>
    : {};
}

describeLive("CLI browser tool live validation", () => {
  const sessionId = `browser-tool-live-${Date.now()}`;
  const browserTool = createCliBrowserTool();

  async function execute(input: Record<string, unknown>, toolCallId: string): Promise<BrowserToolResult> {
    return await browserTool.execute(input, createContext(sessionId, toolCallId));
  }

  afterAll(async () => {
    const tabs = await execute({ action: "tabs" }, "browser-tool-live-tabs").catch(() => null);
    const activeTabId = tabs
      ? readTabs(tabs).find((tab) => tab.active)?.tabId
      : undefined;
    if (activeTabId) {
      await execute({ action: "close", tabId: activeTabId }, "browser-tool-live-close")
        .catch(() => undefined);
    }
  });

  it("reads a deterministic news page through snapshot, evaluate, and scan screenshots", async () => {
    const pageHtml = [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head><title>CLI Browser Tool Fixture</title></head>",
      "<style>",
      "body{margin:0;font-family:Arial,sans-serif;}",
      ".story{min-height:820px;display:flex;align-items:center;padding:40px;border-bottom:1px solid #ddd;}",
      "a{font-size:32px;line-height:1.2;color:#111;}",
      "</style>",
      "<body>",
      "<main>",
      "<article class=\"story\">",
      "<h1>Offline CLI Browser Tool Fixture</h1>",
      "<a href=\"https://www.cnn.com/2026/05/01/world/cli-fixture-story-one\">CNN CLI Fixture Story One: Opening headline visible in the first viewport</a>",
      "</article>",
      "<article class=\"story\">",
      "<a href=\"https://www.cnn.com/2026/05/01/world/cli-fixture-story-two\">CNN CLI Fixture Story Two: Follow-up headline after one scroll</a>",
      "</article>",
      "<article class=\"story\">",
      "<a href=\"https://www.cnn.com/2026/05/01/world/cli-fixture-story-three\">CNN CLI Fixture Story Three: Deeper headline after two scrolls</a>",
      "</article>",
      "<article class=\"story\">",
      "<a href=\"https://www.cnn.com/2026/05/01/world/cli-fixture-story-four\">CNN CLI Fixture Story Four: Lower-page headline after three scrolls</a>",
      "</article>",
      "</main>",
      "</body>",
      "</html>",
    ].join("");
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

    await execute({ action: "open", url }, "browser-tool-live-open");

    const snapshot = await execute({
      action: "snapshot",
    }, "browser-tool-live-snapshot");
    expect(snapshot.output).toContain("Offline CLI Browser Tool Fixture");
    expect(snapshot.output).toContain("CNN CLI Fixture Story One");

    const evaluated = await execute({
      action: "evaluate",
      function: "() => document.querySelector(\"h1\")?.textContent?.trim()",
    }, "browser-tool-live-evaluate");
    expect(evaluated.output).toContain("Offline CLI Browser Tool Fixture");

    const scan = await execute({
      action: "scan_page",
      scrolls: 3,
      waitMs: 100,
    }, "browser-tool-live-scan");
    const scanData = readStructuredData(scan);
    expect(scan.output).toContain("CNN CLI Fixture Story One");
    expect(scan.output).toContain("CNN CLI Fixture Story Four");
    expect(Number(scanData.screenshotCount)).toBeGreaterThanOrEqual(4);
    expect(Number(scanData.firstViewportStoryCount)).toBeLessThan(Number(scanData.uniqueStoryCount));
  }, 90_000);
});
