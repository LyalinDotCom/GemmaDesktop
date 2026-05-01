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

  it("reads a deterministic page through snapshot and evaluate", async () => {
    const pageHtml = [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head><title>CLI Browser Tool Fixture</title></head>",
      "<body>",
      "<main>",
      "<article>",
      "<h1>Offline CLI Browser Tool Fixture</h1>",
      "<p>Static story body for CLI browser tool regression coverage.</p>",
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
    expect(snapshot.output).toContain("Static story body");

    const evaluated = await execute({
      action: "evaluate",
      function: "() => document.querySelector(\"h1\")?.textContent?.trim()",
    }, "browser-tool-live-evaluate");
    expect(evaluated.output).toContain("Offline CLI Browser Tool Fixture");
  }, 90_000);
});
