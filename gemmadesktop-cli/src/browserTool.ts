import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "@gemma-desktop/sdk-core";
import type { RegisteredTool } from "@gemma-desktop/sdk-tools";

const execFileAsync = promisify(execFile);
const AGENT_BROWSER_PACKAGE = "agent-browser@0.26.0";
const BROWSER_COMMAND_TIMEOUT_MS = 60_000;
const MAX_BROWSER_OUTPUT_CHARS = 24_000;

const BROWSER_ACTIONS = [
  "tabs",
  "open",
  "navigate",
  "wait",
  "snapshot",
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
  const text = snapshot.length > 0 ? snapshot : JSON.stringify(envelope.data ?? {}, null, 2);
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
      const envelope = await runBrowserCommand({
        context,
        args: resolveBrowserArgs(input),
      });
      const fallbackEnvelope = action === "snapshot" && readSnapshotText(envelope.data).length === 0
        ? await runBrowserCommand({
          context,
          args: ["snapshot", "-i"],
        })
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
  resolveBrowserArgs,
};
