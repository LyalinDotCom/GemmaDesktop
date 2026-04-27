import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { GemmaDesktopError } from "@gemma-desktop/sdk-core";

const DEFAULT_READ_LINE_LIMIT = 200;
const DEFAULT_READ_MAX_BYTES = 50 * 1024;
const DEFAULT_MULTI_READ_MAX_BYTES = 120 * 1024;
const DEFAULT_LIST_LIMIT = 120;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_LIST_DESCENDANT_SCAN_BUDGET = 2_000;
const DEFAULT_LIST_DESCENDANT_HINT_LIMIT = 20;
const DEFAULT_LIST_SAMPLE_LIMIT = 5;
const DEFAULT_LIST_COLLAPSE_THRESHOLD = 80;
const RG_DOWNLOAD_VERSION = process.env.GEMMA_DESKTOP_RG_VERSION?.trim() || "15.1.0";
const FD_DOWNLOAD_VERSION = process.env.GEMMA_DESKTOP_FD_VERSION?.trim() || "10.2.0";
const RG_DOWNLOAD_BASE_URL =
  process.env.GEMMA_DESKTOP_RG_DOWNLOAD_BASE_URL?.trim()
  || "https://github.com/BurntSushi/ripgrep/releases/download";
const FD_DOWNLOAD_BASE_URL =
  process.env.GEMMA_DESKTOP_FD_DOWNLOAD_BASE_URL?.trim()
  || "https://github.com/sharkdp/fd/releases/download";

let ripgrepPathPromise: Promise<string> | undefined;
let fdPathPromise: Promise<string | undefined> | undefined;

type WorkspaceEntryType = "file" | "directory";

export interface WorkspaceListTreeInput {
  path?: string;
  depth?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
  limit?: number;
}

export interface WorkspaceListTreeResult {
  basePath: string;
  entries: string[];
  listedDepth: number;
  truncated: boolean;
  collapsedDirectories: Array<{
    path: string;
    visibleEntryCount: number;
    reason: "dependency" | "cache" | "build" | "large";
  }>;
  dominantCollapsedDirectory?: string;
  retrySameInputUnlikelyToHelp: boolean;
  hasMoreDescendantDirectories: boolean;
  descendantDirectoryHints: string[];
  hiddenEntriesOmitted?: {
    count: number;
    sample: string[];
  };
  ignoredEntriesOmitted?: {
    count: number;
    sample: string[];
  };
  notes: string[];
}

export interface WorkspaceSearchPathsInput {
  path?: string;
  query?: string;
  glob?: string;
  type?: "any" | "file" | "directory";
  limit?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
}

export interface WorkspaceSearchPathMatch {
  path: string;
  type: WorkspaceEntryType;
  score?: number;
}

export interface WorkspaceSearchPathsResult {
  basePath: string;
  type: "any" | "file" | "directory";
  mode: "query" | "glob";
  matches: WorkspaceSearchPathMatch[];
  truncated: boolean;
}

export interface WorkspaceSearchTextInput {
  query: string;
  path?: string;
  include?: string | string[];
  exclude?: string | string[];
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  before?: number;
  after?: number;
  limit?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
}

export interface WorkspaceSearchTextMatch {
  path: string;
  line: number;
  text: string;
  submatches: Array<{
    text: string;
    start: number;
    end: number;
  }>;
  beforeContext?: Array<{ line: number; text: string }>;
  afterContext?: Array<{ line: number; text: string }>;
}

export interface WorkspaceSearchTextResult {
  basePath: string;
  query: string;
  regex: boolean;
  matches: WorkspaceSearchTextMatch[];
  truncated: boolean;
}

export interface WorkspaceReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

export interface WorkspaceReadFileResult {
  path: string;
  absolutePath: string;
  offset: number;
  limit: number;
  maxBytes: number;
  content: string;
  numberedContent: string;
  lines: Array<{ line: number; text: string }>;
  truncated: boolean;
  nextOffset?: number;
  lineEnd: number;
  totalLinesScanned: number;
}

export interface WorkspaceReadFilesInput {
  requests: WorkspaceReadFileInput[];
  maxTotalBytes?: number;
}

export interface WorkspaceReadFilesResult {
  results: WorkspaceReadFileResult[];
  truncated: boolean;
  exhaustedBudget: boolean;
  maxTotalBytes: number;
  totalBytes: number;
}

interface DirectoryInspection {
  included: Array<{ name: string; type: WorkspaceEntryType }>;
  hiddenOmitted: string[];
  ignoredOmitted: string[];
}

interface DirectoryVisibility {
  visibleNames?: Set<string>;
  ignoredNames: Set<string>;
}

interface CollapsedDirectorySummary {
  visibleEntryCount: number;
  reason: "dependency" | "cache" | "build" | "large";
}

interface BinaryDownloadTarget {
  filename: string;
  binaryName: string;
  url: string;
}

function getGemmaDesktopHome(): string {
  return process.env.GEMMA_DESKTOP_HOME?.trim() || path.join(os.homedir(), ".gemma");
}

function getBinaryName(name: "rg" | "fd"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function compareWorkspaceEntries(
  left: { name: string; type: WorkspaceEntryType },
  right: { name: string; type: WorkspaceEntryType },
): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function withTrailingSlash(value: string, type: WorkspaceEntryType): string {
  return type === "directory" && !value.endsWith("/") ? `${value}/` : value;
}

function workspaceRelativePath(workingDirectory: string, absolutePath: string): string {
  const relative = path.relative(workingDirectory, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GemmaDesktopError(
      "permission_denied",
      `Refusing to access path outside the working directory: ${absolutePath}`,
    );
  }
  return relative === "" ? "." : toPosixPath(relative);
}

function resolveWorkspacePath(workingDirectory: string, target = "."): string {
  const resolved = path.resolve(workingDirectory, target);
  workspaceRelativePath(workingDirectory, resolved);
  return resolved;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function normalizeCount(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function normalizeArrayPatterns(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function formatSampleEntry(name: string, type: WorkspaceEntryType): string {
  return type === "directory" ? `${name}/` : name;
}

function buildListNote(prefix: string, sample: string[], count: number, suffix: string): string {
  const extraCount = Math.max(0, count - sample.length);
  return [
    prefix,
    sample.length > 0 ? `Examples: ${sample.join(", ")}` : undefined,
    extraCount > 0 ? `and ${extraCount} more entr${extraCount === 1 ? "y" : "ies"}.` : undefined,
    suffix,
  ]
    .filter(Boolean)
    .join(" ");
}

function collapseDirectoryReason(name: string): CollapsedDirectorySummary["reason"] | undefined {
  const normalized = name.toLowerCase();

  if (new Set(["node_modules", "vendor", ".venv", "venv"]).has(normalized)) {
    return "dependency";
  }

  if (
    new Set([
      ".cache",
      ".next",
      ".nuxt",
      ".turbo",
      "__pycache__",
      ".mypy_cache",
      ".pytest_cache",
      ".ruff_cache",
      ".tox",
      ".gradle",
    ]).has(normalized)
  ) {
    return "cache";
  }

  if (new Set(["dist", "build", "out", "coverage", "target"]).has(normalized)) {
    return "build";
  }

  return undefined;
}

function summarizeCollapsedDirectory(
  name: string,
  inspection: DirectoryInspection,
): CollapsedDirectorySummary | undefined {
  const visibleEntryCount = inspection.included.length;
  const namedReason = collapseDirectoryReason(name);

  if (namedReason) {
    return {
      visibleEntryCount,
      reason: namedReason,
    };
  }

  if (visibleEntryCount >= DEFAULT_LIST_COLLAPSE_THRESHOLD) {
    return {
      visibleEntryCount,
      reason: "large",
    };
  }

  return undefined;
}

function formatCollapsedDirectoryEntry(pathText: string, summary: CollapsedDirectorySummary): string {
  const reasonLabel = {
    dependency: "dependency directory",
    cache: "cache directory",
    build: "build directory",
    large: "large directory",
  }[summary.reason];
  const countLabel = `${summary.visibleEntryCount} visible entr${summary.visibleEntryCount === 1 ? "y" : "ies"}`;

  return `${withTrailingSlash(pathText, "directory")} [collapsed, ${reasonLabel}, ${countLabel}]`;
}

function buildGlobRegex(pattern: string): RegExp {
  let expression = "^";
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index]!;
    const next = pattern[index + 1];

    if (character === "*") {
      if (next === "*") {
        expression += ".*";
        index += 2;
        continue;
      }
      expression += "[^/]*";
      index += 1;
      continue;
    }

    if (character === "?") {
      expression += ".";
      index += 1;
      continue;
    }

    if (character === "{") {
      const closing = pattern.indexOf("}", index + 1);
      if (closing > index) {
        const parts = pattern
          .slice(index + 1, closing)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => buildGlobRegex(part).source.replace(/^\^/, "").replace(/\$$/, ""));
        if (parts.length > 0) {
          expression += `(?:${parts.join("|")})`;
          index = closing + 1;
          continue;
        }
      }
    }

    expression += /[|\\{}()[\]^$+?.]/.test(character)
      ? `\\${character}`
      : character;
    index += 1;
  }

  expression += "$";
  return new RegExp(expression);
}

function findMatchingArchiveName(entries: string[], binaryName: string): string | undefined {
  return entries.find((entry) => entry.endsWith(`/${binaryName}`) || entry === binaryName);
}

async function isExecutableFile(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findBinaryInPath(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const segment of pathValue.split(path.delimiter)) {
    const candidate = path.join(segment, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function spawnCollectLines(options: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  onLine?: (line: string) => boolean | void;
}): Promise<{ exitCode: number | null; stderr: string; terminatedEarly: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    let terminatedEarly = false;

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abortHandler);
    };

    const settleResolve = (result: { exitCode: number | null; stderr: string; terminatedEarly: boolean }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const abortHandler = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      settleReject(new Error(`Command aborted: ${options.command}`));
    };

    options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        const shouldContinue = options.onLine?.(line);
        if (shouldContinue === false) {
          terminatedEarly = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Best effort.
          }
          break;
        }
      }
    });

    child.on("error", (error) => {
      settleReject(error);
    });

    child.on("close", (exitCode) => {
      if (stdoutBuffer.length > 0 && !terminatedEarly) {
        options.onLine?.(stdoutBuffer);
      }
      settleResolve({
        exitCode,
        stderr,
        terminatedEarly,
      });
    });
  });
}

async function spawnCollectOutput(options: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abortHandler);
    };

    const settleResolve = (result: { exitCode: number | null; stdout: string; stderr: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const abortHandler = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      settleReject(new Error(`Command aborted: ${options.command}`));
    };

    options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (exitCode) => {
      settleResolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

async function downloadBinary(target: BinaryDownloadTarget): Promise<string> {
  const binDirectory = path.join(getGemmaDesktopHome(), "bin");
  await fs.mkdir(binDirectory, { recursive: true });

  const finalPath = path.join(binDirectory, target.binaryName);
  if (await isExecutableFile(finalPath)) {
    return finalPath;
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `gemma-desktop-${target.binaryName}-`));
  const archivePath = path.join(tempDirectory, target.filename);
  const extractDirectory = path.join(tempDirectory, "extract");

  try {
    const response = await fetch(target.url);
    if (!response.ok) {
      throw new Error(`Failed to download ${target.url}: ${response.status}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(archivePath, body);
    await fs.mkdir(extractDirectory, { recursive: true });

    const listResult = await spawnCollectOutput({
      command: "tar",
      args: ["-tzf", archivePath],
      cwd: tempDirectory,
    });
    if (listResult.exitCode !== 0) {
      throw new Error(listResult.stderr.trim() || `Failed to inspect ${target.filename}.`);
    }

    const archiveEntry = findMatchingArchiveName(
      listResult.stdout.split(/\r?\n/).filter(Boolean),
      target.binaryName,
    );
    if (!archiveEntry) {
      throw new Error(`Archive ${target.filename} does not contain ${target.binaryName}.`);
    }

    const extractResult = await spawnCollectLines({
      command: "tar",
      args: ["-xzf", archivePath, "-C", extractDirectory, archiveEntry],
      cwd: tempDirectory,
    });
    if (extractResult.exitCode !== 0) {
      throw new Error(extractResult.stderr.trim() || `Failed to extract ${target.binaryName}.`);
    }

    const extractedPath = path.join(extractDirectory, archiveEntry);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(extractedPath, finalPath);
    await fs.chmod(finalPath, 0o755);
    return finalPath;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function getRipgrepDownloadTarget(): BinaryDownloadTarget | undefined {
  const version = RG_DOWNLOAD_VERSION;
  const filename = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      return `ripgrep-${version}-aarch64-apple-darwin.tar.gz`;
    }
    if (process.platform === "darwin" && process.arch === "x64") {
      return `ripgrep-${version}-x86_64-apple-darwin.tar.gz`;
    }
    if (process.platform === "linux" && process.arch === "arm64") {
      return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
    }
    if (process.platform === "linux" && process.arch === "x64") {
      return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
    }
    return undefined;
  })();

  if (!filename) {
    return undefined;
  }

  return {
    filename,
    binaryName: getBinaryName("rg"),
    url: `${RG_DOWNLOAD_BASE_URL}/${version}/${filename}`,
  };
}

function getFdDownloadTarget(): BinaryDownloadTarget | undefined {
  const version = FD_DOWNLOAD_VERSION;
  const filename = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      return `fd-v${version}-aarch64-apple-darwin.tar.gz`;
    }
    if (process.platform === "darwin" && process.arch === "x64") {
      return `fd-v${version}-x86_64-apple-darwin.tar.gz`;
    }
    if (process.platform === "linux" && process.arch === "arm64") {
      return `fd-v${version}-aarch64-unknown-linux-gnu.tar.gz`;
    }
    if (process.platform === "linux" && process.arch === "x64") {
      return `fd-v${version}-x86_64-unknown-linux-gnu.tar.gz`;
    }
    return undefined;
  })();

  if (!filename) {
    return undefined;
  }

  return {
    filename,
    binaryName: getBinaryName("fd"),
    url: `${FD_DOWNLOAD_BASE_URL}/v${version}/${filename}`,
  };
}

async function resolveRipgrepPath(): Promise<string> {
  if (!ripgrepPathPromise) {
    ripgrepPathPromise = (async () => {
      const cachedPath = path.join(getGemmaDesktopHome(), "bin", getBinaryName("rg"));
      if (await isExecutableFile(cachedPath)) {
        return cachedPath;
      }
      const fromPath = await findBinaryInPath(getBinaryName("rg"));
      if (fromPath) {
        return fromPath;
      }
      if (process.env.GEMMA_DESKTOP_WORKSPACE_DISABLE_BINARY_DOWNLOADS === "1") {
        throw new GemmaDesktopError(
          "tool_execution_failed",
          "Ripgrep is required for workspace tools but was not found in $GEMMA_DESKTOP_HOME/bin or PATH.",
        );
      }
      const target = getRipgrepDownloadTarget();
      if (!target) {
        throw new GemmaDesktopError(
          "tool_execution_failed",
          `Ripgrep is required for workspace tools, but automatic download is not supported on ${process.platform}/${process.arch}.`,
        );
      }
      return await downloadBinary(target);
    })();
  }

  return await ripgrepPathPromise;
}

async function resolveFdPath(): Promise<string | undefined> {
  if (!fdPathPromise) {
    fdPathPromise = (async () => {
      const cachedPath = path.join(getGemmaDesktopHome(), "bin", getBinaryName("fd"));
      if (await isExecutableFile(cachedPath)) {
        return cachedPath;
      }
      const fromPath = await findBinaryInPath(getBinaryName("fd"));
      if (fromPath) {
        return fromPath;
      }
      if (process.env.GEMMA_DESKTOP_WORKSPACE_DISABLE_BINARY_DOWNLOADS === "1") {
        return undefined;
      }
      const target = getFdDownloadTarget();
      if (!target) {
        return undefined;
      }
      try {
        return await downloadBinary(target);
      } catch {
        return undefined;
      }
    })();
  }

  return await fdPathPromise;
}

async function rejectBinaryLookingFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4_096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        `Refusing to read binary-looking file: ${filePath}. Do not assume read_file can decode it. Use inspect_file first when available, or search for related text files instead.`,
      );
    }
  } finally {
    await handle.close();
  }
}

function matchTypeFromDirent(dirent: { isDirectory(): boolean }): WorkspaceEntryType {
  return dirent.isDirectory() ? "directory" : "file";
}

function formatReadOutput(result: WorkspaceReadFileResult): string {
  const header = result.numberedContent || "(No lines returned.)";
  const nextOffset = result.nextOffset ?? result.lineEnd + 1;

  if (result.truncated) {
    return [
      `[WARNING] Partial read for ${result.path}. This is not the full file.`,
      `The window stopped before line ${nextOffset} because it hit the current read window limit or byte budget (offset=${result.offset}, limit=${result.limit}, maxBytes=${result.maxBytes}).`,
      `Next step: call read_file with offset=${nextOffset} to continue, or use search_text first if you only need a specific section from a large text file.`,
      "",
      header,
    ].filter(Boolean).join("\n");
  }

  if (result.offset > 1) {
    return [
      `[read_file] Reached end of file for ${result.path}, but this window starts at offset=${result.offset}. You have lines ${result.offset}-${result.lineEnd}, not the earlier part of the file.`,
      "",
      header,
    ].filter(Boolean).join("\n");
  }

  return [
    result.lineEnd > 0
      ? `[read_file] Full file reached for ${result.path}. End of file is line ${result.lineEnd}.`
      : `[read_file] Full file reached for ${result.path}. The file is empty.`,
    "",
    header,
  ].filter(Boolean).join("\n");
}

function formatReadFilesOutput(result: WorkspaceReadFilesResult): string {
  const sections = result.results.map((entry) =>
    [
      `<file>${entry.path}</file>`,
      formatReadOutput(entry),
    ].join("\n"),
  );

  const summary = result.exhaustedBudget
    ? [
        `[WARNING] read_files returned an incomplete batch.`,
        `The batch hit its shared ${result.maxTotalBytes} byte budget before every requested read could finish.`,
        "Do not assume you saw every full file. Continue with targeted read_file offsets, or use search_text first when you only need specific sections from large text files.",
      ].join("\n")
    : result.truncated
      ? [
          `[WARNING] read_files returned an incomplete batch.`,
          "At least one requested file was partial or the batch stopped before every requested read could finish.",
          "Do not assume you saw every full file. Continue with targeted read_file offsets, or use search_text first when you only need specific sections from large text files.",
        ].join("\n")
      : [
          "[read_files] Batch read completed without truncation.",
          "Review each per-file header below to see whether it covers a full file or only the requested slice.",
        ].join("\n");

  return [summary, ...sections].join("\n\n");
}

function formatSearchTextOutput(result: WorkspaceSearchTextResult): string {
  if (result.matches.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [];
  for (const match of result.matches) {
    lines.push(`${match.path}:${match.line}: ${match.text}`);
    for (const context of match.beforeContext ?? []) {
      lines.push(`  ${match.path}:${context.line}- ${context.text}`);
    }
    for (const context of match.afterContext ?? []) {
      lines.push(`  ${match.path}:${context.line}+ ${context.text}`);
    }
  }

  if (result.truncated) {
    lines.push("");
    lines.push(`(Results truncated after ${result.matches.length} match${result.matches.length === 1 ? "" : "es"}.)`);
  }

  return lines.join("\n");
}

function formatSearchPathsOutput(result: WorkspaceSearchPathsResult): string {
  if (result.matches.length === 0) {
    return "No paths found.";
  }

  const lines = result.matches.map((match) => withTrailingSlash(match.path, match.type));
  if (result.truncated) {
    lines.push("");
    lines.push(`(Results truncated after ${result.matches.length} path${result.matches.length === 1 ? "" : "s"}.)`);
  }
  return lines.join("\n");
}

function buildSearchScore(query: string, candidatePath: string): number {
  const normalizedQuery = query.toLowerCase();
  const normalizedPath = stripTrailingSlash(candidatePath).toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const depth = normalizedPath.split("/").length - 1;

  if (basename === normalizedQuery) {
    return 10_000 - depth;
  }
  if (normalizedPath === normalizedQuery) {
    return 9_500 - depth;
  }
  if (basename.startsWith(normalizedQuery)) {
    return 8_500 - depth - (basename.length - normalizedQuery.length);
  }
  if (basename.includes(normalizedQuery)) {
    return 7_000 - depth - basename.indexOf(normalizedQuery);
  }
  if (normalizedPath.includes(`/${normalizedQuery}`)) {
    return 6_000 - depth - normalizedPath.indexOf(`/${normalizedQuery}`);
  }
  if (normalizedPath.includes(normalizedQuery)) {
    return 5_000 - depth - normalizedPath.indexOf(normalizedQuery);
  }
  return -1;
}

export class WorkspaceSearchBackend {
  private readonly workingDirectory: string;
  private readonly signal?: AbortSignal;
  private readonly directoryCache = new Map<string, Promise<DirectoryInspection>>();

  public constructor(options: { workingDirectory: string; signal?: AbortSignal }) {
    this.workingDirectory = options.workingDirectory;
    this.signal = options.signal;
  }

  public async listTree(input: WorkspaceListTreeInput): Promise<WorkspaceListTreeResult> {
    const basePath = resolveWorkspacePath(this.workingDirectory, input.path);
    const baseStat = await fs.stat(basePath).catch(() => undefined);
    if (!baseStat?.isDirectory()) {
      throw new GemmaDesktopError("tool_execution_failed", `Directory not found: ${input.path ?? "."}`);
    }

    const depth = normalizeCount(input.depth, 1, 8);
    const limit = normalizeLimit(input.limit, DEFAULT_LIST_LIMIT, 500);
    const includeHidden = input.includeHidden === true;
    const includeIgnored = input.includeIgnored === true;
    const entries: string[] = [];
    const collapsedDirectories: WorkspaceListTreeResult["collapsedDirectories"] = [];
    const frontier: Array<{ absolutePath: string; relativePath: string }> = [];
    let truncated = false;

    const collect = async (
      directoryPath: string,
      currentRelativePath: string,
      remainingDepth: number,
    ): Promise<void> => {
      const inspection = await this.inspectDirectory(directoryPath, {
        includeHidden,
        includeIgnored,
      });
      for (const entry of inspection.included) {
        const relative = currentRelativePath
          ? path.posix.join(currentRelativePath, entry.name)
          : entry.name;

        if (entry.type === "directory") {
          const childAbsolute = path.join(directoryPath, entry.name);
          if (remainingDepth > 0) {
            const childInspection = await this.inspectDirectory(childAbsolute, {
              includeHidden,
              includeIgnored,
            });
            const collapsedSummary = summarizeCollapsedDirectory(entry.name, childInspection);
            if (collapsedSummary) {
              entries.push(formatCollapsedDirectoryEntry(relative, collapsedSummary));
              if (entries.length >= limit) {
                truncated = true;
                return;
              }
              collapsedDirectories.push({
                path: withTrailingSlash(relative, "directory"),
                visibleEntryCount: collapsedSummary.visibleEntryCount,
                reason: collapsedSummary.reason,
              });
            } else {
              entries.push(withTrailingSlash(relative, entry.type));
              if (entries.length >= limit) {
                truncated = true;
                return;
              }
              await collect(childAbsolute, relative, remainingDepth - 1);
            }
            if (truncated) {
              return;
            }
          } else {
            entries.push(withTrailingSlash(relative, entry.type));
            if (entries.length >= limit) {
              truncated = true;
              return;
            }
            frontier.push({
              absolutePath: childAbsolute,
              relativePath: relative,
            });
          }
        } else {
          entries.push(relative);
          if (entries.length >= limit) {
            truncated = true;
            return;
          }
        }
      }
    };

    await collect(basePath, "", depth);
    const topLevelInspection = await this.inspectDirectory(basePath, {
      includeHidden,
      includeIgnored,
    });
    const descendantScan = await this.scanDescendantDirectoryHints(frontier, {
      includeHidden,
      includeIgnored,
    });
    const notes: string[] = [];

    if (!includeHidden && topLevelInspection.hiddenOmitted.length > 0) {
      notes.push(buildListNote(
        "Hidden entries at this level are omitted by default.",
        topLevelInspection.hiddenOmitted.slice(0, DEFAULT_LIST_SAMPLE_LIMIT),
        topLevelInspection.hiddenOmitted.length,
        "Use includeHidden: true to show them.",
      ));
    }

    if (!includeIgnored && topLevelInspection.ignoredOmitted.length > 0) {
      notes.push(buildListNote(
        "Ignored entries at this level are omitted by default.",
        topLevelInspection.ignoredOmitted.slice(0, DEFAULT_LIST_SAMPLE_LIMIT),
        topLevelInspection.ignoredOmitted.length,
        "Use includeIgnored: true to show them.",
      ));
    }

    if (descendantScan.hasMoreDescendantDirectories) {
      notes.push(
        [
          "More directories exist below this level. Try list_tree on a shown folder or use search_paths for recursive discovery.",
          descendantScan.hints.length > 0 ? `Examples: ${descendantScan.hints.join(", ")}` : undefined,
          descendantScan.budgetExceeded
            ? `Further descendant scanning was capped after ${DEFAULT_LIST_DESCENDANT_SCAN_BUDGET} filesystem entries.`
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    if (collapsedDirectories.length > 0) {
      const collapsedExamples = collapsedDirectories
        .slice(0, DEFAULT_LIST_SAMPLE_LIMIT)
        .map((entry) => entry.path)
        .join(", ");
      notes.push(
        [
          "Large or likely-generated directories were collapsed by default.",
          collapsedExamples.length > 0 ? `Examples: ${collapsedExamples}.` : undefined,
          "Call list_tree on one of those directories directly only when you specifically need it.",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    if (truncated) {
      notes.push(`The listing was truncated after ${limit} entries. Narrow the path or lower the depth to inspect a smaller area.`);
    }

    const dominantCollapsedDirectory = [...collapsedDirectories]
      .sort((left, right) => right.visibleEntryCount - left.visibleEntryCount)[0]?.path;
    const retrySameInputUnlikelyToHelp = truncated || collapsedDirectories.length > 0;

    if (retrySameInputUnlikelyToHelp) {
      notes.push(
        "Repeating the same list_tree call unchanged is unlikely to help. Narrow the path, lower the depth, or use search_paths for targeted discovery.",
      );
    }

    return {
      basePath,
      entries,
      listedDepth: depth,
      truncated,
      collapsedDirectories,
      dominantCollapsedDirectory,
      retrySameInputUnlikelyToHelp,
      hasMoreDescendantDirectories: descendantScan.hasMoreDescendantDirectories,
      descendantDirectoryHints: descendantScan.hints,
      hiddenEntriesOmitted: topLevelInspection.hiddenOmitted.length > 0
        ? {
            count: topLevelInspection.hiddenOmitted.length,
            sample: topLevelInspection.hiddenOmitted.slice(0, DEFAULT_LIST_SAMPLE_LIMIT),
          }
        : undefined,
      ignoredEntriesOmitted: topLevelInspection.ignoredOmitted.length > 0
        ? {
            count: topLevelInspection.ignoredOmitted.length,
            sample: topLevelInspection.ignoredOmitted.slice(0, DEFAULT_LIST_SAMPLE_LIMIT),
          }
        : undefined,
      notes,
    };
  }

  public async searchPaths(input: WorkspaceSearchPathsInput): Promise<WorkspaceSearchPathsResult> {
    const basePath = resolveWorkspacePath(this.workingDirectory, input.path);
    const baseStat = await fs.stat(basePath).catch(() => undefined);
    if (!baseStat?.isDirectory()) {
      throw new GemmaDesktopError("tool_execution_failed", `Directory not found: ${input.path ?? "."}`);
    }

    const query = input.query?.trim();
    const glob = input.glob?.trim();
    if ((query ? 1 : 0) + (glob ? 1 : 0) !== 1) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        "search_paths requires exactly one of query or glob.",
      );
    }

    const type = input.type ?? "any";
    const limit = normalizeLimit(input.limit, DEFAULT_SEARCH_LIMIT, 500);
    const includeHidden = input.includeHidden === true;
    const includeIgnored = input.includeIgnored === true;
    if (glob) {
      const matches = await this.searchPathsByGlob({
        basePath,
        glob,
        type,
        limit,
        includeHidden,
        includeIgnored,
      });
      return {
        basePath,
        type,
        mode: "glob",
        matches: matches.slice(0, limit),
        truncated: matches.length > limit,
      };
    }

    const corpus = await this.buildPathCorpus({
      basePath,
      type,
      includeHidden,
      includeIgnored,
    });
    const ranked = corpus
      .map((entry) => ({
        ...entry,
        score: buildSearchScore(query!, entry.path),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) =>
        right.score - left.score
        || left.path.split("/").length - right.path.split("/").length
        || left.path.localeCompare(right.path),
      );

    return {
      basePath,
      type,
      mode: "query",
      matches: ranked.slice(0, limit),
      truncated: ranked.length > limit,
    };
  }

  public async searchText(input: WorkspaceSearchTextInput): Promise<WorkspaceSearchTextResult> {
    if (input.query.trim().length === 0) {
      throw new GemmaDesktopError("tool_execution_failed", "search_text requires a non-empty query.");
    }

    const basePath = resolveWorkspacePath(this.workingDirectory, input.path);
    const baseStat = await fs.stat(basePath).catch(() => undefined);
    if (!baseStat) {
      throw new GemmaDesktopError("tool_execution_failed", `Search path not found: ${input.path ?? "."}`);
    }

    const ripgrepPath = await resolveRipgrepPath();
    const limit = normalizeLimit(input.limit, DEFAULT_SEARCH_LIMIT, 500);
    const includeHidden = input.includeHidden === true;
    const includeIgnored = input.includeIgnored === true;
    const regex = input.regex === true;
    const before = normalizeCount(input.before, 0, 20);
    const after = normalizeCount(input.after, 0, 20);
    const args = [
      "--json",
      "--line-number",
      "--color=never",
      "--glob=!.git",
      "--glob=!**/.git/**",
    ];

    if (includeHidden) {
      args.push("--hidden");
    }
    if (includeIgnored) {
      args.push("--no-ignore");
    }
    if (!regex) {
      args.push("--fixed-strings");
    }
    if (!input.caseSensitive) {
      args.push("--ignore-case");
    }
    if (input.wholeWord) {
      args.push("--word-regexp");
    }

    for (const pattern of normalizeArrayPatterns(input.include)) {
      args.push(`--glob=${pattern}`);
    }
    for (const pattern of normalizeArrayPatterns(input.exclude)) {
      args.push(`--glob=!${pattern}`);
    }

    args.push("--", input.query);
    args.push(basePath);

    const matches: WorkspaceSearchTextMatch[] = [];
    const result = await spawnCollectLines({
      command: ripgrepPath,
      args,
      cwd: this.workingDirectory,
      signal: this.signal,
      onLine: (line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "match") {
          return true;
        }

        const data = parsed.data as Record<string, unknown>;
        const pathRecord = data.path as Record<string, unknown>;
        const pathText = typeof pathRecord?.text === "string" ? pathRecord.text : undefined;
        if (!pathText) {
          return true;
        }
        const relativePath = workspaceRelativePath(this.workingDirectory, path.resolve(this.workingDirectory, pathText));
        if (relativePath === ".git" || relativePath.startsWith(".git/")) {
          return true;
        }
        const lineTextRecord = data.lines as Record<string, unknown>;
        const submatches = Array.isArray(data.submatches)
          ? (data.submatches as Array<Record<string, unknown>>).map((entry) => {
              const matchRecord = entry.match as Record<string, unknown>;
              return {
                text: typeof matchRecord?.text === "string" ? matchRecord.text : "",
                start: Number(entry.start ?? 0),
                end: Number(entry.end ?? 0),
              };
            })
          : [];
        matches.push({
          path: relativePath,
          line: Number(data.line_number ?? 0),
          text: String(lineTextRecord?.text ?? "").replace(/\r?\n$/, ""),
          submatches,
        });
        return matches.length < limit;
      },
    });

    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.terminatedEarly) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        result.stderr.trim() || "ripgrep search failed.",
      );
    }

    if ((before > 0 || after > 0) && matches.length > 0) {
      await Promise.all(matches.map(async (match) => {
        const window = await this.readFile({
          path: match.path,
          offset: Math.max(1, match.line - before),
          limit: before + after + 1,
          maxBytes: DEFAULT_READ_MAX_BYTES,
        });
        match.beforeContext = window.lines
          .filter((line) => line.line < match.line)
          .slice(-before)
          .map((line) => ({ line: line.line, text: line.text }));
        match.afterContext = window.lines
          .filter((line) => line.line > match.line)
          .slice(0, after)
          .map((line) => ({ line: line.line, text: line.text }));
      }));
    }

    matches.sort((left, right) =>
      left.path.localeCompare(right.path)
      || left.line - right.line
      || (left.submatches[0]?.start ?? 0) - (right.submatches[0]?.start ?? 0),
    );

    return {
      basePath,
      query: input.query,
      regex,
      matches: matches.slice(0, limit),
      truncated: result.terminatedEarly,
    };
  }

  public async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const absolutePath = resolveWorkspacePath(this.workingDirectory, input.path);
    const stat = await fs.stat(absolutePath).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw new GemmaDesktopError(
        "tool_execution_failed",
        error instanceof Error
          ? `Failed to inspect ${input.path} before reading: ${error.message}`
          : `Failed to inspect ${input.path} before reading.`,
      );
    });
    if (!stat?.isFile()) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        `File not found: ${input.path}. Use search_paths if the path may be wrong, or list_tree to inspect nearby folders.`,
      );
    }

    await rejectBinaryLookingFile(absolutePath);

    const offset = normalizeLimit(input.offset, 1, Number.MAX_SAFE_INTEGER);
    const limit = normalizeLimit(input.limit, DEFAULT_READ_LINE_LIMIT, 10_000);
    const maxBytes = normalizeLimit(input.maxBytes, DEFAULT_READ_MAX_BYTES, 512 * 1024);
    const lines: Array<{ line: number; text: string }> = [];
    const stream = createReadStream(absolutePath, { encoding: "utf8" });
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    let truncated = false;
    let exhaustedByBytes = false;
    let nextOffset: number | undefined;
    let renderedBytes = 0;

    try {
      for await (const line of reader) {
        if (this.signal?.aborted) {
          throw new GemmaDesktopError("cancellation", "Workspace read cancelled.");
        }
        lineNumber += 1;
        if (lineNumber < offset) {
          continue;
        }
        if (lines.length >= limit) {
          truncated = true;
          nextOffset = lineNumber;
          break;
        }

        const renderedLine = `${lineNumber}: ${line}`;
        const renderedLineBytes = Buffer.byteLength(
          `${lines.length === 0 ? "" : "\n"}${renderedLine}`,
          "utf8",
        );
        if (renderedBytes + renderedLineBytes > maxBytes) {
          truncated = true;
          exhaustedByBytes = true;
          nextOffset = lineNumber;
          break;
        }

        lines.push({ line: lineNumber, text: line });
        renderedBytes += renderedLineBytes;
      }
    } finally {
      reader.close();
      stream.close();
    }

    if (lines.length === 0 && lineNumber > 0 && offset > lineNumber) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        `Offset ${offset} is out of range for ${input.path} (${lineNumber} lines). Retry with a smaller offset or start again from offset=1.`,
      );
    }

    const numberedContent = lines.map((line) => `${line.line}: ${line.text}`).join("\n");
    const content = lines.map((line) => line.text).join("\n");
    const lastLine = lines.at(-1)?.line ?? Math.max(0, offset - 1);

    return {
      path: workspaceRelativePath(this.workingDirectory, absolutePath),
      absolutePath,
      offset,
      limit,
      maxBytes,
      content,
      numberedContent,
      lines,
      truncated,
      nextOffset,
      lineEnd: lastLine,
      totalLinesScanned: lineNumber,
      ...(exhaustedByBytes ? { nextOffset } : {}),
    };
  }

  public async readFiles(input: WorkspaceReadFilesInput): Promise<WorkspaceReadFilesResult> {
    const maxTotalBytes = normalizeLimit(input.maxTotalBytes, DEFAULT_MULTI_READ_MAX_BYTES, 2 * 1024 * 1024);
    const results: WorkspaceReadFileResult[] = [];
    let totalBytes = 0;
    let exhaustedBudget = false;
    let truncated = false;

    for (const request of input.requests) {
      const remainingBytes = maxTotalBytes - totalBytes;
      if (remainingBytes <= 0) {
        exhaustedBudget = true;
        truncated = true;
        break;
      }
      const result = await this.readFile({
        ...request,
        maxBytes: Math.min(
          request.maxBytes ?? DEFAULT_READ_MAX_BYTES,
          remainingBytes,
        ),
      });
      results.push(result);
      totalBytes += Buffer.byteLength(result.numberedContent, "utf8");
      if (result.truncated) {
        truncated = true;
      }
    }

    if (results.length < input.requests.length) {
      truncated = true;
    }

    return {
      results,
      truncated,
      exhaustedBudget,
      maxTotalBytes,
      totalBytes,
    };
  }

  private async inspectDirectory(
    directoryPath: string,
    options: { includeHidden: boolean; includeIgnored: boolean },
  ): Promise<DirectoryInspection> {
    const cacheKey = `${directoryPath}::${options.includeHidden ? "1" : "0"}::${options.includeIgnored ? "1" : "0"}`;
    const cached = this.directoryCache.get(cacheKey);
    if (cached) {
      return await cached;
    }

    const pending = (async () => {
      const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
        .map((entry) => ({
          name: entry.name,
          type: matchTypeFromDirent(entry),
        }))
        .sort(compareWorkspaceEntries);
      const visibility = options.includeIgnored
        ? undefined
        : await this.listDirectoryVisibility(directoryPath, options.includeHidden);
      const inspection: DirectoryInspection = {
        included: [],
        hiddenOmitted: [],
        ignoredOmitted: [],
      };

      for (const entry of entries) {
        if (entry.name === ".git") {
          inspection.ignoredOmitted.push(formatSampleEntry(entry.name, entry.type));
          continue;
        }

        if (!options.includeHidden && isHiddenName(entry.name)) {
          inspection.hiddenOmitted.push(formatSampleEntry(entry.name, entry.type));
          continue;
        }

        if (visibility?.visibleNames && !visibility.visibleNames.has(entry.name)) {
          inspection.ignoredOmitted.push(formatSampleEntry(entry.name, entry.type));
          continue;
        }

        if (visibility?.ignoredNames.has(entry.name)) {
          inspection.ignoredOmitted.push(formatSampleEntry(entry.name, entry.type));
          continue;
        }

        inspection.included.push(entry);
      }

      return inspection;
    })();

    this.directoryCache.set(cacheKey, pending);
    return await pending;
  }

  private async listDirectoryVisibility(
    directoryPath: string,
    includeHidden: boolean,
  ): Promise<DirectoryVisibility> {
    const fdPath = await resolveFdPath();
    if (!fdPath) {
      return await this.listDirectoryVisibilityWithRipgrep(directoryPath, includeHidden);
    }

    const visibleNames = new Set<string>();
    const args = [
      "--glob",
      "*",
      ".",
      "--max-depth",
      "1",
      "--min-depth",
      "1",
      "--strip-cwd-prefix",
      "--exclude",
      ".git",
    ];
    if (includeHidden) {
      args.push("--hidden");
    }

    const result = await spawnCollectLines({
      command: fdPath,
      args,
      cwd: directoryPath,
      signal: this.signal,
      onLine: (line) => {
        const normalized = stripTrailingSlash(toPosixPath(line.trim()));
        if (normalized.length === 0) {
          return true;
        }
        visibleNames.add(path.posix.basename(normalized));
        return true;
      },
    });

    if (result.exitCode !== 0) {
      return await this.listDirectoryVisibilityWithRipgrep(directoryPath, includeHidden);
    }
    return {
      visibleNames,
      ignoredNames: new Set<string>(),
    };
  }

  private async listDirectoryVisibilityWithRipgrep(
    directoryPath: string,
    includeHidden: boolean,
  ): Promise<DirectoryVisibility> {
    const visibleNames = await this.listImmediateNamesWithRipgrep(directoryPath, {
      includeHidden,
      includeIgnored: false,
    });
    const allNames = await this.listImmediateNamesWithRipgrep(directoryPath, {
      includeHidden,
      includeIgnored: true,
    });

    const ignoredNames = new Set<string>();
    for (const name of allNames) {
      if (!visibleNames.has(name)) {
        ignoredNames.add(name);
      }
    }

    return {
      ignoredNames,
    };
  }

  private async listImmediateNamesWithRipgrep(
    directoryPath: string,
    options: { includeHidden: boolean; includeIgnored: boolean },
  ): Promise<Set<string>> {
    const ripgrepPath = await resolveRipgrepPath();
    const names = new Set<string>();
    const args = [
      "--files",
      "--glob=!.git",
      "--glob=!**/.git/**",
    ];
    if (options.includeHidden) {
      args.push("--hidden");
    }
    if (options.includeIgnored) {
      args.push("--no-ignore");
    }
    args.push(directoryPath);

    const result = await spawnCollectLines({
      command: ripgrepPath,
      args,
      cwd: this.workingDirectory,
      signal: this.signal,
      onLine: (line) => {
        const normalized = toPosixPath(line.trim());
        if (normalized === "" || normalized === ".git" || normalized.startsWith(".git/")) {
          return true;
        }

        const absoluteCandidate = path.isAbsolute(normalized)
          ? normalized
          : path.resolve(this.workingDirectory, normalized);
        const relativeToDirectory = toPosixPath(path.relative(directoryPath, absoluteCandidate));
        if (
          relativeToDirectory === ""
          || relativeToDirectory === "."
          || relativeToDirectory.startsWith("../")
          || path.isAbsolute(relativeToDirectory)
        ) {
          return true;
        }

        const firstSegment = relativeToDirectory.split("/")[0];
        if (firstSegment && firstSegment !== ".git") {
          names.add(firstSegment);
        }
        return true;
      },
    });

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        result.stderr.trim() || "ripgrep file listing failed.",
      );
    }

    return names;
  }

  private async scanDescendantDirectoryHints(
    frontier: Array<{ absolutePath: string; relativePath: string }>,
    options: { includeHidden: boolean; includeIgnored: boolean },
  ): Promise<{
    hints: string[];
    hasMoreDescendantDirectories: boolean;
    budgetExceeded: boolean;
  }> {
    const hints: string[] = [];
    const seenHints = new Set<string>();
    const queue = [...frontier];
    let visitedEntries = 0;
    let hasMoreDescendantDirectories = false;

    while (queue.length > 0) {
      if (visitedEntries >= DEFAULT_LIST_DESCENDANT_SCAN_BUDGET) {
        return {
          hints,
          hasMoreDescendantDirectories: hasMoreDescendantDirectories || queue.length > 0,
          budgetExceeded: true,
        };
      }

      const current = queue.shift()!;
      const inspection = await this.inspectDirectory(current.absolutePath, options);
      for (const entry of inspection.included) {
        visitedEntries += 1;
        if (visitedEntries > DEFAULT_LIST_DESCENDANT_SCAN_BUDGET) {
          return {
            hints,
            hasMoreDescendantDirectories: true,
            budgetExceeded: true,
          };
        }

        if (entry.type !== "directory") {
          continue;
        }

        const relative = path.posix.join(current.relativePath, entry.name);
        if (!seenHints.has(relative)) {
          seenHints.add(relative);
          hasMoreDescendantDirectories = true;
          if (hints.length < DEFAULT_LIST_DESCENDANT_HINT_LIMIT) {
            hints.push(`${relative}/`);
          }
        }
        queue.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: relative,
        });
      }
    }

    return {
      hints,
      hasMoreDescendantDirectories,
      budgetExceeded: false,
    };
  }

  private async searchPathsByGlob(input: {
    basePath: string;
    glob: string;
    type: "any" | "file" | "directory";
    limit: number;
    includeHidden: boolean;
    includeIgnored: boolean;
  }): Promise<WorkspaceSearchPathMatch[]> {
    const fdPath = await resolveFdPath();
    if (fdPath) {
      const rawMatches: string[] = [];
      const args = [
        "--glob",
        input.glob,
        ".",
        "--strip-cwd-prefix",
        "--exclude",
        ".git",
      ];
      if (input.type === "file") {
        args.push("--type", "f");
      } else if (input.type === "directory") {
        args.push("--type", "d");
      }
      if (input.includeHidden) {
        args.push("--hidden");
      }
      if (input.includeIgnored) {
        args.push("--no-ignore");
      }

      await spawnCollectLines({
        command: fdPath,
        args,
        cwd: input.basePath,
        signal: this.signal,
        onLine: (line) => {
          const normalized = stripTrailingSlash(toPosixPath(line.trim()));
          if (normalized === ".git" || normalized.startsWith(".git/")) {
            return true;
          }
          rawMatches.push(normalized);
          return rawMatches.length <= input.limit;
        },
      }).catch(() => undefined);

      if (rawMatches.length > 0) {
        const matches = await Promise.all(rawMatches.map(async (candidate) => {
          const absoluteCandidate = path.join(input.basePath, candidate);
          const stat = await fs.stat(absoluteCandidate).catch(() => undefined);
          if (!stat) {
            return undefined;
          }
          return {
            path: workspaceRelativePath(this.workingDirectory, absoluteCandidate),
            type: stat.isDirectory() ? "directory" as const : "file" as const,
          };
        }));

        return matches
          .filter((entry): entry is WorkspaceSearchPathMatch => entry !== undefined)
          .sort((left, right) => left.path.localeCompare(right.path))
          .slice(0, input.limit + 1);
      }
    }

    const regex = buildGlobRegex(input.glob);
    const corpus = await this.buildPathCorpus({
      basePath: input.basePath,
      type: input.type,
      includeHidden: input.includeHidden,
      includeIgnored: input.includeIgnored,
    });
    return corpus.filter((entry) => regex.test(entry.path)).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async buildPathCorpus(input: {
    basePath: string;
    type: "any" | "file" | "directory";
    includeHidden: boolean;
    includeIgnored: boolean;
  }): Promise<WorkspaceSearchPathMatch[]> {
    const ripgrepPath = await resolveRipgrepPath();
    const files: string[] = [];
    const args = [
      "--files",
      "--glob=!.git",
      "--glob=!**/.git/**",
    ];
    if (input.includeHidden) {
      args.push("--hidden");
    }
    if (input.includeIgnored) {
      args.push("--no-ignore");
    }
    args.push(input.basePath);

    const result = await spawnCollectLines({
      command: ripgrepPath,
      args,
      cwd: this.workingDirectory,
      signal: this.signal,
      onLine: (line) => {
        const normalized = toPosixPath(line.trim());
        if (normalized === ".git" || normalized.startsWith(".git/")) {
          return true;
        }
        const absoluteCandidate = path.isAbsolute(normalized)
          ? normalized
          : path.resolve(this.workingDirectory, normalized);
        files.push(workspaceRelativePath(this.workingDirectory, absoluteCandidate));
        return true;
      },
    });

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        result.stderr.trim() || "ripgrep file listing failed.",
      );
    }

    const fileMatches = uniqueStrings(files).map((file) => ({
      path: file,
      type: "file" as const,
    }));

    const directoryMatches = uniqueStrings(
      fileMatches.flatMap((file) => {
        const directories: string[] = [];
        const parts = stripTrailingSlash(file.path).split("/");
        for (let index = 1; index < parts.length; index += 1) {
          const candidate = parts.slice(0, index).join("/");
          if (candidate.length > 0) {
            directories.push(candidate);
          }
        }
        return directories;
      }),
    ).map((directory) => ({
      path: directory,
      type: "directory" as const,
    }));

    if (input.type === "file") {
      return fileMatches;
    }
    if (input.type === "directory") {
      return directoryMatches;
    }
    return [...directoryMatches, ...fileMatches];
  }
}

export function createWorkspaceSearchBackend(options: {
  workingDirectory: string;
  signal?: AbortSignal;
}): WorkspaceSearchBackend {
  return new WorkspaceSearchBackend(options);
}

export function renderWorkspaceListTree(result: WorkspaceListTreeResult): string {
  const lines = [...result.entries];
  if (result.notes.length > 0) {
    lines.push("");
    lines.push(...result.notes.map((note) => `[list_tree note] ${note}`));
  }
  return lines.join("\n");
}

export function renderWorkspaceSearchPaths(result: WorkspaceSearchPathsResult): string {
  return formatSearchPathsOutput(result);
}

export function renderWorkspaceSearchText(result: WorkspaceSearchTextResult): string {
  return formatSearchTextOutput(result);
}

export function renderWorkspaceReadFile(result: WorkspaceReadFileResult): string {
  return formatReadOutput(result);
}

export function renderWorkspaceReadFiles(result: WorkspaceReadFilesResult): string {
  return formatReadFilesOutput(result);
}

export async function readUtf8TextFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  if (content.includes("\u0000")) {
    throw new GemmaDesktopError("tool_execution_failed", `Refusing to read binary-looking file: ${filePath}`);
  }
  return content;
}
