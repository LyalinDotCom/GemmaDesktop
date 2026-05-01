import os from "node:os";
import type { RuntimeAdapter } from "@gemma-desktop/sdk-core";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createLmStudioNativeAdapter, createLmStudioOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createOmlxOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-omlx";
import { createOllamaNativeAdapter, createOllamaOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-ollama";

export const DESKTOP_PARITY_DEFAULT_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  llamacpp: "http://127.0.0.1:8080",
  omlx: "http://127.0.0.1:8000",
} as const;

export const DESKTOP_PARITY_RUNTIME_ADAPTER_IDS = [
  "ollama-native",
  "ollama-openai",
  "lmstudio-native",
  "lmstudio-openai",
  "llamacpp-server",
  "omlx-openai",
] as const;

export const DEFAULT_PRIMARY_RUNTIME_ID = "ollama-native";
export const LOW_MEMORY_DEFAULT_PRIMARY_MODEL_ID = "gemma4:26b";
export const HIGH_MEMORY_DEFAULT_PRIMARY_MODEL_ID = "gemma4:31b";
export const DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES = 32 * 1024 ** 3;

export interface DesktopParityRuntimeEndpoints {
  ollama?: string;
  lmstudio?: string;
  llamacpp?: string;
  omlx?: string;
}

export interface DesktopParityRuntimeOptions {
  omlxApiKey?: string;
  ollamaResponseHeaderTimeoutMs?: number;
  ollamaStreamIdleTimeoutMs?: number;
}

export interface ModelTarget {
  runtimeId: string;
  modelId: string;
}

export function resolveDesktopParityEndpoints(
  endpoints: DesktopParityRuntimeEndpoints = {},
): Required<DesktopParityRuntimeEndpoints> {
  return {
    ollama: endpoints.ollama?.trim() || DESKTOP_PARITY_DEFAULT_ENDPOINTS.ollama,
    lmstudio: endpoints.lmstudio?.trim() || DESKTOP_PARITY_DEFAULT_ENDPOINTS.lmstudio,
    llamacpp: endpoints.llamacpp?.trim() || DESKTOP_PARITY_DEFAULT_ENDPOINTS.llamacpp,
    omlx: endpoints.omlx?.trim() || DESKTOP_PARITY_DEFAULT_ENDPOINTS.omlx,
  };
}

export function createDesktopParityRuntimeAdapters(
  endpoints: DesktopParityRuntimeEndpoints = {},
  options: DesktopParityRuntimeOptions = {},
): RuntimeAdapter[] {
  const resolved = resolveDesktopParityEndpoints(endpoints);
  const omlxApiKey = options.omlxApiKey?.trim() || undefined;
  return [
    createOllamaNativeAdapter({
      baseUrl: resolved.ollama,
      ...(options.ollamaResponseHeaderTimeoutMs != null
        ? { responseHeaderTimeoutMs: options.ollamaResponseHeaderTimeoutMs }
        : {}),
      ...(options.ollamaStreamIdleTimeoutMs != null
        ? { streamIdleTimeoutMs: options.ollamaStreamIdleTimeoutMs }
        : {}),
    }),
    createOllamaOpenAICompatibleAdapter({
      baseUrl: resolved.ollama,
    }),
    createLmStudioNativeAdapter({
      baseUrl: resolved.lmstudio,
    }),
    createLmStudioOpenAICompatibleAdapter({
      baseUrl: resolved.lmstudio,
    }),
    createLlamaCppServerAdapter({
      baseUrl: resolved.llamacpp,
    }),
    createOmlxOpenAICompatibleAdapter({
      baseUrl: resolved.omlx,
      apiKey: omlxApiKey,
    }),
  ];
}

export function resolveDefaultPrimaryModelIdForMemory(
  totalMemoryBytes: number,
): string {
  if (
    !Number.isFinite(totalMemoryBytes)
    || totalMemoryBytes <= DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES
  ) {
    return LOW_MEMORY_DEFAULT_PRIMARY_MODEL_ID;
  }

  return HIGH_MEMORY_DEFAULT_PRIMARY_MODEL_ID;
}

export function resolveDefaultModelTarget(
  totalMemoryBytes = os.totalmem(),
): ModelTarget {
  return {
    runtimeId: DEFAULT_PRIMARY_RUNTIME_ID,
    modelId: resolveDefaultPrimaryModelIdForMemory(totalMemoryBytes),
  };
}

export function describeDesktopParityRuntimeConfig(
  endpoints: DesktopParityRuntimeEndpoints = {},
): {
  endpoints: Required<DesktopParityRuntimeEndpoints>;
  adapterIds: string[];
} {
  return {
    endpoints: resolveDesktopParityEndpoints(endpoints),
    adapterIds: [...DESKTOP_PARITY_RUNTIME_ADAPTER_IDS],
  };
}
