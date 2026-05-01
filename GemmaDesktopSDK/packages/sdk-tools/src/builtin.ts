import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolExecutionContext } from "@gemma-desktop/sdk-core";
import { buildFileEditArtifact, buildLineDiff, FINALIZE_BUILD_TOOL_NAME, GemmaDesktopError, runShellCommand } from "@gemma-desktop/sdk-core";
import type { RegisteredTool } from "./runtime.js";
import {
  createWorkspaceSearchBackend,
  renderWorkspaceListTree,
  renderWorkspaceReadFile,
  renderWorkspaceReadFiles,
  renderWorkspaceSearchPaths,
  renderWorkspaceSearchText,
} from "./workspace.js";
import { executeFetchUrl, executeSearchWeb } from "./web.js";

const DEFAULT_OUTPUT_LIMIT = 12_000;
const EDIT_FILE_PREVIEW_LIMIT = 6_000;

function truncate(text: string, limit = DEFAULT_OUTPUT_LIMIT): { output: string; truncated: boolean } {
  if (text.length <= limit) {
    return {
      output: text,
      truncated: false,
    };
  }

  return {
    output:
      `${text.slice(0, limit)}\n\n`
      + `[WARNING] Gemma Desktop truncated this tool output after ${limit} characters and omitted ${text.length - limit} more. `
      + "Do not assume you saw the full result. Narrow the request or rerun a more targeted read/search before acting on it.",
    truncated: true,
  };
}

function formatShellCommandOutput(input: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
}): {
  output: string;
  metadata: Record<string, unknown>;
  structuredOutput: Record<string, unknown>;
} {
  const commandFailed = input.timedOut || input.exitCode !== 0;
  const merged = [input.stdout.trim(), input.stderr.trim()].filter(Boolean).join("\n");
  const failureLine = input.timedOut
    ? `Command timed out after ${input.timeoutMs}ms${input.exitCode == null ? "" : ` with exit code ${input.exitCode}`}.`
    : input.exitCode !== 0
    ? `Command failed with exit code ${input.exitCode}.`
    : undefined;
  const rawOutput = [
    failureLine,
    merged.length > 0 ? merged : "(no output)",
  ]
    .filter(Boolean)
    .join("\n");
  const { output, truncated } = truncate(rawOutput);

  return {
    output,
    structuredOutput: {
      ok: !commandFailed,
      command: input.command,
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
      timedOut: input.timedOut,
    },
    metadata: {
      truncated,
      ...(commandFailed
        ? {
            toolError: true,
            errorKind: input.timedOut ? "command_timed_out" : "nonzero_exit",
            exitCode: input.exitCode,
            timedOut: input.timedOut,
          }
        : {}),
    },
  };
}

function resolvePath(context: ToolExecutionContext, target = "."): string {
  return path.resolve(context.workingDirectory, target);
}

async function readUtf8File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  if (content.includes("\u0000")) {
    throw new GemmaDesktopError("tool_execution_failed", `Refusing to read binary-looking file: ${filePath}`);
  }
  return content;
}

function formatWriteFailureMessage(
  filePath: string,
  error: unknown,
  createDirectoriesRequested: boolean,
): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  if (code === "ENOENT") {
    return createDirectoriesRequested
      ? `Write failed for ${filePath}: the path could not be created or opened. Check the parent path and retry.`
      : `Write failed for ${filePath}: a parent directory does not exist. Retry with createDirectories=true or choose an existing path.`;
  }

  if (code === "EACCES" || code === "EPERM") {
    return `Write failed for ${filePath}: permission denied. Choose a writable path or adjust permissions before retrying.`;
  }

  if (code === "ENOTDIR" || code === "EEXIST") {
    return `Write failed for ${filePath}: a parent path is not a directory. Choose a valid file path and retry.`;
  }

  return error instanceof Error
    ? `Write failed for ${filePath}: ${error.message}`
    : `Write failed for ${filePath}.`;
}

async function createParentDirectoryForWrite(filePath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch (error) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      formatWriteFailureMessage(filePath, error, true),
    );
  }
}

async function writeOneVerifiedFile(input: {
  filePath: string;
  content: string;
}): Promise<{
  path: string;
  bytes: number;
  verified: true;
  edit?: ReturnType<typeof buildFileEditArtifact>;
  action: "Created" | "Overwrote";
}> {
  const before = await readDiffSourceFile(input.filePath);
  await createParentDirectoryForWrite(input.filePath);
  await writeUtf8FileAndVerify(input.filePath, input.content, {
    createDirectoriesRequested: true,
  });
  const edit =
    before.content !== undefined
      ? buildFileEditArtifact({
          path: input.filePath,
          beforeText: before.content,
          afterText: input.content,
          changeType: before.exists ? "edited" : "created",
        })
      : undefined;

  return {
    path: input.filePath,
    bytes: input.content.length,
    verified: true,
    ...(edit ? { edit } : {}),
    action: before.exists ? "Overwrote" : "Created",
  };
}

async function writeUtf8FileAndVerify(
  filePath: string,
  content: string,
  options?: { createDirectoriesRequested?: boolean },
): Promise<void> {
  const createDirectoriesRequested = options?.createDirectoriesRequested === true;

  try {
    await fs.writeFile(filePath, content, "utf8");
  } catch (error) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      formatWriteFailureMessage(filePath, error, createDirectoriesRequested),
    );
  }

  let verifiedContent: string;
  try {
    verifiedContent = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      error instanceof Error
        ? `Write to ${filePath} may not have completed: read-back verification failed with ${error.message}. Re-read the file before continuing.`
        : `Write to ${filePath} may not have completed: read-back verification failed. Re-read the file before continuing.`,
    );
  }

  if (verifiedContent !== content) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      `Write to ${filePath} failed verification: the content read back from disk did not match the requested write. Re-read the file before continuing.`,
    );
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function restorePreferredNewlines(text: string, newline: string): string {
  return newline === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function buildNumberedFileSnapshot(content: string): { output: string; truncated: boolean } {
  const numbered = content
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
  return truncate(numbered, EDIT_FILE_PREVIEW_LIMIT);
}

function workspaceDisplayPath(workingDirectory: string, filePath: string): string {
  const relative = path.relative(workingDirectory, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function countTextLines(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function normalizeToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeToolStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(normalizeToolString).filter((entry): entry is string => Boolean(entry)))];
}

function normalizeBuildValidationItems(value: unknown): Array<{
  command: string;
  status: "passed" | "failed" | "blocked";
  notes?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => {
      const command = normalizeToolString(entry.command);
      const status =
        entry.status === "passed" || entry.status === "failed" || entry.status === "blocked"
          ? entry.status
          : undefined;
      const notes = normalizeToolString(entry.notes);
      return command && status
        ? {
            command,
            status,
            ...(notes ? { notes } : {}),
          }
        : undefined;
    })
    .filter((entry): entry is { command: string; status: "passed" | "failed" | "blocked"; notes?: string } =>
      Boolean(entry)
    );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeContentArtifact(input: {
  filePath: string;
  content: string;
  createDirectories?: boolean;
  overwrite?: boolean;
}): Promise<void> {
  if (input.createDirectories) {
    await fs.mkdir(path.dirname(input.filePath), { recursive: true });
  }

  if (input.overwrite !== true && await pathExists(input.filePath)) {
    throw new GemmaDesktopError(
      "tool_execution_failed",
      `Refusing to overwrite existing content artifact: ${input.filePath}. Retry with overwrite=true if replacing it is intentional.`,
    );
  }

  await writeUtf8FileAndVerify(input.filePath, input.content, {
    createDirectoriesRequested: input.createDirectories,
  });
}

async function readDiffSourceFile(
  filePath: string,
): Promise<{ exists: boolean; content: string | null | undefined }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("\u0000")) {
      return {
        exists: true,
        content: undefined,
      };
    }
    return {
      exists: true,
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        exists: false,
        content: null,
      };
    }
    throw error;
  }
}

function matchesLinesAt(haystack: string[], start: number, needle: string[]): boolean {
  if (start + needle.length > haystack.length) {
    return false;
  }

  return needle.every((line, index) => haystack[start + index] === line);
}

function applyStaleEditPatch(current: string, oldText: string, newText: string): string | null {
  const currentLines = current.split("\n");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff = buildLineDiff(oldLines, newLines);
  const merged: string[] = [];
  let cursor = 0;

  for (let index = 0; index < diff.length; index += 1) {
    const chunk = diff[index]!;

    if (chunk.type === "equal") {
      if (!matchesLinesAt(currentLines, cursor, chunk.lines)) {
        return null;
      }
      merged.push(...chunk.lines);
      cursor += chunk.lines.length;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];

    while (index < diff.length && diff[index]!.type !== "equal") {
      const nextChunk = diff[index]!;
      if (nextChunk.type === "delete") {
        removed.push(...nextChunk.lines);
      } else if (nextChunk.type === "insert") {
        added.push(...nextChunk.lines);
      }
      index += 1;
    }
    index -= 1;

    if (removed.length > 0 && matchesLinesAt(currentLines, cursor, removed)) {
      cursor += removed.length;
      merged.push(...added);
      continue;
    }

    if (added.length > 0 && matchesLinesAt(currentLines, cursor, added)) {
      cursor += added.length;
      merged.push(...added);
      continue;
    }

    if (removed.length === 0) {
      merged.push(...added);
      continue;
    }

    if (added.length === 0) {
      continue;
    }

    return null;
  }

  if (cursor !== currentLines.length) {
    return null;
  }

  return merged.join("\n");
}

export function createHostTools(): RegisteredTool[] {
  return [
    {
      name: "list_tree",
      description:
        "Direct tool. Summary-first workspace browser for a nearby directory. It collapses obviously large or generated folders by default; use search_paths for recursive discovery deeper in the repo.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "integer", minimum: 0, maximum: 8 },
          includeHidden: { type: "boolean" },
          includeIgnored: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          path?: string;
          depth?: number;
          includeHidden?: boolean;
          includeIgnored?: boolean;
          limit?: number;
        },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.listTree(input);
        const rendered = renderWorkspaceListTree(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: result,
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "search_paths",
      description:
        "Direct tool. Repo-aware recursive path discovery. Use query for ranked name/path search, or glob for deterministic pattern matching when you know the path shape you want.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          glob: { type: "string" },
          path: { type: "string" },
          type: {
            type: "string",
            enum: ["any", "file", "directory"],
          },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          includeHidden: { type: "boolean" },
          includeIgnored: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          query?: string;
          glob?: string;
          path?: string;
          type?: "any" | "file" | "directory";
          limit?: number;
          includeHidden?: boolean;
          includeIgnored?: boolean;
        },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.searchPaths(input);
        const rendered = renderWorkspaceSearchPaths(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: result,
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "search_text",
      description:
        "Direct tool. Search file contents across the workspace with ripgrep. Literal search is the safe default; set regex=true only when you intentionally need regex behavior.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          include: {
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: { type: "string" },
              },
            ],
          },
          exclude: {
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: { type: "string" },
              },
            ],
          },
          regex: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          wholeWord: { type: "boolean" },
          before: { type: "integer", minimum: 0, maximum: 20 },
          after: { type: "integer", minimum: 0, maximum: 20 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          includeHidden: { type: "boolean" },
          includeIgnored: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
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
        },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.searchText(input);
        const rendered = renderWorkspaceSearchText(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: result,
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "read_file",
      description:
        "Direct tool. Read a known file with line-based pagination. If the tool says WARNING or the read starts after offset=1, you do not have the full file. Continue with offset or use search_text first for targeted lookup in large text files.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 10000 },
          maxBytes: { type: "integer", minimum: 256, maximum: 524288 },
        },
        additionalProperties: false,
      },
      async execute(
        input: { path: string; offset?: number; limit?: number; maxBytes?: number },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.readFile(input);
        const rendered = renderWorkspaceReadFile(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: result,
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "read_files",
      description:
        "Direct tool. Batch-read several known files in one call when you already have paths and want to inspect them together under a shared byte budget. If the tool says WARNING, at least one requested file was only partially read or the batch stopped early.",
      inputSchema: {
        type: "object",
        required: ["requests"],
        properties: {
          requests: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["path"],
              properties: {
                path: { type: "string" },
                offset: { type: "integer", minimum: 1 },
                limit: { type: "integer", minimum: 1, maximum: 10000 },
              },
              additionalProperties: false,
            },
          },
          maxTotalBytes: { type: "integer", minimum: 256, maximum: 2097152 },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          requests: Array<{ path: string; offset?: number; limit?: number }>;
          maxTotalBytes?: number;
        },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.readFiles(input);
        const rendered = renderWorkspaceReadFiles(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: result,
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "materialize_content",
      description:
        "Direct tool. Convert a known local source into an addressable text artifact without loading the whole artifact into model context. In the generic SDK host this supports text-like files; Gemma Desktop may add PDF, image OCR, and audio extraction.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          outputPath: { type: "string" },
          target: { type: "string", enum: ["auto", "text", "markdown"] },
          createDirectories: { type: "boolean" },
          overwrite: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          path: string;
          outputPath?: string;
          target?: "auto" | "text" | "markdown";
          createDirectories?: boolean;
          overwrite?: boolean;
        },
        context,
      ) {
        const sourcePath = resolvePath(context, input.path);
        const content = await readUtf8File(sourcePath);
        const outputPath = input.outputPath?.trim()
          ? resolvePath(context, input.outputPath)
          : undefined;

        if (outputPath) {
          await writeContentArtifact({
            filePath: outputPath,
            content,
            createDirectories: input.createDirectories,
            overwrite: input.overwrite,
          });
        }

        const artifactPath = outputPath ?? sourcePath;
        const lineCount = countTextLines(content);
        const bytes = Buffer.byteLength(content, "utf8");
        const displayArtifactPath = workspaceDisplayPath(context.workingDirectory, artifactPath);
        const output = [
          "Materialized content artifact.",
          `Source: ${workspaceDisplayPath(context.workingDirectory, sourcePath)}`,
          `Artifact path: ${displayArtifactPath}`,
          `Target: ${input.target ?? "auto"}`,
          "Strategy: direct_text",
          `Bytes: ${bytes}`,
          `Lines: ${lineCount}`,
          `Next: use read_content or search_content with path "${displayArtifactPath}".`,
        ].join("\n");

        return {
          output,
          structuredOutput: {
            artifactId: artifactPath,
            artifactPath,
            displayArtifactPath,
            sourcePath,
            displaySourcePath: workspaceDisplayPath(context.workingDirectory, sourcePath),
            outputPath,
            target: input.target ?? "auto",
            strategy: "direct_text",
            kind: "text",
            bytes,
            lineCount,
          },
        };
      },
    },
    {
      name: "read_content",
      description:
        "Direct tool. Read a materialized content artifact or text-like file with the same line-window pagination as read_file. Use this after materialize_content returns an artifact path.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 10000 },
          maxBytes: { type: "integer", minimum: 256, maximum: 524288 },
        },
        additionalProperties: false,
      },
      async execute(
        input: { path: string; offset?: number; limit?: number; maxBytes?: number },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.readFile(input);
        const rendered = renderWorkspaceReadFile(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: {
            ...result,
            artifactPath: result.absolutePath,
          },
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "search_content",
      description:
        "Direct tool. Search within one materialized content artifact or text-like file. Use this for large extracted artifacts before reading targeted windows.",
      inputSchema: {
        type: "object",
        required: ["path", "query"],
        properties: {
          path: { type: "string" },
          query: { type: "string" },
          regex: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          wholeWord: { type: "boolean" },
          before: { type: "integer", minimum: 0, maximum: 20 },
          after: { type: "integer", minimum: 0, maximum: 20 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          path: string;
          query: string;
          regex?: boolean;
          caseSensitive?: boolean;
          wholeWord?: boolean;
          before?: number;
          after?: number;
          limit?: number;
        },
        context,
      ) {
        const backend = createWorkspaceSearchBackend({
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });
        const result = await backend.searchText({
          ...input,
          includeHidden: true,
          includeIgnored: true,
        });
        const rendered = renderWorkspaceSearchText(result);
        const { output, truncated } = truncate(rendered);
        return {
          output,
          structuredOutput: {
            ...result,
            artifactPath: resolvePath(context, input.path),
          },
          metadata: { truncated: truncated || result.truncated },
        };
      },
    },
    {
      name: "write_file",
      description: "Direct tool. Write or overwrite a file when you already know the target path and contents, creating missing parent directories and verifying the write by reading the file back.",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createDirectories: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(input: { path: string; content: string; createDirectories?: boolean }, context) {
        const resolved = resolvePath(context, input.path);
        const write = await writeOneVerifiedFile({
          filePath: resolved,
          content: input.content,
        });
        return {
          output: `${write.action} and verified ${resolved} (${input.content.length} bytes).`,
          structuredOutput: {
            path: write.path,
            bytes: write.bytes,
            verified: write.verified,
            ...(write.edit ? { edit: write.edit } : {}),
          },
        };
      },
    },
    {
      name: "write_files",
      description: "Direct tool. Write or overwrite multiple complete files in one call when you already know their target paths and contents, creating missing parent directories and verifying every file by reading it back.",
      inputSchema: {
        type: "object",
        required: ["files"],
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(input: { files: Array<{ path: string; content: string }> }, context) {
        const files = [];
        for (const file of input.files) {
          const resolved = resolvePath(context, file.path);
          const write = await writeOneVerifiedFile({
            filePath: resolved,
            content: file.content,
          });
          files.push({
            path: write.path,
            bytes: write.bytes,
            verified: write.verified,
            ...(write.edit ? { edit: write.edit } : {}),
          });
        }

        return {
          output: [
            `Wrote and verified ${files.length} files.`,
            ...files.map((file) => `- ${file.path} (${file.bytes} bytes)`),
          ].join("\n"),
          structuredOutput: {
            files,
            count: files.length,
            verified: true,
          },
        };
      },
    },
    {
      name: "edit_file",
      description: "Direct tool. Edit a file by replacing exact text when you already know the path and the exact text to change, then verify the update by reading the file back.",
      inputSchema: {
        type: "object",
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(input: { path: string; oldText: string; newText: string; replaceAll?: boolean }, context) {
        const resolved = resolvePath(context, input.path);
        const content = await readUtf8File(resolved);
        const preferredNewline = content.includes("\r\n") ? "\r\n" : "\n";
        const normalizedContent = normalizeNewlines(content);
        const normalizedOldText = normalizeNewlines(input.oldText);
        const normalizedNewText = normalizeNewlines(input.newText);
        const occurrences = normalizedContent.split(normalizedOldText).length - 1;
        if (occurrences === 0) {
          if (normalizedContent === normalizedNewText) {
            const preview = buildNumberedFileSnapshot(content);
            return {
              output:
                `No changes needed; ${resolved} already matches the requested content.\n\n`
                + "Current file snapshot:\n"
                + preview.output,
              structuredOutput: {
                path: resolved,
                replacements: 0,
              },
              metadata: { truncated: preview.truncated },
            };
          }
          const patched = !input.replaceAll
            ? applyStaleEditPatch(
                normalizedContent,
                normalizedOldText,
                normalizedNewText,
              )
            : null;
          if (patched != null && patched !== normalizedContent) {
            const next = restorePreferredNewlines(patched, preferredNewline);
            await writeUtf8FileAndVerify(resolved, next);
            const preview = buildNumberedFileSnapshot(next);
            const edit = buildFileEditArtifact({
              path: resolved,
              beforeText: content,
              afterText: next,
              changeType: "edited",
            });
            return {
              output:
                `Verified update to ${resolved} by reconciling against the current file state.\n\n`
                + "Current file snapshot:\n"
                + preview.output,
              structuredOutput: {
                path: resolved,
                replacements: 1,
                bytes: next.length,
                reconciled: true,
                verified: true,
                ...(edit ? { edit } : {}),
              },
              metadata: { truncated: preview.truncated },
            };
          }
          const preview = buildNumberedFileSnapshot(content);
          return {
            output:
              `No changes applied; could not find target text in ${resolved}. `
              + "The file may have changed after a previous edit. Retry the edit using the refreshed snapshot below.\n\n"
              + "Current file snapshot:\n"
              + preview.output,
            structuredOutput: {
              path: resolved,
              replacements: 0,
              staleTarget: true,
            },
            metadata: { truncated: preview.truncated },
          };
        }
        if (occurrences > 1 && !input.replaceAll) {
          throw new GemmaDesktopError(
            "tool_execution_failed",
            `Found ${occurrences} matches in ${resolved}; set replaceAll to true or provide a more specific oldText.`,
          );
        }
        const nextNormalized = input.replaceAll
          ? normalizedContent.split(normalizedOldText).join(normalizedNewText)
          : normalizedContent.replace(normalizedOldText, normalizedNewText);
        const next = restorePreferredNewlines(nextNormalized, preferredNewline);
        await writeUtf8FileAndVerify(resolved, next);
        const preview = buildNumberedFileSnapshot(next);
        const edit = buildFileEditArtifact({
          path: resolved,
          beforeText: content,
          afterText: next,
          changeType: "edited",
        });
        return {
          output:
            `Verified update to ${resolved} (${occurrences} replacement${occurrences === 1 ? "" : "s"})\n\n`
            + "Current file snapshot:\n"
            + preview.output,
          structuredOutput: {
            path: resolved,
            replacements: input.replaceAll ? occurrences : 1,
            bytes: next.length,
            verified: true,
            ...(edit ? { edit } : {}),
          },
          metadata: { truncated: preview.truncated },
        };
      },
    },
    {
      name: "exec_command",
      description: "Direct tool. Run a shell command inside the workspace when you already know the exact command to execute.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
        },
        additionalProperties: false,
      },
      async execute(input: { command: string; cwd?: string; timeoutMs?: number }, context) {
        const timeoutMs = input.timeoutMs ?? 30_000;
        const result = await runShellCommand(input.command, {
          cwd: resolvePath(context, input.cwd),
          signal: context.signal,
          timeoutMs,
        });
        const formatted = formatShellCommandOutput({
          ...result,
          timeoutMs,
        });
        return {
          output: formatted.output,
          structuredOutput: formatted.structuredOutput,
          metadata: formatted.metadata,
        };
      },
    },
    {
      name: FINALIZE_BUILD_TOOL_NAME,
      description:
        "Direct tool. Record completion evidence for Build/ACT work after implementation and verification are done. This does not edit files; it tells the harness what artifacts changed, what validation passed, and how the result matches the user's request.",
      inputSchema: {
        type: "object",
        required: ["summary", "artifacts", "validation", "instructionChecklist"],
        properties: {
          summary: { type: "string" },
          artifacts: {
            type: "array",
            items: { type: "string" },
          },
          validation: {
            type: "array",
            items: {
              type: "object",
              required: ["command", "status"],
              properties: {
                command: { type: "string" },
                status: { type: "string", enum: ["passed", "failed", "blocked"] },
                notes: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          localUrl: { type: "string" },
          browserVerified: { type: "boolean" },
          instructionChecklist: {
            type: "array",
            items: { type: "string" },
          },
          blockers: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      async execute(input: unknown) {
        const record =
          input && typeof input === "object" && !Array.isArray(input)
            ? input as Record<string, unknown>
            : {};
        const summary = normalizeToolString(record.summary) ?? "";
        const artifacts = normalizeToolStringArray(record.artifacts);
        const validation = normalizeBuildValidationItems(record.validation);
        const localUrl = normalizeToolString(record.localUrl);
        const instructionChecklist = normalizeToolStringArray(record.instructionChecklist);
        const blockers = normalizeToolStringArray(record.blockers);
        const browserVerified =
          typeof record.browserVerified === "boolean" ? record.browserVerified : undefined;

        return {
          output: [
            "Recorded build completion evidence.",
            summary ? `Summary: ${summary}` : undefined,
            artifacts.length > 0 ? `Artifacts: ${artifacts.join(", ")}` : undefined,
            validation.length > 0
              ? `Validation: ${validation.map((item) => `${item.command} (${item.status})`).join(", ")}`
              : undefined,
            localUrl ? `Local URL: ${localUrl}` : undefined,
            blockers.length > 0 ? `Blockers: ${blockers.join("; ")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          structuredOutput: {
            summary,
            artifacts,
            validation,
            ...(localUrl ? { localUrl } : {}),
            ...(browserVerified !== undefined ? { browserVerified } : {}),
            instructionChecklist,
            blockers,
          },
        };
      },
    },
    {
      name: "fetch_url",
      description:
        "Direct tool. Fetch one known public URL with browser-like request headers and extract readable text from HTML, RSS/Atom feeds, JSON, or plain text. Use this for readable pages or endpoints that do not require clicks, typing, login, or JavaScript-driven interaction. If the result is mostly loaders, placeholders, or a thin shell, switch to browser instead of retrying the same fetch pattern.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          maxChars: { type: "integer", minimum: 100, maximum: 50000 },
        },
        additionalProperties: false,
      },
      async execute(input: { url: string; maxChars?: number }, context) {
        const result = await executeFetchUrl(input, {
          signal: context.signal,
          emitProgress: context.emitProgress,
        });
        return {
          output: result.output,
          structuredOutput: result.structuredOutput,
          metadata: result.metadata,
        };
      },
    },
    {
      name: "fetch_url_safe",
      description:
        "Direct tool. Fetch one public URL like fetch_url, but return a structured failure record instead of aborting the turn when the request fails.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          maxChars: { type: "integer", minimum: 100, maximum: 50000 },
        },
        additionalProperties: false,
      },
      async execute(input: { url: string; maxChars?: number }, context) {
        try {
          const result = await executeFetchUrl(input, {
            signal: context.signal,
            emitProgress: context.emitProgress,
          });
          return {
            output: result.output,
            structuredOutput: {
              ok: true,
              ...result.structuredOutput,
            },
            metadata: result.metadata,
          };
        } catch (error) {
          const gemmaDesktopError =
            error instanceof GemmaDesktopError
              ? error
              : new GemmaDesktopError("tool_execution_failed", `Failed to fetch ${input.url}.`, {
                  cause: error,
                });
          return {
            output: gemmaDesktopError.message,
            structuredOutput: {
              ok: false,
              requestedUrl: input.url,
              error: gemmaDesktopError.message,
            },
            metadata: {
              toolError: true,
              errorKind: gemmaDesktopError.kind,
            },
          };
        }
      },
    },
    {
      name: "search_web",
      description:
        "Direct tool. Run a Gemini API search with Google Search grounding for discovery. Use it when you do not yet know the right source, URL, or site. quick returns snippets only, standard fetches top pages, and deep asks Gemini for grounded search results before fetching the strongest sources. If the user already named a specific site, tracker, or live status page, prefer browser or fetch_url instead of repeating generic search. If one generic search already failed to surface a named site's live data, do not keep broadening the query; switch to the site itself with browser.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          depth: { type: "string", enum: ["quick", "standard", "deep"] },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          maxResults: { type: "integer", minimum: 1, maximum: 20 },
          maxPages: { type: "integer", minimum: 1, maximum: 8 },
          maxCharsPerPage: { type: "integer", minimum: 100, maximum: 50000 },
          includeDomains: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
          },
          excludeDomains: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
          },
        },
        additionalProperties: false,
      },
      async execute(
        input: {
          query: string;
          depth?: "quick" | "standard" | "deep";
          limit?: number;
          maxResults?: number;
          maxPages?: number;
          maxCharsPerPage?: number;
          includeDomains?: string[];
          excludeDomains?: string[];
        },
        context,
      ) {
        const results = await executeSearchWeb(input, {
          signal: context.signal,
          emitProgress: context.emitProgress,
          workingDirectory: context.workingDirectory,
          geminiApiKey: context.geminiApiKey,
          geminiApiModel: context.geminiApiModel,
        });
        return {
          output: results.output,
          structuredOutput: results.structuredOutput,
          metadata: results.metadata,
        };
      },
    },
  ];
}
