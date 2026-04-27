import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";

const DEFAULT_OLLAMA_BASE_URL =
  process.env.GEMMA_DESKTOP_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const LIVE_MODEL_LOCK_DIRECTORY = path.join(
  os.tmpdir(),
  "gemma-desktop-ollama-live-model.lock",
);
const LIVE_MODEL_LOCK_OWNER_PATH = path.join(
  LIVE_MODEL_LOCK_DIRECTORY,
  "owner.json",
);
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

export interface LiveOllamaModelOptions {
  modelId: string;
  baseUrl?: string;
  allowDownload?: boolean;
  lockTimeoutMs?: number;
  requireExclusiveMachine?: boolean;
}

export interface LiveOllamaModelLease {
  baseUrl: string;
  modelId: string;
}

export function isOllamaLiveEnabled(flagName = "GEMMA_DESKTOP_RUN_OLLAMA_LIVE"): boolean {
  return process.env[flagName]?.trim() === "1";
}

export function resolveLiveOllamaBaseUrl(): string {
  return DEFAULT_OLLAMA_BASE_URL;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function formatLoadedInstances(
  instances: Array<{
    modelId: string;
    status: string;
  }>,
): string {
  if (instances.length === 0) {
    return "none";
  }
  return instances
    .map((instance) => `${instance.modelId}:${instance.status}`)
    .join(", ");
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
            "Timed out waiting for exclusive access to the Ollama live-model test lock.",
            `Lock directory: ${LIVE_MODEL_LOCK_DIRECTORY}`,
            `Current owner metadata: ${owner}`,
          ].join(" "),
        );
      }

      await sleep(1_000);
    }
  }
}

async function ensureModelAvailability(
  modelId: string,
  options: Required<Pick<LiveOllamaModelOptions, "allowDownload" | "requireExclusiveMachine">> & {
    baseUrl: string;
  },
): Promise<void> {
  const adapter = createOllamaNativeAdapter({ baseUrl: options.baseUrl });
  let inspection = await adapter.inspect();

  if (!inspection.installed) {
    throw new Error(
      `Ollama is not installed or not discoverable at ${options.baseUrl}.`,
    );
  }
  if (!inspection.reachable) {
    throw new Error(
      `Ollama is not reachable at ${options.baseUrl}. Start the Ollama server before running live tests.`,
    );
  }

  if (options.requireExclusiveMachine) {
    const loadedInstances = inspection.loadedInstances.filter(
      (instance) => instance.status !== "unloaded",
    );
    if (loadedInstances.length > 0) {
      if (!adapter.lifecycle?.unloadModel) {
        throw new Error(
          "Ollama adapter does not expose unloadModel lifecycle control for live-test preflight cleanup.",
        );
      }

      for (const instance of loadedInstances) {
        await adapter.lifecycle.unloadModel(instance.modelId);
      }

      inspection = await adapter.inspect();
      const remaining = inspection.loadedInstances.filter(
        (instance) => instance.status !== "unloaded",
      );
      if (remaining.length > 0) {
        throw new Error(
          [
            "Live-test preflight tried to clear resident Ollama models but some were still loaded.",
            `Remaining instances: ${formatLoadedInstances(remaining.map((instance) => ({ modelId: instance.modelId, status: instance.status })))}`,
          ].join(" "),
        );
      }
    }
  }

  const modelExists = inspection.models.some((model) => model.id === modelId);
  if (modelExists) {
    return;
  }

  if (!options.allowDownload) {
    throw new Error(
      [
        `Model "${modelId}" is not available in Ollama at ${options.baseUrl}.`,
        `Visible models: ${inspection.models.map((model) => model.id).join(", ") || "none"}.`,
        "Set GEMMA_DESKTOP_DOWNLOAD_LIVE_OLLAMA_MODELS=1 if you want the live helper to pull missing models automatically.",
      ].join(" "),
    );
  }

  if (!adapter.lifecycle?.downloadModel) {
    throw new Error("Ollama adapter does not expose downloadModel lifecycle control.");
  }

  await adapter.lifecycle.downloadModel(modelId);
  const refreshed = await adapter.inspect();
  if (!refreshed.models.some((model) => model.id === modelId)) {
    throw new Error(
      `Model "${modelId}" was still unavailable after attempting an Ollama download.`,
    );
  }
}

export async function withLoadedLiveOllamaModel<T>(
  options: LiveOllamaModelOptions,
  run: (lease: LiveOllamaModelLease) => Promise<T>,
): Promise<T> {
  const baseUrl = options.baseUrl ?? resolveLiveOllamaBaseUrl();
  const allowDownload =
    options.allowDownload ?? process.env.GEMMA_DESKTOP_DOWNLOAD_LIVE_OLLAMA_MODELS === "1";
  const requireExclusiveMachine = options.requireExclusiveMachine ?? true;
  const releaseLock = await acquireLiveModelLock(
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
  const adapter = createOllamaNativeAdapter({ baseUrl });

  if (!adapter.lifecycle?.loadModel || !adapter.lifecycle.unloadModel) {
    await releaseLock();
    throw new Error(
      "Ollama adapter does not expose the loadModel/unloadModel lifecycle controls required for live tests.",
    );
  }

  let result: T | undefined;
  let runError: unknown;
  let cleanupError: unknown;

  try {
    await ensureModelAvailability(options.modelId, {
      baseUrl,
      allowDownload,
      requireExclusiveMachine,
    });
    await adapter.lifecycle.loadModel(options.modelId);
    result = await run({
      baseUrl,
      modelId: options.modelId,
    });
  } catch (error) {
    runError = error;
  }

  try {
    await adapter.lifecycle.unloadModel(options.modelId);
    const inspection = await adapter.inspect();
    const stillLoaded = inspection.loadedInstances.some(
      (instance) =>
        instance.modelId === options.modelId && instance.status !== "unloaded",
    );
    if (stillLoaded) {
      throw new Error(
        `Model "${options.modelId}" still appeared loaded after unloadModel completed.`,
      );
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
      `Live Ollama test failed and cleanup also failed for model "${options.modelId}".`,
    );
  }
  if (runError) {
    throw runError instanceof Error ? runError : new Error(String(runError));
  }
  if (cleanupError) {
    throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  }

  return result as T;
}
