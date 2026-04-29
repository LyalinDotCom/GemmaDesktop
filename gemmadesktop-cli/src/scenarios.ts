import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  runShellCommand,
  type GemmaDesktopEvent,
  type RuntimeDebugEvent,
  type SessionInput,
  type SessionSnapshot,
  type SessionTurnOptions,
  type StreamedTurnResult,
  type ToolResult,
  type TurnResult,
} from "@gemma-desktop/sdk-core";
import type { CreateSessionOptions } from "@gemma-desktop/sdk-node";
import type { ScenarioCliOptions } from "./args.js";
import { buildDesktopParitySessionMetadata } from "./metadata.js";

const execFileAsync = promisify(execFile);

interface WritableTextStream {
  write(chunk: string): unknown;
}

interface ScenarioSession {
  id: string;
  runStreamed(input: SessionInput, options?: SessionTurnOptions): Promise<StreamedTurnResult>;
  snapshot(): SessionSnapshot;
}

export interface ScenarioDesktopLike {
  sessions: {
    create(options: CreateSessionOptions): Promise<ScenarioSession>;
  };
}

export interface ScenarioRuntimeLike {
  signal?: AbortSignal;
  stderr: WritableTextStream;
}

interface ScenarioTurnRecord {
  index: number;
  prompt: string;
  turnId?: string;
  text?: string;
  steps?: number;
  warnings?: string[];
  toolNames?: string[];
  build?: TurnResult["build"];
  eventCounts?: Record<string, number>;
  error?: string;
}

interface ScenarioEvaluation {
  success: boolean;
  score: number;
  checks: Record<string, boolean>;
  issues: string[];
  validationCommand?: {
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  };
}

export interface ScenarioRunResult {
  scenarioId: ScenarioCliOptions["scenarioId"];
  sessionId?: string;
  workingDirectory: string;
  artifactDirectory: string;
  turns: ScenarioTurnRecord[];
  evaluation: ScenarioEvaluation;
}

const BLACK_HOLE_SCENARIO_PROMPTS = [
  "Build a black hole simulator in a folder called black as a basic npm website. Use npm, create package.json scripts, and include a real build or validate script that fails if required files are missing. Validate the site with npm, then call finalize_build immediately.",
  "Add UI controls for mass, accretion speed, and gravitational lensing intensity. Keep the app as a black hole simulator, validate it again with npm, then call finalize_build immediately.",
  "Add pause/reset controls and a live stats or readout panel. Keep the implementation in the black folder, validate it again with npm, then call finalize_build immediately.",
  "Improve responsive visual polish for the black hole simulator without changing topics. Validate the npm website one final time, then call finalize_build immediately.",
] as const;

const PDF_ATTENTION_PROMPTS = [
  [
    "Run this as a headless CLI acceptance scenario.",
    "Find the paper PDF for \"Attention Is All You Need\". Prefer local files under /Users/dmitrylyalin/Source/Testing and /Users/dmitrylyalin/Source/Reference_Projects before using the web.",
    "Use exec_command for absolute-path file discovery if needed.",
    "If you cannot find a local copy, download the canonical arXiv PDF URL https://arxiv.org/pdf/1706.03762 into .gemma-headless/pdf-attention/attention-is-all-you-need.pdf first.",
    "Use extract_pdf_text for PDF text extraction once you have a local PDF path.",
    "Extract the full embedded text from the PDF into .gemma-headless/pdf-attention/attention-is-all-you-need.txt under the working directory.",
    "Then answer with the exact paper title, the source path or URL you used, and every author listed on the paper.",
    "This is a tool-use test: do not guess the authors from memory; validate them from extracted PDF text.",
  ].join(" "),
] as const;

const HACKER_NEWS_PROMPTS = [
  [
    "Fetch https://news.ycombinator.com/ using the headless web tools.",
    "Report a current Hacker News update with the top five visible front-page items and include any points or comment counts that are available.",
    "Include the source URL and make clear if any metadata was unavailable.",
  ].join(" "),
] as const;

const NEWS_COVERAGE_PROMPTS = [
  [
    "Get the latest major news coverage from CNN, Fox News, and MSNBC today.",
    "Use fetch_url directly on https://www.cnn.com/, https://www.foxnews.com/, and https://www.msnbc.com/ for this scenario; do not use search_web unless direct fetching fails.",
    "Compare what each outlet is emphasizing, what overlaps, and what differs.",
    "Return a compact comparison with source URLs for CNN, Fox News, and MSNBC. Do not substitute third-party aggregators unless direct outlet access fails, and say so if it does.",
  ].join(" "),
] as const;

const REST_IS_HISTORY_LYNDON_PROMPTS = [
  [
    "Run this as a headless CLI managed-browser acceptance scenario.",
    "Use the browser tool for the website interaction; do not solve this with fetch_url, search_web, or web_research_agent.",
    "Open https://therestishistory.com/ in the browser.",
    "Navigate to the Episodes tab or Episodes archive from the site UI.",
    "Find the episode search box, search for \"lyndon\", and return the names and absolute links for all matching episodes visible after the search.",
    "If the site blocks automation, report that exact blocker instead of substituting generic search results.",
  ].join(" "),
] as const;

const GEMMA4_RESEARCH_PROMPTS = [
  [
    "Run a research-style headless check for the latest Gemma 4 model availability details.",
    "Use fetch_url directly on https://ollama.com/library/gemma4 and https://ai.google.dev/gemma/docs. Also use exec_command to inspect local Ollama availability with `ollama list | grep gemma4`.",
    "Find what Gemma 4 versions are available, including 26B and 31B if current sources support them, and summarize model sizes, sources, runtimes, and availability.",
    "Use current web sources and include the URLs you relied on. Distinguish official source information from runtime catalog information such as Ollama availability.",
  ].join(" "),
] as const;

const IMAGE_READING_PROMPTS = [
  (context: ScenarioFixtureContext): SessionInput => [
    {
      type: "text",
      text: [
        "Run this as a headless CLI multimodal acceptance scenario.",
        "Read the attached image directly. Return the visible project code, numeric total, and status.",
        "Do not infer from the file name; answer only from image contents.",
      ].join(" "),
    },
    {
      type: "image_url",
      url: path.join(context.artifactDirectory, "gemma-qa-card.png"),
      mediaType: "image/png",
    },
  ],
] as const;

const AUDIO_HARVARD_PROMPTS = [
  (context: ScenarioFixtureContext): SessionInput => [
    {
      type: "text",
      text: [
        "Run this as a headless CLI audio acceptance scenario.",
        "Transcribe the attached Open Speech Repository Harvard sentence recording.",
        "Return the words you hear and say that the source is Open Speech Repository.",
      ].join(" "),
    },
    {
      type: "audio_url",
      url: path.join(context.artifactDirectory, "OSR_us_000_0010_8k.wav"),
      mediaType: "audio/wav",
    },
  ],
] as const;

const VIDEO_KEYFRAME_PROMPTS = [
  (context: ScenarioFixtureContext): SessionInput => [
    {
      type: "text",
      text: [
        "Run this as a headless CLI video-keyframe acceptance scenario.",
        `The source video is saved at ${path.join(context.artifactDirectory, "placeholder-640x360.mp4")}.`,
        "Gemma Desktop-style video handling supplies representative keyframes to vision-capable models.",
        "Inspect the attached prepared keyframe image and report the visible video dimensions or label.",
      ].join(" "),
    },
    {
      type: "image_url",
      url: path.join(context.artifactDirectory, "keyframe-1.png"),
      mediaType: "image/png",
    },
  ],
] as const;

const ACT_FIX_BROKEN_TESTS_PROMPTS = [
  [
    "Run this as a headless CLI ACT repair scenario.",
    "There is a small npm project in the broken folder with failing tests.",
    "Fix the implementation without weakening the tests, run npm test inside broken, then call finalize_build immediately.",
  ].join(" "),
] as const;

const ACT_MULTILANG_PYTHON_GO_PROMPTS = [
  [
    "Run this as a headless CLI multi-language build scenario.",
    "Build a small project in the polyglot folder using the provided data/sample.txt fixture.",
    "Create a Python CLI that reads the sample numbers and prints count, sum, and average.",
    "Create a Go HTTP backend with go.mod and a package main server exposing /health and /summary JSON endpoints using only the standard library.",
    "Create validate.sh at the polyglot root.",
    "The validation script must run the Python CLI with python3 and must run go test ./... inside the Go backend when go is installed.",
    "If go is not installed, validate.sh must statically verify go.mod, main.go, package main, net/http, /health, and /summary, then print that static Go validation passed because the toolchain is unavailable.",
    "Run sh validate.sh inside polyglot, then call finalize_build immediately.",
  ].join(" "),
] as const;

const SCENARIO_SYSTEM_INSTRUCTIONS = [
  "You are running an on-demand Gemma Desktop CLI acceptance scenario.",
  "Use the available tools to gather evidence or mutate files; do not answer from memory when the scenario asks you to fetch, research, extract, build, edit, or validate.",
  "For build-mode scenarios, call finalize_build as soon as the requested artifact is validated.",
  "Keep outputs concise but include enough source, command, or artifact detail for an automated validator to verify the run.",
].join("\n");

interface ScenarioFixtureContext {
  command: ScenarioCliOptions;
  artifactDirectory: string;
  workingDirectory: string;
  runtime: ScenarioRuntimeLike;
}

type ScenarioPrompt = string | ((context: ScenarioFixtureContext) => Promise<SessionInput> | SessionInput);

interface ScenarioDefinition {
  id: ScenarioCliOptions["scenarioId"];
  mode: CreateSessionOptions["mode"];
  artifactDirectoryName: string;
  prompts: readonly ScenarioPrompt[];
  kind: string;
  prepare?(context: ScenarioFixtureContext): Promise<void>;
  evaluator(input: {
    command: ScenarioCliOptions;
    artifactDirectory: string;
    turns: readonly ScenarioTurnRecord[];
    rawResults: readonly TurnResult[];
  }): Promise<ScenarioEvaluation>;
}

const IMAGE_READING_FIXTURE_URL =
  "https://placehold.co/900x500/0b1220/ffffff.png?text=GEMMA+QA%0AORION+47%0ATOTAL+128.50%0ASTATUS+READY";
const AUDIO_HARVARD_FIXTURE_URL =
  "https://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav";
const VIDEO_PLACEHOLDER_FIXTURE_URL = "https://placeholdervideo.dev/640x360";
const VIDEO_KEYFRAME_FALLBACK_URL =
  "https://placehold.co/640x360/18202f/ffffff.png?text=640x360+PLACEHOLDER+VIDEO";

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".mod",
  ".mjs",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
]);

function writeLine(stream: WritableTextStream, text = ""): void {
  stream.write(`${text}\n`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRequestPreferences(command: ScenarioCliOptions): boolean {
  return Object.keys(command.requestPreferences).length > 0;
}

function scenarioModeBase(mode: CreateSessionOptions["mode"]): string {
  return typeof mode === "string" ? mode : mode.base ?? "explore";
}

function summarizeSessionInput(input: SessionInput): string {
  if (typeof input === "string") {
    return input;
  }

  return input
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[${part.type}: ${path.basename(part.url)}]`;
    })
    .join("\n");
}

async function resolveScenarioPrompt(
  prompt: ScenarioPrompt,
  context: ScenarioFixtureContext,
): Promise<SessionInput> {
  return typeof prompt === "function" ? await prompt(context) : prompt;
}

async function downloadFixtureFile(input: {
  url: string;
  outputPath: string;
  maxBytes: number;
}): Promise<void> {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  const existing = await stat(input.outputPath).catch(() => undefined);
  if (existing?.isFile() && existing.size > 0) {
    return;
  }

  const response = await fetch(input.url);
  if (!response.ok) {
    throw new Error(`Failed to download fixture ${input.url}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > input.maxBytes) {
    throw new Error(
      `Refusing to download fixture ${input.url}: ${contentLength} bytes exceeds ${input.maxBytes}.`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > input.maxBytes) {
    throw new Error(
      `Refusing to write fixture ${input.url}: ${buffer.byteLength} bytes exceeds ${input.maxBytes}.`,
    );
  }

  await writeFile(input.outputPath, buffer);
}

async function prepareImageReadingScenario(context: ScenarioFixtureContext): Promise<void> {
  await downloadFixtureFile({
    url: IMAGE_READING_FIXTURE_URL,
    outputPath: path.join(context.artifactDirectory, "gemma-qa-card.png"),
    maxBytes: 2 * 1024 * 1024,
  });
  await writeFile(
    path.join(context.artifactDirectory, "README.txt"),
    [
      "Fixture source: placehold.co generated PNG.",
      "Expected visible text: GEMMA QA / ORION 47 / TOTAL 128.50 / STATUS READY.",
    ].join("\n"),
    "utf8",
  );
}

async function prepareAudioHarvardScenario(context: ScenarioFixtureContext): Promise<void> {
  await downloadFixtureFile({
    url: AUDIO_HARVARD_FIXTURE_URL,
    outputPath: path.join(context.artifactDirectory, "OSR_us_000_0010_8k.wav"),
    maxBytes: 20 * 1024 * 1024,
  });
  await writeFile(
    path.join(context.artifactDirectory, "README.txt"),
    [
      "Fixture source: Open Speech Repository.",
      "Expected content class: American English Harvard sentences.",
      "Reference sentence list includes: The birch canoe slid on the smooth planks.",
    ].join("\n"),
    "utf8",
  );
}

async function extractVideoKeyframe(input: {
  videoPath: string;
  outputPath: string;
}): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      input.videoPath,
      "-frames:v",
      "1",
      input.outputPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function prepareVideoKeyframeScenario(context: ScenarioFixtureContext): Promise<void> {
  const videoPath = path.join(context.artifactDirectory, "placeholder-640x360.mp4");
  const keyframePath = path.join(context.artifactDirectory, "keyframe-1.png");
  await downloadFixtureFile({
    url: VIDEO_PLACEHOLDER_FIXTURE_URL,
    outputPath: videoPath,
    maxBytes: 20 * 1024 * 1024,
  });

  const extracted = await extractVideoKeyframe({
    videoPath,
    outputPath: keyframePath,
  });
  if (!extracted) {
    await downloadFixtureFile({
      url: VIDEO_KEYFRAME_FALLBACK_URL,
      outputPath: keyframePath,
      maxBytes: 2 * 1024 * 1024,
    });
  }

  await writeFile(
    path.join(context.artifactDirectory, "keyframes-manifest.json"),
    `${JSON.stringify({
      sourceVideoUrl: VIDEO_PLACEHOLDER_FIXTURE_URL,
      sourceVideoPath: videoPath,
      keyframes: [keyframePath],
      extraction: extracted ? "ffmpeg" : "fallback-placeholder-image",
      expectedVisibleText: "640x360",
    }, null, 2)}\n`,
    "utf8",
  );
}

async function prepareFixBrokenTestsScenario(context: ScenarioFixtureContext): Promise<void> {
  await mkdir(context.artifactDirectory, { recursive: true });
  await writeFile(
    path.join(context.artifactDirectory, "package.json"),
    `${JSON.stringify({
      name: "gemma-desktop-broken-math-fixture",
      private: true,
      type: "module",
      scripts: {
        test: "node index.test.mjs",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(context.artifactDirectory, "index.js"),
    [
      "export function add(a, b) {",
      "  return a - b;",
      "}",
      "",
      "export function formatTotal(value) {",
      "  return `Total: ${value}`;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(context.artifactDirectory, "index.test.mjs"),
    [
      "import { strict as assert } from 'node:assert';",
      "import { add, formatTotal } from './index.js';",
      "",
      "assert.equal(add(2, 3), 5);",
      "assert.equal(add(-4, 7), 3);",
      "assert.equal(formatTotal(add(10, 5)), 'Total: 15');",
      "console.log('broken fixture tests passed');",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function prepareMultilangPythonGoScenario(context: ScenarioFixtureContext): Promise<void> {
  await mkdir(path.join(context.artifactDirectory, "data"), { recursive: true });
  await writeFile(
    path.join(context.artifactDirectory, "data", "sample.txt"),
    ["4", "8", "15", "16", "23", "42", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(context.artifactDirectory, "README.txt"),
    [
      "Multi-language fixture.",
      "Expected Python summary for data/sample.txt: count 6, sum 108, average 18.",
      "Go toolchain may be unavailable on CI or developer machines; validate.sh should compile/test when available and perform explicit static backend checks otherwise.",
    ].join("\n"),
    "utf8",
  );
}

function countEvents(events: readonly GemmaDesktopEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function toolCommandText(toolResults: readonly ToolResult[]): string {
  return toolResults
    .map((toolResult) => {
      const structured = toolResult.structuredOutput;
      if (
        structured
        && typeof structured === "object"
        && !Array.isArray(structured)
      ) {
        const record = structured as Record<string, unknown>;
        const directCommand = typeof record.command === "string" ? record.command : "";
        const validationCommands = Array.isArray(record.validation)
          ? record.validation
              .map((entry) =>
                entry
                && typeof entry === "object"
                && !Array.isArray(entry)
                && typeof (entry as Record<string, unknown>).command === "string"
                  ? (entry as Record<string, unknown>).command as string
                  : "",
              )
          : [];
        return [directCommand, ...validationCommands].filter(Boolean).join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectProjectText(root: string, limit = 80_000): Promise<string> {
  const chunks: string[] = [];
  let used = 0;

  async function visit(directory: string): Promise<void> {
    if (used >= limit) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (used >= limit) {
        return;
      }
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const content = await readFile(entryPath, "utf8").catch(() => "");
      const relative = path.relative(root, entryPath);
      const next = `\n--- ${relative} ---\n${content}`;
      chunks.push(next.slice(0, Math.max(0, limit - used)));
      used += next.length;
    }
  }

  await visit(root);
  return chunks.join("\n");
}

function extractPackageScripts(packageText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(packageText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const scripts = (parsed as Record<string, unknown>).scripts;
    return scripts && typeof scripts === "object" && !Array.isArray(scripts)
      ? scripts as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizeWordsForSearch(text: string): string {
  return normalizeForSearch(text)
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringifyToolEvidence(rawResults: readonly TurnResult[]): string {
  return rawResults
    .flatMap((result) =>
      result.toolResults.map((toolResult) =>
        [
          toolResult.toolName,
          toolResult.output,
          JSON.stringify(toolResult.structuredOutput ?? {}),
          JSON.stringify(toolResult.metadata ?? {}),
        ].join("\n"),
      ),
    )
    .join("\n");
}

function collectToolNames(rawResults: readonly TurnResult[]): Set<string> {
  return new Set(
    rawResults.flatMap((result) =>
      result.toolResults.map((toolResult) => toolResult.toolName),
    ),
  );
}

function buildScenarioHaystack(
  turns: readonly ScenarioTurnRecord[],
  rawResults: readonly TurnResult[],
  projectText = "",
): string {
  return [
    projectText,
    turns.map((turn) => turn.text ?? "").join("\n"),
    stringifyToolEvidence(rawResults),
  ].join("\n");
}

function evaluateChecks(checks: Record<string, boolean>): { score: number; issues: string[] } {
  const issues = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const passedCount = Object.values(checks).filter(Boolean).length;
  return {
    issues,
    score: passedCount / Math.max(1, Object.keys(checks).length),
  };
}

function withCommonScenarioChecks(
  evaluation: ScenarioEvaluation,
  turns: readonly ScenarioTurnRecord[],
): ScenarioEvaluation {
  const checks = {
    ...evaluation.checks,
    turnsCompleted: turns.every((turn) => !turn.error),
  };
  const common = evaluateChecks(checks);
  return {
    ...evaluation,
    success: common.issues.length === 0,
    score: common.score,
    checks,
    issues: common.issues,
  };
}

async function evaluateBlackHoleScenario(
  artifactDirectory: string,
  turns: readonly ScenarioTurnRecord[],
  rawResults: readonly TurnResult[],
): Promise<ScenarioEvaluation> {
  const packagePath = path.join(artifactDirectory, "package.json");
  const blackFolderExists = await pathExists(artifactDirectory);
  const packageJsonExists = await pathExists(packagePath);
  const packageText = packageJsonExists
    ? await readFile(packagePath, "utf8").catch(() => "")
    : "";
  const scripts = extractPackageScripts(packageText);
  const npmScriptsPresent =
    typeof scripts.dev === "string"
    || typeof scripts.start === "string"
    || typeof scripts.build === "string"
    || typeof scripts.test === "string";
  const projectText = blackFolderExists ? await collectProjectText(artifactDirectory) : "";
  const haystack = buildScenarioHaystack(turns, rawResults, projectText).toLowerCase();
  const commandText = rawResults
    .map((result) => toolCommandText(result.toolResults))
    .join("\n");
  const npmWasUsed = /\bnpm\b/.test(commandText) || /\bnpm\b/i.test(projectText);
  const topicStayedBlackHole =
    /\bblack\s+hole\b/.test(haystack)
    && /\b(event\s+horizon|accretion|gravitational|lensing|singularity|gravity)\b/.test(haystack)
    && !/\bblack\s+home\b/.test(haystack);
  const requestedUiChangesPresent =
    /\bmass\b/.test(haystack)
    && /\baccretion\b/.test(haystack)
    && /\blensing\b/.test(haystack)
    && /\bpause\b/.test(haystack)
    && /\breset\b/.test(haystack)
    && /\b(stats|readout|metrics)\b/.test(haystack);

  const validationScript = typeof scripts.build === "string"
    ? "build"
    : typeof scripts.validate === "string"
      ? "validate"
      : typeof scripts.test === "string"
        ? "test"
        : undefined;
  const validationCommand =
    packageJsonExists && validationScript
      ? await runShellCommand(`npm run ${validationScript}`, {
          cwd: artifactDirectory,
          timeoutMs: 120_000,
        })
      : undefined;
  const validationPassed = validationCommand
    ? validationCommand.exitCode === 0 && validationCommand.timedOut === false
    : rawResults.some((result) => result.build?.verification?.passed === true);

  const checks = {
    blackFolderExists,
    packageJsonExists,
    npmScriptsPresent,
    npmWasUsed,
    validationPassed,
    topicStayedBlackHole,
    requestedUiChangesPresent,
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
    ...(validationCommand
      ? {
          validationCommand: {
            command: validationCommand.command,
            exitCode: validationCommand.exitCode,
            timedOut: validationCommand.timedOut,
            stdout: validationCommand.stdout.slice(0, 4_000),
            stderr: validationCommand.stderr.slice(0, 4_000),
          },
        }
      : {}),
  };
}

async function evaluatePdfAttentionScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const projectText = await collectProjectText(input.artifactDirectory, 180_000);
  const haystack = buildScenarioHaystack(input.turns, input.rawResults, projectText);
  const normalized = normalizeForSearch(haystack);
  const normalizedWords = normalizeWordsForSearch(haystack);
  const toolNames = collectToolNames(input.rawResults);
  const expectedAuthors = [
    "ashish vaswani",
    "noam shazeer",
    "niki parmar",
    "jakob uszkoreit",
    "llion jones",
    "aidan n gomez",
    "lukasz kaiser",
    "illia polosukhin",
  ];
  const authorMatches = expectedAuthors.filter((author) =>
    normalizedWords.includes(author),
  );
  const checks = {
    sourceLocated: /attention[_\s-]+is[_\s-]+all[_\s-]+you[_\s-]+need/.test(normalized)
      && /\.(pdf)\b/.test(normalized),
    extractionToolUsed:
      toolNames.has("extract_pdf_text")
      || toolNames.has("exec_command")
      || toolNames.has("materialize_content")
      || toolNames.has("read_content")
      || toolNames.has("search_content"),
    extractedTextAvailable:
      normalized.includes("attention is all you need")
      && (projectText.length > 10_000 || normalized.includes("abstract")),
    allAuthorsFound: authorMatches.length === expectedAuthors.length,
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateHackerNewsScenario(input: {
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  await Promise.resolve();
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const toolNames = collectToolNames(input.rawResults);
  const checks = {
    webToolUsed:
      toolNames.has("fetch_url")
      || toolNames.has("fetch_url_safe")
      || toolNames.has("search_web")
      || toolNames.has("web_research_agent"),
    sourceIsHackerNews:
      normalized.includes("news.ycombinator.com")
      || normalized.includes("hacker news"),
    reportsMultipleItems:
      (haystack.match(/\n\s*(?:[-*]|\d+[.)])\s+/g) ?? []).length >= 3
      || (normalized.match(/\b(?:points?|comments?)\b/g) ?? []).length >= 3,
    includesUpdateFraming:
      /\b(current|latest|front[-\s]?page|top\s+five|top\s+5|update)\b/.test(normalized),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateNewsCoverageScenario(input: {
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  await Promise.resolve();
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const toolNames = collectToolNames(input.rawResults);
  const checks = {
    webResearchUsed:
      toolNames.has("web_research_agent")
      || toolNames.has("search_web")
      || toolNames.has("fetch_url")
      || toolNames.has("fetch_url_safe"),
    cnnCovered: /\bcnn\b|cnn\.com/.test(normalized),
    foxCovered: /fox\s+news|foxnews\.com/.test(normalized),
    msnbcCovered: /\bmsnbc\b|msnbc\.com/.test(normalized),
    comparisonPresent:
      /\b(compare|comparison|differs?|overlap|emphasis|framing|coverage)\b/.test(normalized),
    directSourceEvidence:
      /(cnn\.com|www\.cnn\.com)/.test(normalized)
      && /(foxnews\.com|www\.foxnews\.com)/.test(normalized)
      && /(msnbc\.com|www\.msnbc\.com)/.test(normalized),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateRestIsHistoryLyndonScenario(input: {
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  await Promise.resolve();
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const toolNames = collectToolNames(input.rawResults);
  const restIsHistoryEpisodeLinks =
    haystack.match(/https?:\/\/(?:www\.)?therestishistory\.com\/episodes\/[^\s)\]]+/gi) ?? [];
  const checks = {
    browserToolUsed: toolNames.has("browser"),
    siteOpened: /therestishistory\.com/.test(normalized),
    episodesUiUsed: /\bepisodes?\b/.test(normalized),
    searchBoxUsed: /\b(search|searched|search\s+box|filled)\b/.test(normalized),
    lyndonResultsReturned: /\blyndon\b/.test(normalized),
    episodeLinksReturned: restIsHistoryEpisodeLinks.length >= 1,
    noToolFailure: input.rawResults.every((result) =>
      result.toolResults.every((toolResult) => toolResult.metadata?.toolError !== true),
    ),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateGemma4ResearchScenario(input: {
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  await Promise.resolve();
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const toolNames = collectToolNames(input.rawResults);
  const checks = {
    researchToolUsed:
      toolNames.has("web_research_agent")
      || toolNames.has("search_web")
      || toolNames.has("fetch_url")
      || toolNames.has("fetch_url_safe")
      || toolNames.has("exec_command"),
    gemma4Covered: /gemma\s*4/.test(normalized),
    modelSizesCovered: /\b26b\b/.test(normalized) && /\b31b\b/.test(normalized),
    availabilityCovered:
      /\b(available|availability|ollama|runtime|catalog|model\s+card|download)\b/.test(normalized),
    sourcesIncluded:
      /https?:\/\/\S+/.test(haystack)
      || /\b(deepmind\.google|ai\.google|ollama\.com)\b/.test(normalized),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateImageReadingScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const imageExists = await pathExists(path.join(input.artifactDirectory, "gemma-qa-card.png"));
  const checks = {
    imageFixtureExists: imageExists,
    readsVisibleCode: /orion\s*47|orion-47/.test(normalized),
    readsVisibleTotal: /128[.\s]*50/.test(normalized),
    readsVisibleStatus: /status\s+ready|ready/.test(normalized),
    noToolFailure: input.rawResults.every((result) =>
      result.toolResults.every((toolResult) => toolResult.metadata?.toolError !== true),
    ),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateAudioHarvardScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const audioExists = await pathExists(path.join(input.artifactDirectory, "OSR_us_000_0010_8k.wav"));
  const harvardTerms = [
    "birch",
    "canoe",
    "smooth",
    "planks",
    "glue",
    "sheet",
    "background",
    "chicken",
    "lemons",
    "punch",
  ];
  const matchedTerms = harvardTerms.filter((term) => normalized.includes(term));
  const checks = {
    audioFixtureExists: audioExists,
    sourceCredited: /open\s+speech\s+repository|harvard\s+sentence/.test(normalized),
    transcribedHarvardWords: matchedTerms.length >= 3,
    noToolFailure: input.rawResults.every((result) =>
      result.toolResults.every((toolResult) => toolResult.metadata?.toolError !== true),
    ),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateVideoKeyframeScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const haystack = buildScenarioHaystack(input.turns, input.rawResults);
  const normalized = normalizeForSearch(haystack);
  const videoExists = await pathExists(path.join(input.artifactDirectory, "placeholder-640x360.mp4"));
  const keyframeExists = await pathExists(path.join(input.artifactDirectory, "keyframe-1.png"));
  const checks = {
    videoFixtureExists: videoExists,
    keyframePrepared: keyframeExists,
    reportsVideoDimensions: /640\s*[x×]\s*360|640\s+by\s+360/.test(normalized),
    mentionsVideoOrKeyframe: /video|keyframe|frame|placeholder/.test(normalized),
    noToolFailure: input.rawResults.every((result) =>
      result.toolResults.every((toolResult) => toolResult.metadata?.toolError !== true),
    ),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
  };
}

async function evaluateFixBrokenTestsScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const packagePath = path.join(input.artifactDirectory, "package.json");
  const implementationPath = path.join(input.artifactDirectory, "index.js");
  const testsPath = path.join(input.artifactDirectory, "index.test.mjs");
  const packageJsonExists = await pathExists(packagePath);
  const implementationText = await readFile(implementationPath, "utf8").catch(() => "");
  const testsText = await readFile(testsPath, "utf8").catch(() => "");
  const projectText = await collectProjectText(input.artifactDirectory, 60_000);
  const haystack = buildScenarioHaystack(input.turns, input.rawResults, projectText).toLowerCase();
  const commandText = input.rawResults
    .map((result) => toolCommandText(result.toolResults))
    .join("\n");
  const validationCommand = packageJsonExists
    ? await runShellCommand("npm test", {
        cwd: input.artifactDirectory,
        timeoutMs: 120_000,
      })
    : undefined;
  const checks = {
    packageJsonExists,
    implementationFixed:
      /return\s+a\s*\+\s*b/.test(implementationText)
      || (!/return\s+a\s*-\s*b/.test(implementationText) && /add\s*\(/.test(implementationText)),
    testsPreserved:
      /assert\.equal\(add\(2,\s*3\),\s*5\)/.test(testsText)
      && /assert\.equal\(add\(-4,\s*7\),\s*3\)/.test(testsText),
    npmTestRan: /\bnpm\s+test\b/.test(commandText) || /\bnpm\s+test\b/.test(haystack),
    validationPassed:
      validationCommand?.exitCode === 0
      && validationCommand.timedOut === false
      && /passed/i.test(validationCommand.stdout),
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
    ...(validationCommand
      ? {
          validationCommand: {
            command: validationCommand.command,
            exitCode: validationCommand.exitCode,
            timedOut: validationCommand.timedOut,
            stdout: validationCommand.stdout.slice(0, 4_000),
            stderr: validationCommand.stderr.slice(0, 4_000),
          },
        }
      : {}),
  };
}

async function evaluateMultilangPythonGoScenario(input: {
  artifactDirectory: string;
  turns: readonly ScenarioTurnRecord[];
  rawResults: readonly TurnResult[];
}): Promise<ScenarioEvaluation> {
  const validatePath = path.join(input.artifactDirectory, "validate.sh");
  const projectText = await collectProjectText(input.artifactDirectory, 100_000);
  const haystack = buildScenarioHaystack(input.turns, input.rawResults, projectText).toLowerCase();
  const commandText = input.rawResults
    .map((result) => toolCommandText(result.toolResults))
    .join("\n");
  const validationCommand = await pathExists(validatePath)
    ? await runShellCommand("sh validate.sh", {
        cwd: input.artifactDirectory,
        timeoutMs: 120_000,
      })
    : undefined;
  const checks = {
    pythonSourcePresent:
      /--- [^\n]+\.py ---/.test(projectText)
      && /\b(count|sum|average)\b/.test(projectText.toLowerCase()),
    goBackendPresent:
      /--- [^\n]+\.go ---/.test(projectText)
      && /--- [^\n]*go\.mod ---/.test(projectText)
      && /\bpackage\s+main\b/.test(projectText)
      && /net\/http/.test(projectText)
      && /\/health/.test(projectText)
      && /\/summary/.test(projectText),
    validationScriptPresent: await pathExists(validatePath),
    pythonValidationRan:
      /\bpython3\b/.test(commandText)
      || /\bpython3\b/.test(haystack)
      || /\bpython\b/.test(validationCommand?.stdout.toLowerCase() ?? ""),
    goValidationHandled:
      /\bgo\s+test\b/.test(commandText)
      || /\bgo\s+test\b/.test(haystack)
      || /static go validation passed|go toolchain unavailable/.test(validationCommand?.stdout.toLowerCase() ?? ""),
    validationPassed:
      validationCommand?.exitCode === 0
      && validationCommand.timedOut === false,
  };
  const evaluation = evaluateChecks(checks);
  return {
    success: evaluation.issues.length === 0,
    score: evaluation.score,
    checks,
    issues: evaluation.issues,
    ...(validationCommand
      ? {
          validationCommand: {
            command: validationCommand.command,
            exitCode: validationCommand.exitCode,
            timedOut: validationCommand.timedOut,
            stdout: validationCommand.stdout.slice(0, 4_000),
            stderr: validationCommand.stderr.slice(0, 4_000),
          },
        }
      : {}),
  };
}

async function runScenarioTurn(input: {
  session: ScenarioSession;
  prompt: SessionInput;
  promptSummary: string;
  index: number;
  command: ScenarioCliOptions;
  buildPolicy?: ScenarioCliOptions["buildPolicy"];
  runtime: ScenarioRuntimeLike;
}): Promise<{ record: ScenarioTurnRecord; result?: TurnResult }> {
  const events: GemmaDesktopEvent[] = [];
  const timeoutController = new AbortController();
  const relayAbort = () => {
    timeoutController.abort(input.runtime.signal?.reason);
  };
  input.runtime.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => {
    timeoutController.abort(
      new Error(`Scenario turn timed out after ${input.command.turnTimeoutMs}ms.`),
    );
  }, input.command.turnTimeoutMs);

  try {
    if (input.runtime.signal?.aborted === true) {
      relayAbort();
    }

    const streamed = await input.session.runStreamed(input.prompt, {
      signal: timeoutController.signal,
      ...(input.command.maxSteps ? { maxSteps: input.command.maxSteps } : {}),
      ...(input.buildPolicy ? { buildPolicy: input.buildPolicy } : {}),
      ...(input.command.debugRuntime
        ? {
            debug: (event: RuntimeDebugEvent) => {
              writeLine(input.runtime.stderr, JSON.stringify({ type: "runtime.debug", event }));
            },
          }
        : {}),
    });

    for await (const event of streamed.events) {
      events.push(event);
      if (input.command.showEvents) {
        writeLine(input.runtime.stderr, JSON.stringify({ type: "sdk.event", event }));
      }
    }

    const result = await streamed.completed;
    return {
      result,
      record: {
        index: input.index,
        prompt: input.promptSummary,
        turnId: result.turnId,
        text: result.text,
        steps: result.steps,
        warnings: result.warnings,
        toolNames: result.toolResults.map((toolResult) => toolResult.toolName),
        build: result.build,
        eventCounts: countEvents(events),
      },
    };
  } finally {
    clearTimeout(timeout);
    input.runtime.signal?.removeEventListener("abort", relayAbort);
  }
}

const SCENARIO_DEFINITIONS: Record<ScenarioCliOptions["scenarioId"], ScenarioDefinition> = {
  "act-webapp-black-hole": {
    id: "act-webapp-black-hole",
    mode: "build",
    artifactDirectoryName: "black",
    prompts: BLACK_HOLE_SCENARIO_PROMPTS,
    kind: "act-webapp",
    evaluator: async ({ artifactDirectory, turns, rawResults }) =>
      await evaluateBlackHoleScenario(artifactDirectory, turns, rawResults),
  },
  "pdf-attention-authors": {
    id: "pdf-attention-authors",
    mode: "build",
    artifactDirectoryName: path.join(".gemma-headless", "pdf-attention"),
    prompts: PDF_ATTENTION_PROMPTS,
    kind: "pdf-extraction",
    evaluator: evaluatePdfAttentionScenario,
  },
  "web-hacker-news-frontpage": {
    id: "web-hacker-news-frontpage",
    mode: "explore",
    artifactDirectoryName: path.join(".gemma-headless", "hacker-news"),
    prompts: HACKER_NEWS_PROMPTS,
    kind: "web-fetch",
    evaluator: evaluateHackerNewsScenario,
  },
  "web-news-coverage-compare": {
    id: "web-news-coverage-compare",
    mode: "explore",
    artifactDirectoryName: path.join(".gemma-headless", "news-coverage"),
    prompts: NEWS_COVERAGE_PROMPTS,
    kind: "web-research",
    evaluator: evaluateNewsCoverageScenario,
  },
  "browser-rest-is-history-lyndon": {
    id: "browser-rest-is-history-lyndon",
    mode: {
      base: "explore",
      tools: ["browser"],
      withoutTools: ["fetch_url", "search_web", "web_research_agent"],
    },
    artifactDirectoryName: path.join(".gemma-headless", "rest-is-history-lyndon"),
    prompts: REST_IS_HISTORY_LYNDON_PROMPTS,
    kind: "browser-navigation",
    evaluator: evaluateRestIsHistoryLyndonScenario,
  },
  "research-gemma4-availability": {
    id: "research-gemma4-availability",
    mode: "build",
    artifactDirectoryName: path.join(".gemma-headless", "gemma4-research"),
    prompts: GEMMA4_RESEARCH_PROMPTS,
    kind: "web-research",
    evaluator: evaluateGemma4ResearchScenario,
  },
  "image-reading-card": {
    id: "image-reading-card",
    mode: "explore",
    artifactDirectoryName: path.join(".gemma-headless", "image-reading-card"),
    prompts: IMAGE_READING_PROMPTS,
    kind: "image-reading",
    prepare: prepareImageReadingScenario,
    evaluator: evaluateImageReadingScenario,
  },
  "audio-harvard-transcript": {
    id: "audio-harvard-transcript",
    mode: "explore",
    artifactDirectoryName: path.join(".gemma-headless", "audio-harvard"),
    prompts: AUDIO_HARVARD_PROMPTS,
    kind: "audio-transcription",
    prepare: prepareAudioHarvardScenario,
    evaluator: evaluateAudioHarvardScenario,
  },
  "video-placeholder-keyframes": {
    id: "video-placeholder-keyframes",
    mode: "explore",
    artifactDirectoryName: path.join(".gemma-headless", "video-placeholder"),
    prompts: VIDEO_KEYFRAME_PROMPTS,
    kind: "video-keyframes",
    prepare: prepareVideoKeyframeScenario,
    evaluator: evaluateVideoKeyframeScenario,
  },
  "act-fix-broken-tests": {
    id: "act-fix-broken-tests",
    mode: "build",
    artifactDirectoryName: "broken",
    prompts: ACT_FIX_BROKEN_TESTS_PROMPTS,
    kind: "act-repair",
    prepare: prepareFixBrokenTestsScenario,
    evaluator: evaluateFixBrokenTestsScenario,
  },
  "act-multilang-python-go": {
    id: "act-multilang-python-go",
    mode: "build",
    artifactDirectoryName: "polyglot",
    prompts: ACT_MULTILANG_PYTHON_GO_PROMPTS,
    kind: "act-multilang",
    prepare: prepareMultilangPythonGoScenario,
    evaluator: evaluateMultilangPythonGoScenario,
  },
};

export async function runHeadlessScenario(
  command: ScenarioCliOptions,
  desktop: ScenarioDesktopLike,
  runtime: ScenarioRuntimeLike,
): Promise<ScenarioRunResult> {
  const definition = SCENARIO_DEFINITIONS[command.scenarioId];
  const artifactDirectory = path.join(command.workingDirectory, definition.artifactDirectoryName);
  const isBuildScenario = scenarioModeBase(definition.mode) === "build";
  await mkdir(command.workingDirectory, { recursive: true });
  const fixtureContext: ScenarioFixtureContext = {
    command,
    artifactDirectory,
    workingDirectory: command.workingDirectory,
    runtime,
  };
  if (definition.prepare) {
    writeLine(runtime.stderr, `scenario: ${definition.id} preparing fixtures`);
    await definition.prepare(fixtureContext);
  }
  const metadata = buildDesktopParitySessionMetadata({
    mode: definition.mode,
    runtimeId: command.runtimeId,
    preferredRuntimeId: command.runtimeId,
    selectedToolNames: [],
    approvalMode: command.approvalMode,
    requestPreferences: hasRequestPreferences(command) ? command.requestPreferences : undefined,
    extraMetadata: {
      scenario: command.scenarioId,
      scenarioKind: definition.kind,
    },
  });
  const session = await desktop.sessions.create({
    runtime: command.runtimeId,
    model: command.modelId,
    mode: definition.mode,
    workingDirectory: command.workingDirectory,
    metadata,
    systemInstructions: SCENARIO_SYSTEM_INSTRUCTIONS,
    ...(command.maxSteps ? { maxSteps: command.maxSteps } : {}),
    ...(isBuildScenario ? { buildPolicy: command.buildPolicy } : {}),
  });

  const turns: ScenarioTurnRecord[] = [];
  const rawResults: TurnResult[] = [];
  for (const [index, prompt] of definition.prompts.entries()) {
    writeLine(runtime.stderr, `scenario: ${definition.id} turn ${index + 1}/${definition.prompts.length}`);
    const resolvedPrompt = await resolveScenarioPrompt(prompt, fixtureContext);
    const promptSummary = summarizeSessionInput(resolvedPrompt);
    try {
      const turn = await runScenarioTurn({
        session,
        prompt: resolvedPrompt,
        promptSummary,
        index: index + 1,
        command,
        buildPolicy: isBuildScenario ? command.buildPolicy : undefined,
        runtime,
      });
      turns.push(turn.record);
      if (turn.result) {
        rawResults.push(turn.result);
      }
    } catch (error) {
      turns.push({
        index: index + 1,
        prompt: promptSummary,
        error: formatError(error),
      });
      if (runtime.signal?.aborted === true) {
        break;
      }
    }
  }

  const evaluation = await definition.evaluator({
    command,
    artifactDirectory,
    turns,
    rawResults,
  });

  return {
    scenarioId: command.scenarioId,
    sessionId: session.id,
    workingDirectory: command.workingDirectory,
    artifactDirectory,
    turns,
    evaluation: withCommonScenarioChecks(evaluation, turns),
  };
}
