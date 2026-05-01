import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "@gemma-desktop/sdk-core";
import type { RegisteredTool } from "@gemma-desktop/sdk-tools";

const execFileAsync = promisify(execFile);
const AGENT_BROWSER_PACKAGE = "agent-browser@0.26.0";
const BROWSER_COMMAND_TIMEOUT_MS = 60_000;
const MAX_BROWSER_OUTPUT_CHARS = 24_000;
const DEFAULT_BROWSER_SCAN_SCROLLS = 3;
const DEFAULT_BROWSER_SCAN_SCROLL_AMOUNT = 900;
const DEFAULT_BROWSER_SCAN_WAIT_MS = 750;
const DEFAULT_BROWSER_SCAN_MAX_STORIES = 80;
const MAX_BROWSER_SCAN_SCROLLS = 8;
const MAX_BROWSER_SCAN_STORIES = 200;

const BROWSER_ACTIONS = [
  "tabs",
  "open",
  "navigate",
  "wait",
  "snapshot",
  "scan_page",
  "links",
  "get_url",
  "get_text",
  "get_attribute",
  "click",
  "fill",
  "type",
  "press",
  "close",
  "evaluate",
] as const;

interface BrowserCliInvocation {
  command: string;
  baseArgs: string[];
}

interface BrowserEnvelope {
  success?: boolean;
  error?: string;
  data?: unknown;
}

let resolvedInvocationPromise: Promise<BrowserCliInvocation> | null = null;

function sanitizeSessionId(sessionId: string): string {
  const normalized = sessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length > 0 ? `gemma-desktop-cli-${normalized}` : "gemma-desktop-cli-session";
}

async function resolveBrowserCliInvocation(): Promise<BrowserCliInvocation> {
  try {
    await execFileAsync("agent-browser", ["--version"], {
      env: { ...process.env, FORCE_COLOR: "0" },
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    });
    return {
      command: "agent-browser",
      baseArgs: [],
    };
  } catch (error) {
    const missing =
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
    return {
      command: "npx",
      baseArgs: ["-y", AGENT_BROWSER_PACKAGE],
    };
  }
}

async function getBrowserCliInvocation(): Promise<BrowserCliInvocation> {
  if (!resolvedInvocationPromise) {
    resolvedInvocationPromise = resolveBrowserCliInvocation().catch((error) => {
      resolvedInvocationPromise = null;
      throw error;
    });
  }
  return await resolvedInvocationPromise;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

function parseEnvelope(text: string): BrowserEnvelope {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Managed browser returned no output.");
  }
  return JSON.parse(trimmed) as BrowserEnvelope;
}

async function runBrowserCommand(input: {
  context: ToolExecutionContext;
  args: string[];
}): Promise<BrowserEnvelope> {
  const invocation = await getBrowserCliInvocation();
  const commandArgs = [
    ...invocation.baseArgs,
    "--session",
    sanitizeSessionId(input.context.sessionId),
    "--json",
    ...input.args,
  ];

  try {
    const result = await execFileAsync(invocation.command, commandArgs, {
      env: { ...process.env, FORCE_COLOR: "0" },
      timeout: BROWSER_COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal: input.context.signal,
    });
    const envelope = parseEnvelope(result.stdout || result.stderr);
    if (envelope.success === false) {
      throw new Error(envelope.error ?? "Managed browser command failed.");
    }
    return envelope;
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    const raw = [execError.stdout, execError.stderr].find((entry) => entry && entry.trim().length > 0);
    if (raw) {
      try {
        const envelope = parseEnvelope(raw);
        throw new Error(envelope.error ?? raw.trim());
      } catch (parseError) {
        throw new Error(extractErrorMessage(parseError));
      }
    }
    throw new Error(extractErrorMessage(error));
  }
}

function requireString(record: Record<string, unknown>, key: string, action: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Browser action "${action}" requires ${key}.`);
  }
  return value.trim();
}

function normalizeRef(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readSnapshotText(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  const snapshot = (data as Record<string, unknown>).snapshot;
  return typeof snapshot === "string" ? snapshot.trim() : "";
}

function normalizeEvaluateArgs(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isBareEvaluateFunction(source: string): boolean {
  return /^(?:async\s+)?(?:\([^()]*\)|[$A-Z_a-z][$\w]*)\s*=>/s.test(source)
    || /^(?:async\s+)?function(?:\s+[$A-Z_a-z][$\w]*)?\s*\(/s.test(source);
}

function buildEvaluateScript(functionSource: string, args: unknown): string {
  const trimmed = functionSource.trim();
  if (!isBareEvaluateFunction(trimmed)) {
    return trimmed;
  }

  return `(${trimmed})(...${JSON.stringify(normalizeEvaluateArgs(args))})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeStoryText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeStoryHref(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStoryKey(story: { text: string; href?: string }): string {
  return story.href ?? story.text.toLowerCase();
}

function buildExtractLinksScript(input: Record<string, unknown>): string {
  const textIncludes = optionalString(input, "textIncludes")?.toLowerCase() ?? "";
  const maxResults = Math.min(optionalPositiveInteger(input, "maxResults", 100), 250);
  return `(() => {
  const needle = ${JSON.stringify(textIncludes)};
  return Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => {
      const text = (anchor.innerText || anchor.textContent || "").replace(/\\s+/g, " ").trim();
      const rawHref = anchor.getAttribute("href") || "";
      let href = rawHref;
      try {
        href = new URL(rawHref, document.baseURI).href;
      } catch {
        href = rawHref;
      }
      return { text, href };
    })
    .filter((link) => link.href && (!needle || (link.text + " " + link.href).toLowerCase().includes(needle)))
    .slice(0, ${maxResults});
})()`;
}

const SCAN_PAGE_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const documentHeight = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0
  );
  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => {
      const rect = anchor.getBoundingClientRect();
      const visible =
        rect.bottom > 0
        && rect.top < viewportHeight
        && rect.right > 0
        && rect.left < viewportWidth;
      const imageAlt = anchor.querySelector("img")?.getAttribute("alt") || "";
      const text = normalize(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || imageAlt);
      const rawHref = anchor.getAttribute("href") || "";
      let href = rawHref;
      try {
        href = new URL(rawHref, document.baseURI).href;
      } catch {
        href = rawHref;
      }
      return {
        text,
        href,
        visible,
        top: Math.round(rect.top + window.scrollY),
        viewportTop: Math.round(rect.top),
        area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
      };
    })
    .filter((link) => link.visible && link.href && link.text.length >= 24)
    .sort((a, b) => a.viewportTop - b.viewportTop || b.area - a.area)
    .slice(0, 120);

  return {
    url: window.location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    viewportHeight,
    documentHeight,
    links,
  };
})()`;

interface BrowserScanStory {
  text: string;
  href?: string;
  firstSeenStep: number;
  sightings: number;
}

interface BrowserScanStepSummary {
  index: number;
  scrollY?: number;
  viewportHeight?: number;
  documentHeight?: number;
  screenshotPath?: string;
  storyCount: number;
  newStoryCount: number;
  errors?: string[];
}

function resolveScanPageOptions(input: Record<string, unknown>): {
  scrolls: number;
  scrollAmount: number;
  waitMs: number;
  maxStories: number;
  captureScreenshots: boolean;
} {
  return {
    scrolls: clampInteger(input.scrolls, DEFAULT_BROWSER_SCAN_SCROLLS, 0, MAX_BROWSER_SCAN_SCROLLS),
    scrollAmount: clampInteger(input.scrollAmount, DEFAULT_BROWSER_SCAN_SCROLL_AMOUNT, 100, 3000),
    waitMs: clampInteger(input.waitMs, DEFAULT_BROWSER_SCAN_WAIT_MS, 0, 5000),
    maxStories: clampInteger(input.maxStories, DEFAULT_BROWSER_SCAN_MAX_STORIES, 1, MAX_BROWSER_SCAN_STORIES),
    captureScreenshots: input.captureScreenshots !== false,
  };
}

function readScanEvalResult(data: unknown): {
  scrollY?: number;
  viewportHeight?: number;
  documentHeight?: number;
  links: Array<{ text: string; href?: string }>;
} {
  if (!isRecord(data) || !isRecord(data.result)) {
    return { links: [] };
  }

  const links = Array.isArray(data.result.links)
    ? data.result.links
      .filter(isRecord)
      .map((link) => ({
        text: normalizeStoryText(link.text),
        href: normalizeStoryHref(link.href),
      }))
      .filter((link) => link.text.length > 0)
    : [];

  return {
    scrollY: readNumber(data.result.scrollY),
    viewportHeight: readNumber(data.result.viewportHeight),
    documentHeight: readNumber(data.result.documentHeight),
    links,
  };
}

async function captureScanStep(input: {
  runCommand: (args: string[]) => Promise<BrowserEnvelope>;
  stepIndex: number;
  captureScreenshots: boolean;
  seenStories: Map<string, BrowserScanStory>;
  maxStories: number;
}): Promise<BrowserScanStepSummary> {
  const errors: string[] = [];
  let screenshotPath: string | undefined;

  if (input.captureScreenshots) {
    try {
      const screenshot = await input.runCommand(["screenshot"]);
      if (isRecord(screenshot.data)) {
        screenshotPath = normalizeStoryHref(screenshot.data.path);
      }
    } catch (error) {
      errors.push(`screenshot: ${extractErrorMessage(error)}`);
    }
  }

  let scan = { links: [] } as ReturnType<typeof readScanEvalResult>;
  try {
    const evaluated = await input.runCommand(["eval", SCAN_PAGE_SCRIPT]);
    scan = readScanEvalResult(evaluated.data);
  } catch (error) {
    errors.push(`extract: ${extractErrorMessage(error)}`);
  }

  let newStoryCount = 0;
  for (const link of scan.links) {
    if (input.seenStories.size >= input.maxStories) {
      break;
    }
    const key = getStoryKey(link);
    const existing = input.seenStories.get(key);
    if (existing) {
      existing.sightings += 1;
      continue;
    }
    input.seenStories.set(key, {
      text: link.text,
      href: link.href,
      firstSeenStep: input.stepIndex,
      sightings: 1,
    });
    newStoryCount += 1;
  }

  return {
    index: input.stepIndex,
    scrollY: scan.scrollY,
    viewportHeight: scan.viewportHeight,
    documentHeight: scan.documentHeight,
    screenshotPath,
    storyCount: scan.links.length,
    newStoryCount,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function formatScanPageOutput(input: {
  steps: BrowserScanStepSummary[];
  stories: BrowserScanStory[];
  scrolls: number;
  scrollAmount: number;
  waitMs: number;
}): string {
  const screenshotCount = input.steps.filter((step) => step.screenshotPath).length;
  const firstViewportStoryCount = input.steps[0]?.newStoryCount ?? 0;
  const addedAfterFirstViewport = Math.max(0, input.stories.length - firstViewportStoryCount);
  const lines = [
    `Scanned ${input.steps.length} viewport${input.steps.length === 1 ? "" : "s"} (${input.scrolls} requested scroll${input.scrolls === 1 ? "" : "s"}, ${input.scrollAmount}px each, ${input.waitMs}ms wait).`,
    `Captured ${screenshotCount} screenshot${screenshotCount === 1 ? "" : "s"}.`,
    `Found ${input.stories.length} unique story link${input.stories.length === 1 ? "" : "s"}; first viewport had ${firstViewportStoryCount}, scrolling added ${addedAfterFirstViewport}.`,
  ];

  const warnings = input.steps
    .filter((step) => step.errors && step.errors.length > 0)
    .map((step) => `Step ${step.index}: ${step.errors?.join("; ")}`);
  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }

  const screenshotLines = input.steps
    .filter((step) => step.screenshotPath)
    .map((step) => `- Step ${step.index}: ${step.screenshotPath}`);
  if (screenshotLines.length > 0) {
    lines.push("", "Screenshots:", ...screenshotLines);
  }

  if (input.stories.length > 0) {
    lines.push(
      "",
      "Story links:",
      ...input.stories.slice(0, 40).map((story, index) =>
        `${index + 1}. ${story.text}${story.href ? ` — ${story.href}` : ""} (first seen step ${story.firstSeenStep})`,
      ),
    );
  }

  return lines.join("\n");
}

async function runBrowserPageScan(input: {
  args: Record<string, unknown>;
  runCommand: (args: string[]) => Promise<BrowserEnvelope>;
}): Promise<BrowserEnvelope> {
  const options = resolveScanPageOptions(input.args);
  const seenStories = new Map<string, BrowserScanStory>();
  const steps: BrowserScanStepSummary[] = [];

  for (let stepIndex = 0; stepIndex <= options.scrolls; stepIndex += 1) {
    const stepErrors: string[] = [];
    if (stepIndex > 0) {
      try {
        await input.runCommand(["scroll", "down", String(options.scrollAmount)]);
      } catch (error) {
        stepErrors.push(`scroll: ${extractErrorMessage(error)}`);
      }

      if (options.waitMs > 0) {
        try {
          await input.runCommand(["wait", String(options.waitMs)]);
        } catch (error) {
          stepErrors.push(`wait: ${extractErrorMessage(error)}`);
        }
      }
    }

    const step = await captureScanStep({
      runCommand: input.runCommand,
      stepIndex,
      captureScreenshots: options.captureScreenshots,
      seenStories,
      maxStories: options.maxStories,
    });
    steps.push({
      ...step,
      ...(stepErrors.length > 0 || step.errors
        ? { errors: [...stepErrors, ...(step.errors ?? [])] }
        : {}),
    });
  }

  const stories = [...seenStories.values()];
  const firstViewportStoryCount = steps[0]?.newStoryCount ?? 0;
  return {
    success: true,
    data: {
      scanText: formatScanPageOutput({
        steps,
        stories,
        scrolls: options.scrolls,
        scrollAmount: options.scrollAmount,
        waitMs: options.waitMs,
      }),
      scrolls: options.scrolls,
      scrollAmount: options.scrollAmount,
      waitMs: options.waitMs,
      captureScreenshots: options.captureScreenshots,
      screenshotCount: steps.filter((step) => step.screenshotPath).length,
      firstViewportStoryCount,
      uniqueStoryCount: stories.length,
      addedAfterFirstViewport: Math.max(0, stories.length - firstViewportStoryCount),
      steps,
      stories,
    },
  };
}

function resolveBrowserArgs(input: Record<string, unknown>): string[] {
  const action = requireString(input, "action", "browser");
  switch (action) {
    case "tabs":
      return ["tab"];
    case "open":
      return ["tab", "new", requireString(input, "url", action)];
    case "navigate": {
      const navigation = typeof input.navigation === "string" && input.navigation.trim().length > 0
        ? input.navigation.trim()
        : typeof input.url === "string" && input.url.trim().length > 0
          ? "url"
          : "";
      if (navigation === "url") {
        return ["open", requireString(input, "url", action)];
      }
      if (navigation === "back" || navigation === "forward" || navigation === "reload") {
        return [navigation];
      }
      throw new Error('Browser action "navigate" requires navigation or url.');
    }
    case "wait": {
      if (typeof input.waitMs === "number" && Number.isFinite(input.waitMs) && input.waitMs > 0) {
        return ["wait", String(Math.floor(input.waitMs))];
      }
      if (typeof input.waitForLoadState === "string" && input.waitForLoadState.trim().length > 0) {
        return ["wait", "--load", input.waitForLoadState.trim()];
      }
      if (Array.isArray(input.waitForText) && input.waitForText.length > 0) {
        const values = input.waitForText.filter((entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
        );
        if (values.length === 1) {
          return ["wait", "--text", values[0]];
        }
        const expression = `(() => {
  const text = document.body?.innerText ?? "";
  return ${JSON.stringify(values)}.some((needle) => text.includes(needle));
})()`;
        return ["wait", "--fn", expression];
      }
      throw new Error('Browser action "wait" requires waitForText, waitForLoadState, or waitMs.');
    }
    case "snapshot":
      return ["snapshot"];
    case "scan_page":
      return ["scan_page"];
    case "links":
      return ["eval", buildExtractLinksScript(input)];
    case "get_url":
      return ["get", "url"];
    case "get_text": {
      const ref = optionalString(input, "ref");
      return ref ? ["get", "text", normalizeRef(ref)] : ["get", "text"];
    }
    case "get_attribute":
      return [
        "get",
        "attr",
        requireString(input, "attribute", action),
        normalizeRef(requireString(input, "ref", action)),
      ];
    case "click":
      return ["click", normalizeRef(requireString(input, "ref", action))];
    case "fill":
      return ["fill", normalizeRef(requireString(input, "ref", action)), requireString(input, "value", action)];
    case "type": {
      const text = requireString(input, "inputText", action);
      if (typeof input.ref === "string" && input.ref.trim().length > 0) {
        return ["type", normalizeRef(input.ref), text];
      }
      return ["keyboard", "type", text];
    }
    case "press":
      return ["press", requireString(input, "key", action)];
    case "close":
      return ["tab", "close", requireString(input, "tabId", action)];
    case "evaluate":
      return ["eval", buildEvaluateScript(requireString(input, "function", action), input.args)];
    default:
      throw new Error(`Unsupported browser action "${action}".`);
  }
}

function formatBrowserOutput(action: string, envelope: BrowserEnvelope): string {
  const data = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {};
  const snapshot = typeof data.snapshot === "string" ? data.snapshot.trim() : "";
  const scanText = typeof data.scanText === "string" ? data.scanText.trim() : "";
  const text = scanText.length > 0
    ? scanText
    : snapshot.length > 0
      ? snapshot
      : JSON.stringify(envelope.data ?? {}, null, 2);
  const trimmed = text.length > MAX_BROWSER_OUTPUT_CHARS
    ? `${text.slice(0, MAX_BROWSER_OUTPUT_CHARS).trimEnd()}\n\n[...TRUNCATED]`
    : text;
  return [`Browser action "${action}" completed.`, trimmed].filter(Boolean).join("\n\n");
}

export function createCliBrowserTool(): RegisteredTool<Record<string, unknown>> {
  return {
    name: "browser",
    description: [
      "Direct tool. Use a managed browser session for live or dynamic sites that need real page interaction.",
      "Open pages, inspect tabs, capture snapshots, wait, click refs, fill forms, type, press keys, navigate, close tabs, or evaluate page scripts.",
      "Use scan_page for news homepages, feeds, and long pages where scrolling plus multiple screenshots can reveal more stories than the first viewport.",
      "Use links to extract visible anchor text and absolute hrefs when the user asks for page links.",
      "Use browser instead of fetch_url for forms, tabs, search boxes, and JavaScript-heavy pages.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BROWSER_ACTIONS],
        },
        tabId: { type: "string" },
        url: { type: "string" },
        navigation: {
          type: "string",
          enum: ["url", "back", "forward", "reload"],
        },
        waitForText: {
          type: "array",
          items: { type: "string" },
        },
        waitForLoadState: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
        },
        waitMs: { type: "number" },
        maxChars: { type: "number" },
        maxResults: { type: "number" },
        scrolls: { type: "number" },
        scrollAmount: { type: "number" },
        maxStories: { type: "number" },
        captureScreenshots: { type: "boolean" },
        ref: { type: "string" },
        attribute: { type: "string" },
        textIncludes: { type: "string" },
        value: { type: "string" },
        inputText: { type: "string" },
        key: { type: "string" },
        function: { type: "string" },
        args: {
          type: "array",
          items: {},
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const action = requireString(input, "action", "browser");
      const runCommand = async (args: string[]) =>
        await runBrowserCommand({
          context,
          args,
        });
      const envelope = action === "scan_page"
        ? await runBrowserPageScan({ args: input, runCommand })
        : await runCommand(resolveBrowserArgs(input));
      const fallbackEnvelope = action === "snapshot" && readSnapshotText(envelope.data).length === 0
        ? await runCommand(["snapshot", "-i"])
        : null;
      const outputEnvelope =
        fallbackEnvelope && readSnapshotText(fallbackEnvelope.data).length > 0
          ? fallbackEnvelope
          : envelope;
      return {
        output: formatBrowserOutput(action, outputEnvelope),
        structuredOutput: {
          action,
          data: outputEnvelope.data,
        },
      };
    },
  };
}

export const __testing = {
  buildEvaluateScript,
  formatBrowserOutput,
  readSnapshotText,
  runBrowserPageScan,
  resolveBrowserArgs,
};
