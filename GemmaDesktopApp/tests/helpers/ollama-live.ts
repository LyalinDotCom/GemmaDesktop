import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type {
  LoadedModelInstance,
  RuntimeAdapter,
  RuntimeInspectionResult,
} from "@gemma-desktop/sdk-core";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import {
  createLmStudioNativeAdapter,
  createLmStudioOpenAICompatibleAdapter,
} from "@gemma-desktop/sdk-runtime-lmstudio";
import { createOmlxOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-omlx";
import {
  createOllamaNativeAdapter,
  createOllamaOpenAICompatibleAdapter,
} from "@gemma-desktop/sdk-runtime-ollama";

const DEFAULT_RUNTIME_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  llamacpp: "http://127.0.0.1:8080",
  omlx: "http://127.0.0.1:8000",
} as const;
const LIVE_MODEL_LOCK_DIRECTORY = path.join(
  os.tmpdir(),
  "gemma-desktop-live-runtime-model.lock",
);
const LIVE_MODEL_LOCK_OWNER_PATH = path.join(
  LIVE_MODEL_LOCK_DIRECTORY,
  "owner.json",
);
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

export interface LiveRuntimeEndpoints {
  ollama: string;
  lmstudio: string;
  llamacpp: string;
  omlx: string;
}

export interface LiveRuntimeModelOptions {
  runtimeId: string;
  modelId: string;
  adapters?: RuntimeAdapter[];
  allowDownload?: boolean;
  lockTimeoutMs?: number;
  requireExclusiveMachine?: boolean;
  loadOptions?: Record<string, unknown>;
}

export interface LiveRuntimeModelLease {
  runtimeId: string;
  modelId: string;
  adapter: RuntimeAdapter;
  endpoint: string;
  inspection: RuntimeInspectionResult;
  lifecycleManaged: boolean;
}

export interface LiveOllamaModelOptions
  extends Omit<LiveRuntimeModelOptions, "runtimeId" | "adapters"> {
  baseUrl?: string;
}

export interface LiveOllamaModelLease {
  baseUrl: string;
  modelId: string;
}

export function isOllamaLiveEnabled(flagName = "GEMMA_DESKTOP_RUN_OLLAMA_LIVE"): boolean {
  return process.env[flagName]?.trim() === "1";
}

export function resolveLiveOllamaBaseUrl(): string {
  return resolveLiveRuntimeEndpoints().ollama;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveLiveRuntimeEndpoints(): LiveRuntimeEndpoints {
  return {
    ollama:
      envValue("GEMMA_DESKTOP_OLLAMA_BASE_URL", "GEMMA_DESKTOP_OLLAMA_ENDPOINT")
      ?? DEFAULT_RUNTIME_ENDPOINTS.ollama,
    lmstudio:
      envValue(
        "GEMMA_DESKTOP_LMSTUDIO_BASE_URL",
        "GEMMA_DESKTOP_LMSTUDIO_ENDPOINT",
        "GEMMA_DESKTOP_LM_STUDIO_BASE_URL",
        "GEMMA_DESKTOP_LM_STUDIO_ENDPOINT",
      ) ?? DEFAULT_RUNTIME_ENDPOINTS.lmstudio,
    llamacpp:
      envValue(
        "GEMMA_DESKTOP_LLAMACPP_BASE_URL",
        "GEMMA_DESKTOP_LLAMACPP_ENDPOINT",
        "GEMMA_DESKTOP_LLAMA_CPP_BASE_URL",
        "GEMMA_DESKTOP_LLAMA_CPP_ENDPOINT",
      ) ?? DEFAULT_RUNTIME_ENDPOINTS.llamacpp,
    omlx:
      envValue("GEMMA_DESKTOP_OMLX_BASE_URL", "GEMMA_DESKTOP_OMLX_ENDPOINT")
      ?? DEFAULT_RUNTIME_ENDPOINTS.omlx,
  };
}

export function createLiveRuntimeAdapters(): RuntimeAdapter[] {
  const endpoints = resolveLiveRuntimeEndpoints();
  return [
    createOllamaNativeAdapter({ baseUrl: endpoints.ollama }),
    createOllamaOpenAICompatibleAdapter({ baseUrl: endpoints.ollama }),
    createLmStudioNativeAdapter({
      baseUrl: endpoints.lmstudio,
      apiKey: envValue("GEMMA_DESKTOP_LMSTUDIO_API_KEY", "GEMMA_DESKTOP_LM_STUDIO_API_KEY"),
    }),
    createLmStudioOpenAICompatibleAdapter({
      baseUrl: endpoints.lmstudio,
      apiKey: envValue("GEMMA_DESKTOP_LMSTUDIO_API_KEY", "GEMMA_DESKTOP_LM_STUDIO_API_KEY"),
    }),
    createLlamaCppServerAdapter({
      baseUrl: endpoints.llamacpp,
      apiKey: envValue("GEMMA_DESKTOP_LLAMACPP_API_KEY", "GEMMA_DESKTOP_LLAMA_CPP_API_KEY"),
    }),
    createOmlxOpenAICompatibleAdapter({
      baseUrl: endpoints.omlx,
      apiKey: envValue("GEMMA_DESKTOP_OMLX_API_KEY", "OMLX_API_KEY"),
    }),
  ];
}

export function liveRuntimeCliEndpointArgs(): string[] {
  const endpoints = resolveLiveRuntimeEndpoints();
  const args = [
    "--ollama-endpoint",
    endpoints.ollama,
    "--lmstudio-endpoint",
    endpoints.lmstudio,
    "--llamacpp-endpoint",
    endpoints.llamacpp,
    "--omlx-endpoint",
    endpoints.omlx,
  ];
  const omlxApiKey = envValue("GEMMA_DESKTOP_OMLX_API_KEY", "OMLX_API_KEY");
  return omlxApiKey ? [...args, "--omlx-api-key", omlxApiKey] : args;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function activeLoadedInstances(inspection: RuntimeInspectionResult): LoadedModelInstance[] {
  return inspection.loadedInstances.filter((instance) => instance.status !== "unloaded");
}

function formatLoadedInstances(instances: LoadedModelInstance[]): string {
  if (instances.length === 0) {
    return "none";
  }
  return instances
    .map((instance) => `${instance.runtimeId}:${instance.id}:${instance.modelId}:${instance.status}`)
    .join(", ");
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  return new Error(fallbackMessage);
}

async function readLockOwnerSummary(): Promise<string> {
  try {
    const content = await readFile(LIVE_MODEL_LOCK_OWNER_PATH, "utf8");
    return content.trim();
  } catch {
    return "unavailable";
  }
}

async function acquireLiveModelLock(timeoutMs: number): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const ownerSummary = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    },
    null,
    2,
  );

  while (true) {
    try {
      await mkdir(LIVE_MODEL_LOCK_DIRECTORY);
      await writeFile(LIVE_MODEL_LOCK_OWNER_PATH, `${ownerSummary}\n`, "utf8");
      return async () => {
        await rm(LIVE_MODEL_LOCK_DIRECTORY, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const owner = await readLockOwnerSummary();
        throw new Error(
          [
            "Timed out waiting for exclusive access to the live-model test lock.",
            `Lock directory: ${LIVE_MODEL_LOCK_DIRECTORY}`,
            `Current owner metadata: ${owner}`,
          ].join(" "),
        );
      }

      await sleep(1_000);
    }
  }
}

function findAdapter(adapters: RuntimeAdapter[], runtimeId: string): RuntimeAdapter {
  const adapter = adapters.find((candidate) => candidate.identity.id === runtimeId);
  if (!adapter) {
    throw new Error(
      [
        `Unknown live-test runtime "${runtimeId}".`,
        `Available runtimes: ${adapters.map((candidate) => candidate.identity.id).join(", ") || "none"}.`,
      ].join(" "),
    );
  }
  return adapter;
}

function hasLifecycleControl(adapter: RuntimeAdapter): boolean {
  return Boolean(
    adapter.lifecycle
    && (
      "loadModel" in adapter.lifecycle
      || "unloadModel" in adapter.lifecycle
      || "downloadModel" in adapter.lifecycle
    ),
  );
}

function findLifecycleAdapter(adapters: RuntimeAdapter[], adapter: RuntimeAdapter): RuntimeAdapter {
  if (hasLifecycleControl(adapter)) {
    return adapter;
  }
  return adapters.find((candidate) =>
    candidate.identity.family === adapter.identity.family
    && hasLifecycleControl(candidate),
  ) ?? adapter;
}

function modelVisible(inspection: RuntimeInspectionResult, modelId: string): boolean {
  return (
    inspection.models.some((model) => model.id === modelId)
    || inspection.loadedInstances.some((instance) => instance.modelId === modelId)
  );
}

function loadResultIds(modelId: string, loadResult: Record<string, unknown> | undefined): Set<string> {
  const ids = new Set([modelId]);
  if (!loadResult) {
    return ids;
  }
  for (const key of ["id", "instance_id", "instanceId", "model", "model_id", "modelId"]) {
    const value = loadResult[key];
    if (typeof value === "string" && value.trim()) {
      ids.add(value.trim());
    }
  }
  return ids;
}

function instanceMatchesIds(instance: LoadedModelInstance, ids: Set<string>): boolean {
  return ids.has(instance.id) || ids.has(instance.modelId);
}

async function waitForInstancesToUnload(
  adapter: RuntimeAdapter,
  ids: Set<string>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastLoadedInstances: LoadedModelInstance[] = [];

  while (Date.now() < deadline) {
    const inspection = await adapter.inspect();
    lastLoadedInstances = activeLoadedInstances(inspection).filter((instance) =>
      instanceMatchesIds(instance, ids),
    );

    if (lastLoadedInstances.length === 0) {
      return;
    }

    await sleep(250);
  }

  throw new Error(
    [
      `Live-test runtime "${adapter.identity.id}" still reported matching loaded models after unload.`,
      `Remaining instances: ${formatLoadedInstances(lastLoadedInstances)}`,
    ].join(" "),
  );
}

async function unloadInstance(adapter: RuntimeAdapter, instance: LoadedModelInstance): Promise<void> {
  if (!adapter.lifecycle?.unloadModel) {
    throw new Error(
      `Runtime "${adapter.identity.id}" does not expose unloadModel lifecycle control.`,
    );
  }
  const ids = new Set([instance.id, instance.modelId]);
  await adapter.lifecycle.unloadModel(instance.id);
  await waitForInstancesToUnload(adapter, ids);
}

async function unloadLoadedInstances(adapter: RuntimeAdapter): Promise<void> {
  const inspection = await adapter.inspect();
  const loadedInstances = activeLoadedInstances(inspection);
  if (loadedInstances.length === 0) {
    return;
  }
  if (!adapter.lifecycle?.unloadModel) {
    throw new Error(
      [
        `Runtime "${adapter.identity.id}" has resident models but does not expose unloadModel lifecycle control.`,
        `Loaded instances: ${formatLoadedInstances(loadedInstances)}`,
      ].join(" "),
    );
  }

  for (const instance of loadedInstances) {
    await unloadInstance(adapter, instance);
  }

  const refreshed = await adapter.inspect();
  const remaining = activeLoadedInstances(refreshed);
  if (remaining.length > 0) {
    throw new Error(
      [
        `Live-test preflight tried to clear resident models from "${adapter.identity.id}" but some were still loaded.`,
        `Remaining instances: ${formatLoadedInstances(remaining)}`,
      ].join(" "),
    );
  }
}

async function ensureModelAvailability(
  adapter: RuntimeAdapter,
  modelId: string,
  allowDownload: boolean,
): Promise<RuntimeInspectionResult> {
  let inspection = await adapter.inspect();

  if (!inspection.installed) {
    throw new Error(
      `Runtime "${adapter.identity.id}" is not installed or not discoverable at ${adapter.identity.endpoint}.`,
    );
  }
  if (!inspection.reachable) {
    throw new Error(
      `Runtime "${adapter.identity.id}" is not reachable at ${adapter.identity.endpoint}. Start the provider before running live tests.`,
    );
  }

  if (modelVisible(inspection, modelId)) {
    return inspection;
  }

  if (allowDownload && adapter.lifecycle?.downloadModel) {
    await adapter.lifecycle.downloadModel(modelId);
    inspection = await adapter.inspect();
    if (modelVisible(inspection, modelId)) {
      return inspection;
    }
    throw new Error(
      `Model "${modelId}" was still unavailable on runtime "${adapter.identity.id}" after attempting a download.`,
    );
  }

  throw new Error(
    [
      `Model "${modelId}" is not available on runtime "${adapter.identity.id}" at ${adapter.identity.endpoint}.`,
      `Visible models: ${inspection.models.map((model) => model.id).join(", ") || "none"}.`,
      "Set GEMMA_DESKTOP_DOWNLOAD_LIVE_OLLAMA_MODELS=1 to let supported providers pull missing models automatically.",
    ].join(" "),
  );
}

async function ensureSelectedModelAvailability(
  adapter: RuntimeAdapter,
  lifecycleAdapter: RuntimeAdapter,
  modelId: string,
  allowDownload: boolean,
): Promise<RuntimeInspectionResult> {
  try {
    return await ensureModelAvailability(adapter, modelId, allowDownload);
  } catch (error) {
    if (lifecycleAdapter === adapter) {
      throw error;
    }
    await ensureModelAvailability(lifecycleAdapter, modelId, allowDownload);
    const inspection = await adapter.inspect();
    if (modelVisible(inspection, modelId)) {
      return inspection;
    }
    throw error;
  }
}

async function unloadTargetModel(
  adapter: RuntimeAdapter,
  modelId: string,
  loadResult: Record<string, unknown> | undefined,
): Promise<void> {
  if (!adapter.lifecycle?.unloadModel) {
    return;
  }

  const ids = loadResultIds(modelId, loadResult);
  const inspection = await adapter.inspect();
  const matching = activeLoadedInstances(inspection).filter((instance) =>
    instanceMatchesIds(instance, ids),
  );

  if (matching.length > 0) {
    for (const instance of matching) {
      await unloadInstance(adapter, instance);
    }
    return;
  }

  if (loadResult) {
    await adapter.lifecycle.unloadModel([...ids][0] ?? modelId);
    await waitForInstancesToUnload(adapter, ids);
  }
}

export async function withLiveRuntimeModel<T>(
  options: LiveRuntimeModelOptions,
  run: (lease: LiveRuntimeModelLease) => Promise<T>,
): Promise<T> {
  const adapters = options.adapters ?? createLiveRuntimeAdapters();
  const adapter = findAdapter(adapters, options.runtimeId);
  const lifecycleAdapter = findLifecycleAdapter(adapters, adapter);
  const allowDownload =
    options.allowDownload ?? process.env.GEMMA_DESKTOP_DOWNLOAD_LIVE_OLLAMA_MODELS === "1";
  const requireExclusiveMachine = options.requireExclusiveMachine ?? true;
  const releaseLock = await acquireLiveModelLock(
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );

  let result: T | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  let loadResult: Record<string, unknown> | undefined;

  try {
    if (requireExclusiveMachine) {
      await unloadLoadedInstances(lifecycleAdapter);
    }
    let inspection = await ensureSelectedModelAvailability(
      adapter,
      lifecycleAdapter,
      options.modelId,
      allowDownload,
    );
    if (lifecycleAdapter.lifecycle?.loadModel) {
      loadResult = await lifecycleAdapter.lifecycle.loadModel(options.modelId, options.loadOptions);
      inspection = await adapter.inspect();
    }
    result = await run({
      runtimeId: options.runtimeId,
      modelId: options.modelId,
      adapter,
      endpoint: adapter.identity.endpoint,
      inspection,
      lifecycleManaged: hasLifecycleControl(adapter),
    });
  } catch (error) {
    runError = error;
  }

  try {
    await unloadTargetModel(lifecycleAdapter, options.modelId, loadResult);
    if (requireExclusiveMachine) {
      await unloadLoadedInstances(lifecycleAdapter);
    }
  } catch (error) {
    cleanupError = error;
  }

  try {
    await releaseLock();
  } catch (error) {
    cleanupError ??= error;
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      `Live runtime test failed and cleanup also failed for "${options.runtimeId}:${options.modelId}".`,
    );
  }
  if (runError) {
    throw toError(runError, `Live runtime test failed for "${options.runtimeId}:${options.modelId}".`);
  }
  if (cleanupError) {
    throw toError(cleanupError, `Live runtime cleanup failed for "${options.runtimeId}:${options.modelId}".`);
  }

  return result as T;
}

export async function withLoadedLiveOllamaModel<T>(
  options: LiveOllamaModelOptions,
  run: (lease: LiveOllamaModelLease) => Promise<T>,
): Promise<T> {
  const adapter = createOllamaNativeAdapter({
    baseUrl: options.baseUrl ?? resolveLiveOllamaBaseUrl(),
  });
  return await withLiveRuntimeModel(
    {
      runtimeId: "ollama-native",
      modelId: options.modelId,
      adapters: [adapter],
      allowDownload: options.allowDownload,
      lockTimeoutMs: options.lockTimeoutMs,
      requireExclusiveMachine: options.requireExclusiveMachine,
      loadOptions: options.loadOptions,
    },
    async (lease) =>
      await run({
        baseUrl: lease.endpoint,
        modelId: lease.modelId,
      }),
  );
}
