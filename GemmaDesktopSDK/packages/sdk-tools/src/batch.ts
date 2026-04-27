import path from "node:path";
import {
  createWorkspaceSearchBackend,
  type WorkspaceListTreeInput,
  type WorkspaceListTreeResult,
  type WorkspaceReadFileInput,
  type WorkspaceReadFileResult,
  type WorkspaceSearchPathsInput,
  type WorkspaceSearchPathsResult,
  type WorkspaceSearchTextInput,
  type WorkspaceSearchTextResult,
} from "./workspace.js";
import type { SearchExecutionResult, SearchWebInput, FetchExecutionResult, FetchUrlInput } from "./web.js";
import { executeFetchUrl, executeSearchWeb } from "./web.js";

export type { SearchExecutionResult, SearchWebInput, FetchExecutionResult, FetchUrlInput } from "./web.js";

export interface BatchTaskResult<TResult> {
  key: string;
  status: "fulfilled" | "rejected";
  result?: TResult;
  error?: string;
  dedupedFrom?: string;
}

export interface SearchWebBatchTask extends SearchWebInput {
  key?: string;
}

export interface FetchUrlBatchTask extends FetchUrlInput {
  key?: string;
}

export interface ListTreeBatchTask extends WorkspaceListTreeInput {
  key?: string;
}

export type ListTreeExecutionResult = WorkspaceListTreeResult;

export interface SearchPathsBatchTask extends WorkspaceSearchPathsInput {
  key?: string;
}

export type SearchPathsExecutionResult = WorkspaceSearchPathsResult;

export interface SearchTextBatchTask extends WorkspaceSearchTextInput {
  key?: string;
}

export type SearchTextExecutionResult = WorkspaceSearchTextResult;

export interface ReadFileBatchTask extends WorkspaceReadFileInput {
  key?: string;
}

export type ReadFileExecutionResult = WorkspaceReadFileResult;

export interface ParallelHostExecutorOptions {
  workingDirectory?: string;
  geminiApiKey?: string;
  geminiApiModel?: string;
  maxConcurrentWebSearches?: number;
  maxConcurrentWebFetches?: number;
  maxConcurrentWorkspaceReads?: number;
}

interface BatchRunOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function runWithConcurrency(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runnerCount = Math.min(Math.max(concurrency, 1), Math.max(count, 1));

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= count) {
          break;
        }
        await worker(currentIndex);
      }
    }),
  );
}

async function runBatch<TTask, TResult>(
  tasks: readonly TTask[],
  options: {
    concurrency: number;
    getKey: (task: TTask) => string;
    signal?: AbortSignal;
    execute: (task: TTask, signal?: AbortSignal) => Promise<TResult>;
  },
): Promise<Array<BatchTaskResult<TResult>>> {
  const uniqueTasks: TTask[] = [];
  const uniqueKeys: string[] = [];
  const keyToUniqueIndex = new Map<string, number>();

  tasks.forEach((task) => {
    const key = options.getKey(task);
    const existing = keyToUniqueIndex.get(key);
    if (existing !== undefined) {
      return;
    }
    keyToUniqueIndex.set(key, uniqueTasks.length);
    uniqueTasks.push(task);
    uniqueKeys.push(key);
  });

  const uniqueResults = new Array<BatchTaskResult<TResult>>(uniqueTasks.length);
  await runWithConcurrency(uniqueTasks.length, options.concurrency, async (index) => {
    const task = uniqueTasks[index];
    const key = uniqueKeys[index]!;
    try {
      uniqueResults[index] = {
        key,
        status: "fulfilled",
        result: await options.execute(task, options.signal),
      };
    } catch (error) {
      uniqueResults[index] = {
        key,
        status: "rejected",
        error: toErrorMessage(error),
      };
    }
  });

  const results = tasks.map((task) => {
    const key = options.getKey(task);
    const uniqueIndex = keyToUniqueIndex.get(key);
    const source = uniqueIndex !== undefined ? uniqueResults[uniqueIndex] : undefined;
    if (!source) {
      return {
        key,
        status: "rejected" as const,
        error: `No batch result was recorded for ${key}.`,
      };
    }
    return source;
  });

  const seenKeys = new Set<string>();
  return results.map((result) => {
    const firstSeen = seenKeys.has(result.key);
    seenKeys.add(result.key);
    if (!firstSeen) {
      return result;
    }
    return {
      ...result,
      dedupedFrom: result.key,
    };
  });
}

function keyForSearchTask(task: SearchWebBatchTask): string {
  return task.key ?? JSON.stringify({
    query: task.query,
    depth: task.depth ?? "standard",
    limit: task.limit,
    maxResults: task.maxResults,
    maxPages: task.maxPages,
    maxCharsPerPage: task.maxCharsPerPage,
    includeDomains: task.includeDomains ?? [],
    excludeDomains: task.excludeDomains ?? [],
  });
}

function keyForFetchTask(task: FetchUrlBatchTask): string {
  return task.key ?? task.url.trim();
}

function keyForListTreeTask(task: ListTreeBatchTask): string {
  return task.key ?? JSON.stringify({
    path: task.path ?? ".",
    depth: task.depth ?? null,
    includeHidden: task.includeHidden ?? false,
    includeIgnored: task.includeIgnored ?? false,
    limit: task.limit ?? null,
  });
}

function keyForSearchPathsTask(task: SearchPathsBatchTask): string {
  return task.key ?? JSON.stringify({
    path: task.path ?? ".",
    query: task.query ?? null,
    glob: task.glob ?? null,
    type: task.type ?? "any",
    limit: task.limit ?? null,
    includeHidden: task.includeHidden ?? false,
    includeIgnored: task.includeIgnored ?? false,
  });
}

function keyForSearchTextTask(task: SearchTextBatchTask): string {
  return task.key ?? JSON.stringify({
    query: task.query,
    path: task.path ?? ".",
    include: Array.isArray(task.include) ? task.include : task.include ? [task.include] : [],
    exclude: Array.isArray(task.exclude) ? task.exclude : task.exclude ? [task.exclude] : [],
    regex: task.regex ?? false,
    caseSensitive: task.caseSensitive ?? false,
    wholeWord: task.wholeWord ?? false,
    before: task.before ?? 0,
    after: task.after ?? 0,
    limit: task.limit ?? null,
    includeHidden: task.includeHidden ?? false,
    includeIgnored: task.includeIgnored ?? false,
  });
}

function keyForReadTask(task: ReadFileBatchTask): string {
  return task.key ?? JSON.stringify({
    path: task.path,
    offset: task.offset ?? null,
    limit: task.limit ?? null,
    maxBytes: task.maxBytes ?? null,
  });
}

export class ParallelHostExecutor {
  private readonly workingDirectory?: string;
  private readonly geminiApiKey?: string;
  private readonly geminiApiModel?: string;
  private readonly maxConcurrentWebSearches: number;
  private readonly maxConcurrentWebFetches: number;
  private readonly maxConcurrentWorkspaceReads: number;

  public constructor(options: ParallelHostExecutorOptions = {}) {
    this.workingDirectory = options.workingDirectory;
    this.geminiApiKey = options.geminiApiKey;
    this.geminiApiModel = options.geminiApiModel;
    this.maxConcurrentWebSearches = normalizeConcurrency(options.maxConcurrentWebSearches, 2);
    this.maxConcurrentWebFetches = normalizeConcurrency(options.maxConcurrentWebFetches, 6);
    this.maxConcurrentWorkspaceReads = normalizeConcurrency(options.maxConcurrentWorkspaceReads, 8);
  }

  public async searchWebBatch(
    tasks: readonly SearchWebBatchTask[],
    options: BatchRunOptions & {
      workingDirectory?: string;
      geminiApiKey?: string;
      geminiApiModel?: string;
    } = {},
  ): Promise<Array<BatchTaskResult<SearchExecutionResult>>> {
    const workingDirectory = options.workingDirectory ?? this.workingDirectory;
    const geminiApiKey = options.geminiApiKey ?? this.geminiApiKey;
    const geminiApiModel = options.geminiApiModel ?? this.geminiApiModel;
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWebSearches),
      getKey: keyForSearchTask,
      signal: options.signal,
      execute: async (task, signal) =>
        await executeSearchWeb(task, { signal, workingDirectory, geminiApiKey, geminiApiModel }),
    });
  }

  public async fetchUrlBatch(
    tasks: readonly FetchUrlBatchTask[],
    options: BatchRunOptions = {},
  ): Promise<Array<BatchTaskResult<FetchExecutionResult>>> {
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWebFetches),
      getKey: keyForFetchTask,
      signal: options.signal,
      execute: async (task, signal) => await executeFetchUrl(task, { signal }),
    });
  }

  public async listTreeBatch(
    tasks: readonly ListTreeBatchTask[],
    options: BatchRunOptions & { workingDirectory?: string } = {},
  ): Promise<Array<BatchTaskResult<ListTreeExecutionResult>>> {
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workingDirectory ?? process.cwd());
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWorkspaceReads),
      getKey: keyForListTreeTask,
      signal: options.signal,
      execute: async (task, signal) => {
        const backend = createWorkspaceSearchBackend({ workingDirectory, signal });
        return await backend.listTree(task);
      },
    });
  }

  public async searchPathsBatch(
    tasks: readonly SearchPathsBatchTask[],
    options: BatchRunOptions & { workingDirectory?: string } = {},
  ): Promise<Array<BatchTaskResult<SearchPathsExecutionResult>>> {
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workingDirectory ?? process.cwd());
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWorkspaceReads),
      getKey: keyForSearchPathsTask,
      signal: options.signal,
      execute: async (task, signal) => {
        const backend = createWorkspaceSearchBackend({ workingDirectory, signal });
        return await backend.searchPaths(task);
      },
    });
  }

  public async searchTextBatch(
    tasks: readonly SearchTextBatchTask[],
    options: BatchRunOptions & { workingDirectory?: string } = {},
  ): Promise<Array<BatchTaskResult<SearchTextExecutionResult>>> {
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workingDirectory ?? process.cwd());
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWorkspaceReads),
      getKey: keyForSearchTextTask,
      signal: options.signal,
      execute: async (task, signal) => {
        const backend = createWorkspaceSearchBackend({ workingDirectory, signal });
        return await backend.searchText(task);
      },
    });
  }

  public async readFileBatch(
    tasks: readonly ReadFileBatchTask[],
    options: BatchRunOptions & { workingDirectory?: string } = {},
  ): Promise<Array<BatchTaskResult<ReadFileExecutionResult>>> {
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workingDirectory ?? process.cwd());
    return await runBatch(tasks, {
      concurrency: normalizeConcurrency(options.concurrency, this.maxConcurrentWorkspaceReads),
      getKey: keyForReadTask,
      signal: options.signal,
      execute: async (task, signal) => {
        const backend = createWorkspaceSearchBackend({ workingDirectory, signal });
        return await backend.readFile(task);
      },
    });
  }
}
