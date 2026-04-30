import os from 'os'
import type { CapabilityRecord } from '@gemma-desktop/sdk-core'
import {
  createLlamaCppServerAdapter,
} from '@gemma-desktop/sdk-runtime-llamacpp'
import {
  createLmStudioNativeAdapter,
  createLmStudioOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-lmstudio'
import {
  createOmlxOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-omlx'
import {
  createOllamaNativeAdapter,
  createOllamaOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-ollama'
import {
  buildLmStudioRequestOptionsRecord,
  resolveManagedLmStudioProfile,
  type AppLmStudioSettings,
} from '../shared/lmstudioRuntimeConfig'
import {
  buildOllamaOptionsRecord,
  resolveManagedOllamaProfile,
  type AppOllamaSettings,
} from '../shared/ollamaRuntimeConfig'
import {
  buildOmlxDisplayOptionsRecord,
  resolveManagedOmlxProfile,
  type AppOmlxSettings,
} from '../shared/omlxRuntimeConfig'
import { deriveAttachmentSupport } from '../shared/attachmentSupport'

export interface RuntimeAdapterSettings {
  runtimes: {
    ollama: { endpoint: string }
    lmstudio: { endpoint: string }
    llamacpp: { endpoint: string }
    omlx: { endpoint: string; apiKey: string }
  }
}

export interface ModelMappingSettings {
  ollama: AppOllamaSettings
  lmstudio: AppLmStudioSettings
  omlx: AppOmlxSettings
}

export interface PendingModelTarget {
  modelId: string
  runtimeId: string
}

export type MappedRuntimeSummary = {
  id: string
  name: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
}

export type MappedModelRuntimeConfig = {
  provider: 'ollama' | 'lmstudio' | 'omlx'
  baseParameters?: Record<string, unknown>
  baseParametersText?: string
  requestedOptions?: Record<string, number>
  loadedOptions?: Record<string, unknown>
  nominalContextLength?: number
  loadedContextLength?: number
  approxGpuResidencyPercent?: number
}

export type MappedModelSummary = {
  id: string
  name: string
  runtimeId: string
  runtimeName: string
  parameterCount?: string
  quantization?: string
  contextLength?: number
  optimizationTags?: string[]
  status: 'loaded' | 'available' | 'loading'
  attachmentSupport: ReturnType<typeof deriveAttachmentSupport>
  runtimeConfig?: MappedModelRuntimeConfig
}

function sanitizeVersion(raw?: string): string | undefined {
  if (!raw) return undefined
  const clean = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
  const match = /(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/.exec(clean)
  return match ? match[1] : clean.trim().slice(0, 20) || undefined
}

export function mapRuntimes(
  inspectionResults: Array<{
    runtime: { id: string; displayName: string; endpoint: string }
    healthy: boolean
    reachable: boolean
    installed: boolean
    version?: string
  }>,
): MappedRuntimeSummary[] {
  return inspectionResults.map((r) => ({
    id: r.runtime.id,
    name: r.runtime.displayName,
    status: r.healthy ? 'running' : r.installed ? 'stopped' : 'not_installed',
    version: sanitizeVersion(r.version),
  }))
}

function coerceNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number') {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

function normalizeNumericRecord(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === 'number' && Number.isFinite(entry),
  )
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined
}

function computeApproxGpuResidencyPercent(
  config: Record<string, unknown>,
): number | undefined {
  const size = coerceNumber(config.size)
  const sizeVram = coerceNumber(config.sizeVram, config.size_vram)
  if (!size || !sizeVram || size <= 0) {
    return undefined
  }

  return Math.max(0, Math.min(100, Math.round((sizeVram / size) * 100)))
}

const MLX_OPTIMIZATION_TOKEN = /(?:^|[^a-z0-9])mlx(?:[^a-z0-9]|$)/i

function valueHasMlxOptimizationHint(value: unknown): boolean {
  if (typeof value === 'string') {
    return MLX_OPTIMIZATION_TOKEN.test(value)
  }

  if (Array.isArray(value)) {
    return value.some(valueHasMlxOptimizationHint)
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(valueHasMlxOptimizationHint)
  }

  return false
}

function deriveOptimizationTags(input: {
  runtimeId: string
  modelId: string
  displayName: string
  metadata: Record<string, unknown>
}): string[] | undefined {
  const tags = new Set<string>()

  if (input.runtimeId === 'omlx-openai') {
    tags.add('MLX')
  }

  const metadata = input.metadata
  const candidates = [
    input.modelId,
    input.displayName,
    metadata.format,
    metadata.modelFormat,
    metadata.model_format,
    metadata.optimizedFor,
    metadata.optimized_for,
    metadata.optimization,
    metadata.optimizations,
    metadata.accelerator,
    metadata.accelerators,
    metadata.engineType,
    metadata.engine_type,
    metadata.modelType,
    metadata.model_type,
    metadata.modelPath,
    metadata.model_path,
    metadata.sourceId,
    metadata.publisher,
    metadata.description,
  ]

  if (candidates.some(valueHasMlxOptimizationHint)) {
    tags.add('MLX')
  }

  return tags.size > 0 ? [...tags] : undefined
}

function modelTargetKey(target: PendingModelTarget): string {
  return `${target.runtimeId}:${target.modelId}`
}

export function createConfiguredRuntimeAdapters(currentSettings: RuntimeAdapterSettings) {
  return [
    createOllamaNativeAdapter({
      baseUrl: currentSettings.runtimes.ollama.endpoint,
    }),
    createOllamaOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.ollama.endpoint,
    }),
    createLmStudioNativeAdapter({
      baseUrl: currentSettings.runtimes.lmstudio.endpoint,
    }),
    createLmStudioOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.lmstudio.endpoint,
    }),
    createLlamaCppServerAdapter({
      baseUrl: currentSettings.runtimes.llamacpp.endpoint,
    }),
    createOmlxOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.omlx.endpoint,
      apiKey: currentSettings.runtimes.omlx.apiKey.trim() || undefined,
    }),
  ]
}

export function mapModels(
  inspectionResults: Array<{
    runtime: { id: string; displayName: string }
    models: Array<{
      id: string
      runtimeId: string
      kind: string
      metadata: Record<string, unknown>
      capabilities: Array<{ id: string; status: string; scope?: string; source?: string }>
    }>
    loadedInstances: Array<{ modelId: string; status: string }>
  }>,
  currentSettings: ModelMappingSettings | null | undefined,
  pendingLoadTargets: PendingModelTarget[],
): MappedModelSummary[] {
  const models: MappedModelSummary[] = []
  const pendingLoadKeys = new Set(pendingLoadTargets.map(modelTargetKey))
  const mappedKeys = new Set<string>()

  for (const rt of inspectionResults) {
    const loadedInstancesByModel = new Map(
      rt.loadedInstances.map((instance) => [instance.modelId, instance]),
    )
    const loadedIds = new Set(
      rt.loadedInstances
        .filter((i) => i.status === 'loaded' || i.status === 'loading')
        .map((i) => i.modelId),
    )
    const loadingIds = new Set(
      rt.loadedInstances
        .filter((i) => i.status === 'loading')
        .map((i) => i.modelId),
    )

    for (const m of rt.models) {
      if (m.kind === 'embedding') continue

      const meta = m.metadata as Record<string, unknown>
      const loadedInstance = loadedInstancesByModel.get(m.id) as
        | { config?: Record<string, unknown> }
        | undefined
      const loadedConfig =
        loadedInstance && typeof loadedInstance.config === 'object'
          ? (loadedInstance.config as Record<string, unknown>)
          : {}

      let quantization: string | undefined
      if (meta.quantization != null) {
        quantization = typeof meta.quantization === 'object'
          ? (meta.quantization as Record<string, unknown>).name as string
          : String(meta.quantization)
      }

      let parameterCount: string | undefined
      const rawParameterCount =
        meta.parameterCount
        ?? meta.paramsString
        ?? meta.params_string
      if (rawParameterCount != null) {
        parameterCount = typeof rawParameterCount === 'object'
          ? JSON.stringify(rawParameterCount)
          : String(rawParameterCount)
      }

      const contextLength = coerceNumber(
        loadedConfig.context_length,
        loadedConfig.num_ctx,
        meta.contextLength,
        meta.contextWindow,
        meta.context_size,
        meta.num_ctx,
        meta.maxContextLength,
        meta.max_context_length,
      )
      const nominalContextLength = coerceNumber(
        meta.contextLength,
        meta.contextWindow,
        meta.context_size,
        meta.num_ctx,
        meta.maxContextLength,
        meta.max_context_length,
        meta.maxContextWindow,
        meta.max_context_window,
        meta.maxTokens,
        meta.max_tokens,
      )
      const loadedContextLength = coerceNumber(
        loadedConfig.context_length,
        loadedConfig.num_ctx,
        loadedConfig.maxContextWindow,
        loadedConfig.max_context_window,
        loadedConfig.maxTokens,
        loadedConfig.max_tokens,
      )

      let displayName = m.id
      if (meta.displayName != null) {
        displayName = typeof meta.displayName === 'string' ? meta.displayName : m.id
      } else if (meta.display_name != null) {
        displayName = typeof meta.display_name === 'string' ? meta.display_name : m.id
      } else if (meta.name != null) {
        displayName = typeof meta.name === 'string' ? meta.name : m.id
      }

      const ollamaRequestedOptions = currentSettings
        ? buildOllamaOptionsRecord(
            resolveManagedOllamaProfile(
              currentSettings.ollama,
              m.id,
              m.runtimeId,
            ),
          )
        : undefined
      const lmstudioRequestedOptions = currentSettings
        ? buildLmStudioRequestOptionsRecord(
            resolveManagedLmStudioProfile(
              currentSettings.lmstudio,
              m.id,
              m.runtimeId,
              displayName,
              os.totalmem(),
            ),
          )
        : undefined
      const omlxRequestedOptions = currentSettings
        ? buildOmlxDisplayOptionsRecord(
            resolveManagedOmlxProfile(
              currentSettings.omlx,
              m.id,
              m.runtimeId,
              displayName,
              os.totalmem(),
            ),
          )
        : undefined
      const runtimeConfig =
        m.runtimeId === 'ollama-native' || m.runtimeId === 'ollama-openai'
          ? {
              provider: 'ollama' as const,
              baseParameters: normalizeNumericRecord(meta.parameters),
              baseParametersText:
                typeof meta.parametersText === 'string'
                  ? meta.parametersText
                  : typeof meta.parameters === 'string'
                    ? meta.parameters
                    : undefined,
              requestedOptions: ollamaRequestedOptions,
              loadedOptions:
                Object.keys(loadedConfig).length > 0
                  ? loadedConfig
                  : undefined,
              nominalContextLength,
              loadedContextLength,
              approxGpuResidencyPercent: computeApproxGpuResidencyPercent(loadedConfig),
            }
          : m.runtimeId === 'lmstudio-native' || m.runtimeId === 'lmstudio-openai'
            ? {
                provider: 'lmstudio' as const,
                requestedOptions: lmstudioRequestedOptions,
                loadedOptions:
                  Object.keys(loadedConfig).length > 0
                    ? loadedConfig
                    : undefined,
                nominalContextLength,
                loadedContextLength,
              }
            : m.runtimeId === 'omlx-openai'
              ? {
                  provider: 'omlx' as const,
                  requestedOptions: omlxRequestedOptions,
                  loadedOptions:
                    Object.keys(loadedConfig).length > 0
                      ? loadedConfig
                      : undefined,
                  nominalContextLength,
                  loadedContextLength,
                }
              : undefined
      const optimizationTags = deriveOptimizationTags({
        runtimeId: m.runtimeId,
        modelId: m.id,
        displayName,
        metadata: meta,
      })

      const modelKey = modelTargetKey({
        runtimeId: rt.runtime.id,
        modelId: m.id,
      })
      mappedKeys.add(modelKey)

      models.push({
        id: m.id,
        name: displayName,
        runtimeId: rt.runtime.id,
        runtimeName: rt.runtime.displayName,
        parameterCount,
        quantization,
        contextLength,
        optimizationTags,
        status: pendingLoadKeys.has(modelKey) || loadingIds.has(m.id)
          ? 'loading'
          : loadedIds.has(m.id)
            ? 'loaded'
            : 'available',
        attachmentSupport: deriveAttachmentSupport(m.capabilities as CapabilityRecord[]),
        runtimeConfig,
      })
    }

    for (const target of pendingLoadTargets) {
      const modelKey = modelTargetKey(target)
      if (target.runtimeId !== rt.runtime.id || mappedKeys.has(modelKey)) {
        continue
      }

      mappedKeys.add(modelKey)
      models.push({
        id: target.modelId,
        name: target.modelId,
        runtimeId: rt.runtime.id,
        runtimeName: rt.runtime.displayName,
        status: 'loading',
        attachmentSupport: deriveAttachmentSupport([]),
      })
    }
  }

  return models
}
