import type {
  EnvironmentInspectionResult,
  RuntimeInspectionResult,
} from '@gemma-desktop/sdk-core'
import {
  findGemmaCatalogEntryByTag,
  getExpectedGemmaContextLength,
} from '../shared/gemmaCatalog'
import {
  buildOllamaOptionsRecord,
  resolveManagedOllamaProfile,
  type AppOllamaSettings,
} from '../shared/ollamaRuntimeConfig'
import {
  describeOllamaServerConfigDrift,
  formatOllamaServerConfigDrift,
  type OllamaServerConfigSnapshot,
} from '../shared/ollamaServerConfig'
import {
  buildLmStudioRequestOptionsRecord,
  resolveManagedLmStudioProfile,
  type AppLmStudioSettings,
} from '../shared/lmstudioRuntimeConfig'
import {
  resolveConfiguredHelperModelTarget,
  resolveConfiguredSessionPrimaryTarget,
  resolveSavedDefaultSessionPrimaryTarget,
  type AppModelSelectionSettings,
} from '../shared/sessionModelDefaults'
import type { SpeechInspection } from '../shared/speech'
import type { ReadAloudInspection } from '../shared/readAloud'

export interface DoctorCommandCheck {
  id: 'node' | 'npm' | 'npx'
  label: string
  command: string
  status: 'available' | 'missing' | 'error'
  version?: string
  detail: string
  hint?: string
}

export interface DoctorModelSummary {
  id: string
  label: string
  status: 'loaded' | 'loading' | 'available'
  parameterCount?: string
  quantization?: string
  contextLength?: number
  runtimeConfig?: {
    provider: 'ollama' | 'lmstudio' | 'omlx'
    baseParameters?: Record<string, unknown>
    baseParametersText?: string
    requestedOptions?: Record<string, number>
    loadedOptions?: Record<string, unknown>
    nominalContextLength?: number
    loadedContextLength?: number
    approxGpuResidencyPercent?: number
  }
}

export interface DoctorRuntimeVariant {
  id: string
  label: string
  endpoint: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
}

export interface DoctorRuntimeCheck {
  id: string
  label: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
  modelCount: number
  loadedModelCount: number
  summary: string
  variants: DoctorRuntimeVariant[]
  models: DoctorModelSummary[]
  warnings: string[]
  diagnosis: string[]
}

export type DoctorPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'unsupported'

export interface DoctorPermissionCheck {
  id: 'screen' | 'camera' | 'microphone'
  label: string
  status: DoctorPermissionStatus
  severity: 'success' | 'warning' | 'info'
  summary: string
  hint?: string
  requestableInApp: boolean
}

export interface DoctorIssue {
  severity: 'error' | 'warning' | 'info'
  title: string
  detail: string
}

export interface DoctorIntegrationCheck {
  id: 'chromeMcp'
  label: string
  status: 'ready' | 'disabled' | 'missing_dependency' | 'attention'
  summary: string
  detail?: string
  hint?: string
}

export interface DoctorSpeechCheck {
  providerLabel: string
  modelLabel: string
  enabled: boolean
  installState: string
  healthy: boolean
  detail: string
  lastError: string | null
  recommendedAction: 'request_microphone' | 'install' | 'repair' | 'open_settings' | null
}

export interface DoctorReadAloudCheck {
  providerLabel: string
  modelLabel: string
  dtype: string
  backend: string
  enabled: boolean
  state: string
  healthy: boolean
  detail: string
  lastError: string | null
  recommendedAction: 'open_voice_settings' | null
}

export interface DoctorReport {
  generatedAt: string
  summary: {
    ready: boolean
    headline: string
    errorCount: number
    warningCount: number
  }
  app: {
    version: string
    electron: string
    node: string
    chrome: string
  }
  machine: {
    platform: string
    release: string
    arch: string
    cpuModel?: string
    cpuCount: number
    totalMemoryGB: number
  }
  commands: DoctorCommandCheck[]
  runtimes: DoctorRuntimeCheck[]
  speech: DoctorSpeechCheck
  readAloud: DoctorReadAloudCheck
  permissions: DoctorPermissionCheck[]
  integrations: DoctorIntegrationCheck[]
  issues: DoctorIssue[]
}

interface DoctorReportInput {
  generatedAt: string
  app: DoctorReport['app']
  machine: {
    platform: string
    release: string
    arch: string
    cpuModel?: string
    cpuCount: number
    totalMemoryBytes: number
  }
  environment: EnvironmentInspectionResult | null
  environmentError?: string
  ollamaServerConfig?: OllamaServerConfigSnapshot | null
  commands: DoctorCommandCheck[]
  settings: {
    modelSelection: AppModelSelectionSettings
    ollama: AppOllamaSettings
    lmstudio: AppLmStudioSettings
    runtimes: {
      ollama: {
        numParallel: number
        maxLoadedModels: number
        keepAliveEnabled: boolean
      }
    }
    readAloud: {
      enabled: boolean
    }
    tools: {
      chromeMcp: {
        enabled: boolean
        lastStatus?: {
          state: 'idle' | 'ready' | 'error'
          message: string
          checkedAt: number
        }
      }
    }
  }
  permissionStatuses: Partial<
    Record<'screen' | 'camera' | 'microphone', string | undefined>
  >
  speech: SpeechInspection
  readAloud: ReadAloudInspection
  platform: NodeJS.Platform
}

interface ToolCommandSpec {
  id: DoctorCommandCheck['id']
  label: string
  command: string
  args: string[]
}

const TOOL_COMMANDS: ToolCommandSpec[] = [
  { id: 'node', label: 'Node.js', command: 'node', args: ['--version'] },
  { id: 'npm', label: 'npm', command: 'npm', args: ['--version'] },
  { id: 'npx', label: 'npx', command: 'npx', args: ['--version'] },
]

const RUNTIME_SORT_ORDER: Record<string, number> = {
  ollama: 0,
  lmstudio: 1,
  omlx: 2,
  llamacpp: 3,
}

const MODEL_STATUS_SCORE: Record<DoctorModelSummary['status'], number> = {
  loaded: 3,
  loading: 2,
  available: 1,
}

const RUNTIME_STATUS_SCORE: Record<DoctorRuntimeCheck['status'], number> = {
  running: 3,
  stopped: 2,
  not_installed: 1,
}

function sanitizeVersion(raw?: string): string | undefined {
  if (!raw) return undefined

  const clean = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim()
  if (!clean) return undefined

  const match = /(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/.exec(clean)
  return match ? match[1] : clean.slice(0, 32)
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

function normalizeRuntimeFamilyId(runtimeId: string): string {
  if (runtimeId.startsWith('ollama')) return 'ollama'
  if (runtimeId.startsWith('lmstudio')) return 'lmstudio'
  if (runtimeId.startsWith('llamacpp')) return 'llamacpp'
  if (runtimeId.startsWith('omlx')) return 'omlx'
  return runtimeId
}

function runtimeFamilyLabel(familyId: string, fallback: string): string {
  switch (familyId) {
    case 'ollama':
      return 'Ollama'
    case 'lmstudio':
      return 'LM Studio'
    case 'llamacpp':
      return 'llama.cpp Server'
    case 'omlx':
      return 'oMLX'
    default:
      return fallback
  }
}

function runtimeStatusFromInspection(
  inspection: RuntimeInspectionResult,
): DoctorRuntimeCheck['status'] {
  if (inspection.healthy) return 'running'
  return inspection.installed ? 'stopped' : 'not_installed'
}

function describeToolFailure(command: string, error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT'
  ) {
    return `${command} is not available in Gemma Desktop's app environment.`
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return `${command} could not be checked.`
}

function buildToolHint(command: string): string {
  if (command === 'npx' || command === 'npm') {
    return 'Install Node.js, then refresh Doctor so Gemma Desktop can recheck npm and npx. Relaunch only if the app still cannot see the updated shell environment.'
  }

  return 'Install Node.js, then refresh Doctor. Relaunch Gemma Desktop only if the app still cannot see the updated shell environment.'
}

export async function collectDoctorCommandChecks(
  runCommand: (command: string, args: string[]) => Promise<string>,
): Promise<DoctorCommandCheck[]> {
  return await Promise.all(TOOL_COMMANDS.map(async (spec) => {
    try {
      const output = await runCommand(spec.command, spec.args)
      const version = sanitizeVersion(output)

      return {
        id: spec.id,
        label: spec.label,
        command: [spec.command, ...spec.args].join(' '),
        status: 'available',
        version,
        detail: version
          ? `${spec.label} ${version} is available.`
          : `${spec.label} is available.`,
      }
    } catch (error) {
      const missing =
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT'

      return {
        id: spec.id,
        label: spec.label,
        command: [spec.command, ...spec.args].join(' '),
        status: missing ? 'missing' : 'error',
        detail: describeToolFailure(spec.command, error),
        hint: buildToolHint(spec.command),
      }
    }
  }))
}

function mapDoctorModel(
  runtime: RuntimeInspectionResult,
  model: RuntimeInspectionResult['models'][number],
  settings: DoctorReportInput['settings'],
): DoctorModelSummary | null {
  if (model.kind === 'embedding') {
    return null
  }

  const loadedInstance = runtime.loadedInstances.find(
    (instance) =>
      instance.modelId === model.id
      && (instance.status === 'loaded' || instance.status === 'loading'),
  )
  const meta = model.metadata as Record<string, unknown>
  const loadedConfig =
    loadedInstance?.config && typeof loadedInstance.config === 'object'
      ? loadedInstance.config
      : {}

  let quantization: string | undefined
  if (meta.quantization != null) {
    quantization = typeof meta.quantization === 'object'
      ? String((meta.quantization as Record<string, unknown>).name ?? '')
      : String(meta.quantization)
    quantization = quantization.trim() || undefined
  }

  const rawParameterCount =
    meta.parameterCount
    ?? meta.parameter_count
    ?? meta.parameters
    ?? meta.sizeLabel
    ?? meta.size
  const parameterCount =
    typeof rawParameterCount === 'string'
      ? rawParameterCount
      : typeof rawParameterCount === 'number'
        ? `${rawParameterCount}`
        : undefined

  const contextLength = coerceNumber(
    (loadedConfig as Record<string, unknown>).context_length,
    meta.contextLength,
    meta.contextWindow,
    meta.context_size,
    meta.num_ctx,
    (loadedConfig as Record<string, unknown>).num_ctx,
    meta.maxContextWindow,
    meta.max_context_window,
    meta.maxTokens,
    meta.max_tokens,
    (loadedConfig as Record<string, unknown>).maxContextWindow,
    (loadedConfig as Record<string, unknown>).max_context_window,
    (loadedConfig as Record<string, unknown>).maxTokens,
    (loadedConfig as Record<string, unknown>).max_tokens,
  )
  const ollamaRequestedOptions = buildOllamaOptionsRecord(
    resolveManagedOllamaProfile(settings.ollama, model.id, runtime.runtime.id),
  )
  const lmstudioRequestedOptions = buildLmStudioRequestOptionsRecord(
    resolveManagedLmStudioProfile(
      settings.lmstudio,
      model.id,
      runtime.runtime.id,
      typeof meta.displayName === 'string'
        ? meta.displayName
        : typeof meta.name === 'string'
          ? meta.name
          : undefined,
    ),
  )
  const runtimeConfig =
    runtime.runtime.id === 'ollama-native' || runtime.runtime.id === 'ollama-openai'
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
          nominalContextLength: coerceNumber(
            meta.contextLength,
            meta.contextWindow,
            meta.context_size,
            meta.num_ctx,
            meta.maxContextLength,
            meta.max_context_length,
          ),
          loadedContextLength: coerceNumber(
            (loadedConfig as Record<string, unknown>).context_length,
            (loadedConfig as Record<string, unknown>).num_ctx,
          ),
          approxGpuResidencyPercent: computeApproxGpuResidencyPercent(
            loadedConfig as Record<string, unknown>,
          ),
        }
      : runtime.runtime.id === 'lmstudio-native' || runtime.runtime.id === 'lmstudio-openai'
        ? {
            provider: 'lmstudio' as const,
            requestedOptions: lmstudioRequestedOptions,
            loadedOptions:
              Object.keys(loadedConfig).length > 0
                ? loadedConfig
                : undefined,
            nominalContextLength: coerceNumber(
              meta.contextLength,
              meta.contextWindow,
              meta.context_size,
              meta.num_ctx,
              meta.maxContextLength,
              meta.max_context_length,
            ),
            loadedContextLength: coerceNumber(
              (loadedConfig as Record<string, unknown>).context_length,
              (loadedConfig as Record<string, unknown>).num_ctx,
            ),
          }
          : runtime.runtime.id === 'omlx-openai'
            ? {
                provider: 'omlx' as const,
                loadedOptions:
                  Object.keys(loadedConfig).length > 0
                    ? loadedConfig
                    : undefined,
                nominalContextLength: coerceNumber(
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
                ),
                loadedContextLength: coerceNumber(
                  (loadedConfig as Record<string, unknown>).context_length,
                  (loadedConfig as Record<string, unknown>).num_ctx,
                  (loadedConfig as Record<string, unknown>).maxContextWindow,
                  (loadedConfig as Record<string, unknown>).max_context_window,
                  (loadedConfig as Record<string, unknown>).maxTokens,
                  (loadedConfig as Record<string, unknown>).max_tokens,
                ),
              }
      : undefined

  return {
    id: model.id,
    label:
      typeof meta.name === 'string' && meta.name.trim().length > 0
        ? meta.name.trim()
        : model.id,
    status:
      loadedInstance?.status === 'loaded'
        ? 'loaded'
        : loadedInstance?.status === 'loading'
          ? 'loading'
          : 'available',
    parameterCount,
    quantization,
    contextLength,
    runtimeConfig,
  }
}

function mergeDoctorModel(
  current: DoctorModelSummary | undefined,
  next: DoctorModelSummary,
): DoctorModelSummary {
  if (!current) {
    return next
  }

  if (MODEL_STATUS_SCORE[next.status] > MODEL_STATUS_SCORE[current.status]) {
    return {
      ...current,
      ...next,
      parameterCount: next.parameterCount ?? current.parameterCount,
      quantization: next.quantization ?? current.quantization,
      contextLength: next.contextLength ?? current.contextLength,
      runtimeConfig: next.runtimeConfig ?? current.runtimeConfig,
    }
  }

  return {
    ...current,
    parameterCount: current.parameterCount ?? next.parameterCount,
    quantization: current.quantization ?? next.quantization,
    contextLength: current.contextLength ?? next.contextLength,
    runtimeConfig: current.runtimeConfig ?? next.runtimeConfig,
  }
}

function buildRuntimeSummary(runtime: {
  status: DoctorRuntimeCheck['status']
  modelCount: number
  loadedModelCount: number
}): string {
  if (runtime.status === 'not_installed') {
    return 'Gemma Desktop could not detect this runtime on the machine.'
  }

  if (runtime.status === 'stopped') {
    return 'Gemma Desktop found this runtime, but its local endpoint is not healthy right now.'
  }

  if (runtime.modelCount === 0) {
    return 'The runtime is responding, but Gemma Desktop did not discover any non-embedding models.'
  }

  if (runtime.loadedModelCount > 0) {
    return `${runtime.loadedModelCount} loaded model${runtime.loadedModelCount === 1 ? '' : 's'} and ${runtime.modelCount} visible model${runtime.modelCount === 1 ? '' : 's'}.`
  }

  return `${runtime.modelCount} visible model${runtime.modelCount === 1 ? '' : 's'} detected.`
}

export function buildDoctorRuntimeChecks(
  environment: EnvironmentInspectionResult | null,
  settings: DoctorReportInput['settings'],
): DoctorRuntimeCheck[] {
  const groups = new Map<
    string,
    {
      id: string
      label: string
      status: DoctorRuntimeCheck['status']
      version?: string
      variants: DoctorRuntimeVariant[]
      models: Map<string, DoctorModelSummary>
      warnings: string[]
      diagnosis: string[]
    }
  >()

  for (const runtime of environment?.runtimes ?? []) {
    const familyId = normalizeRuntimeFamilyId(runtime.runtime.id)
    const familyLabel = runtimeFamilyLabel(familyId, runtime.runtime.displayName)
    const variantStatus = runtimeStatusFromInspection(runtime)
    const existing = groups.get(familyId)
    const group = existing ?? {
      id: familyId,
      label: familyLabel,
      status: variantStatus,
      version: sanitizeVersion(runtime.version),
      variants: [],
      models: new Map<string, DoctorModelSummary>(),
      warnings: [],
      diagnosis: [],
    }

    if (RUNTIME_STATUS_SCORE[variantStatus] > RUNTIME_STATUS_SCORE[group.status]) {
      group.status = variantStatus
    }

    if (
      !group.version
      || (variantStatus === 'running' && sanitizeVersion(runtime.version))
    ) {
      group.version = sanitizeVersion(runtime.version) ?? group.version
    }

    group.variants.push({
      id: runtime.runtime.id,
      label: runtime.runtime.displayName,
      endpoint: runtime.runtime.endpoint,
      status: variantStatus,
      version: sanitizeVersion(runtime.version),
    })

    for (const warning of runtime.warnings) {
      if (!group.warnings.includes(warning)) {
        group.warnings.push(warning)
      }
    }

    for (const diagnosis of runtime.diagnosis) {
      if (!group.diagnosis.includes(diagnosis)) {
        group.diagnosis.push(diagnosis)
      }
    }

    for (const model of runtime.models) {
      const mapped = mapDoctorModel(runtime, model, settings)
      if (!mapped) {
        continue
      }

      group.models.set(
        mapped.id,
        mergeDoctorModel(group.models.get(mapped.id), mapped),
      )
    }

    groups.set(familyId, group)
  }

  return [...groups.values()]
    .map((group) => {
      const models = [...group.models.values()].sort((left, right) => {
        const statusDiff =
          MODEL_STATUS_SCORE[right.status] - MODEL_STATUS_SCORE[left.status]
        if (statusDiff !== 0) {
          return statusDiff
        }
        return left.label.localeCompare(right.label)
      })
      const loadedModelCount = models.filter((model) => model.status === 'loaded').length

      return {
        id: group.id,
        label: group.label,
        status: group.status,
        version: group.version,
        modelCount: models.length,
        loadedModelCount,
        summary: buildRuntimeSummary({
          status: group.status,
          modelCount: models.length,
          loadedModelCount,
        }),
        variants: group.variants.sort((left, right) =>
          left.label.localeCompare(right.label),
        ),
        models,
        warnings: group.warnings,
        diagnosis: group.diagnosis,
      }
    })
    .sort((left, right) => {
      const familyDiff =
        (RUNTIME_SORT_ORDER[left.id] ?? 99) - (RUNTIME_SORT_ORDER[right.id] ?? 99)
      if (familyDiff !== 0) {
        return familyDiff
      }

      return left.label.localeCompare(right.label)
    })
}

function normalizePermissionStatus(
  platform: NodeJS.Platform,
  rawStatus: string | undefined,
): DoctorPermissionStatus {
  if (platform !== 'darwin') {
    return 'unsupported'
  }

  switch (rawStatus) {
    case undefined:
      return 'unknown'
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
    case 'unknown':
      return rawStatus
    default:
      return 'unknown'
  }
}

function permissionCopy(
  id: DoctorPermissionCheck['id'],
  status: DoctorPermissionStatus,
): Pick<DoctorPermissionCheck, 'summary' | 'hint' | 'severity' | 'requestableInApp'> {
  if (status === 'unsupported') {
    return {
      summary: 'This permission check is only available on macOS builds right now.',
      severity: 'info',
      requestableInApp: false,
    }
  }

  if (id === 'screen') {
    switch (status) {
      case 'granted':
        return {
          summary: 'macOS already allows Gemma Desktop to capture the screen when a workflow needs it.',
          severity: 'success',
          requestableInApp: false,
        }
      case 'denied':
      case 'restricted':
        return {
          summary: 'Screen capture is blocked for Gemma Desktop.',
          hint: 'Open System Settings > Privacy & Security > Screen & System Audio Recording (or Screen Recording on older macOS), enable Gemma Desktop, then relaunch the app.',
          severity: 'warning',
          requestableInApp: false,
        }
      case 'not-determined':
        return {
          summary: 'Screen capture has not been granted yet.',
          hint: 'If a screen-based workflow fails, enable Gemma Desktop in System Settings > Privacy & Security > Screen & System Audio Recording and relaunch the app.',
          severity: 'info',
          requestableInApp: false,
        }
      case 'unknown':
        return {
          summary: 'macOS did not return a stable screen-capture status.',
          hint: 'If screen capture is important for your workflow, verify the permission directly in System Settings.',
          severity: 'warning',
          requestableInApp: false,
        }
    }
  }

  if (id === 'camera') {
    switch (status) {
      case 'granted':
        return {
          summary: 'Camera access is already available for image capture workflows.',
          severity: 'success',
          requestableInApp: false,
        }
      case 'denied':
      case 'restricted':
        return {
          summary: 'Camera access is blocked for Gemma Desktop.',
          hint: 'Open System Settings > Privacy & Security > Camera and enable Gemma Desktop.',
          severity: 'warning',
          requestableInApp: true,
        }
      case 'not-determined':
        return {
          summary: 'Gemma Desktop has not requested camera access yet.',
          hint: 'You can request camera access from this screen or trigger the camera capture flow to let macOS prompt you.',
          severity: 'info',
          requestableInApp: true,
        }
      case 'unknown':
        return {
          summary: 'macOS did not return a stable camera status.',
          hint: 'Try requesting camera access again, or verify Gemma Desktop in System Settings > Privacy & Security > Camera.',
          severity: 'warning',
          requestableInApp: true,
        }
    }
  }

  switch (status) {
    case 'granted':
      return {
        summary: 'Microphone access is already available if future voice workflows need it.',
        severity: 'success',
        requestableInApp: false,
      }
    case 'denied':
    case 'restricted':
      return {
        summary: 'Microphone access is blocked for Gemma Desktop.',
        hint: 'Open System Settings > Privacy & Security > Microphone and enable Gemma Desktop if you plan to use audio features.',
        severity: 'warning',
        requestableInApp: true,
      }
    case 'not-determined':
      return {
        summary: 'Gemma Desktop has not requested microphone access.',
        hint: 'Request microphone access here or in the speech composer before trying voice input.',
        severity: 'info',
        requestableInApp: true,
      }
    case 'unknown':
      return {
        summary: 'macOS did not return a stable microphone status.',
        hint: 'Verify Gemma Desktop in System Settings > Privacy & Security > Microphone if audio access matters for your setup.',
        severity: 'warning',
        requestableInApp: true,
      }
  }
}

export function buildDoctorPermissionChecks(
  platform: NodeJS.Platform,
  statuses: DoctorReportInput['permissionStatuses'],
): DoctorPermissionCheck[] {
  return ([
    ['screen', 'Screen Capture'],
    ['camera', 'Camera'],
    ['microphone', 'Microphone'],
  ] as const).map(([id, label]) => {
    const status = normalizePermissionStatus(platform, statuses[id])
    const copy = permissionCopy(id, status)

    return {
      id,
      label,
      status,
      ...copy,
    }
  })
}

function buildDoctorSpeechCheck(input: {
  speech: SpeechInspection
  permissions: DoctorPermissionCheck[]
}): DoctorSpeechCheck {
  const microphonePermission = input.permissions.find(
    (permission) => permission.id === 'microphone',
  )

  let recommendedAction: DoctorSpeechCheck['recommendedAction'] = null
  if (microphonePermission?.status !== 'granted' && microphonePermission?.requestableInApp) {
    recommendedAction = 'request_microphone'
  } else if (input.speech.supported && !input.speech.enabled) {
    recommendedAction = 'open_settings'
  } else if (input.speech.supported && !input.speech.installed) {
    recommendedAction = input.speech.installState === 'error' ? 'repair' : 'install'
  } else if (
    input.speech.supported
    && (input.speech.installState === 'error' || !input.speech.healthy)
  ) {
    recommendedAction = 'repair'
  }

  return {
    providerLabel: input.speech.providerLabel,
    modelLabel: input.speech.modelLabel,
    enabled: input.speech.enabled,
    installState: input.speech.installState,
    healthy: input.speech.healthy,
    detail: input.speech.detail,
    lastError: input.speech.lastError,
    recommendedAction,
  }
}

function buildDoctorReadAloudCheck(input: {
  readAloud: ReadAloudInspection
}): DoctorReadAloudCheck {
  let recommendedAction: DoctorReadAloudCheck['recommendedAction'] = null
  if (
    input.readAloud.enabled
    && input.readAloud.supported
    && !input.readAloud.healthy
    && input.readAloud.state !== 'missing_assets'
  ) {
    recommendedAction = 'open_voice_settings'
  }

  return {
    providerLabel: input.readAloud.providerLabel,
    modelLabel: input.readAloud.modelLabel,
    dtype: input.readAloud.dtype,
    backend: input.readAloud.backend,
    enabled: input.readAloud.enabled,
    state: input.readAloud.state,
    healthy: input.readAloud.healthy,
    detail: input.readAloud.detail,
    lastError: input.readAloud.lastError,
    recommendedAction,
  }
}

function doctorIssue(
  severity: DoctorIssue['severity'],
  title: string,
  detail: string,
): DoctorIssue {
  return { severity, title, detail }
}

function runtimeStartupHint(runtimeId: string): string {
  if (runtimeId === 'ollama') {
    return 'Start Ollama and make sure its local API is reachable from Gemma Desktop. On macOS that often means launching the Ollama app or running `ollama serve`.'
  }

  if (runtimeId === 'lmstudio') {
    return 'Open LM Studio and enable its local server so Gemma Desktop can reach the runtime endpoint.'
  }

  return 'Start the runtime and make sure its configured local endpoint is reachable from Gemma Desktop.'
}

function resolveDoctorHelperTarget(
  settings: DoctorReportInput['settings'],
): { modelId: string; runtimeId: string } {
  return resolveConfiguredHelperModelTarget(settings.modelSelection)
}

function isOllamaModelRuntime(runtimeId: string): boolean {
  return runtimeId === 'ollama-native' || runtimeId === 'ollama-openai'
}

function buildDoctorIssues(input: {
  commands: DoctorCommandCheck[]
  runtimes: DoctorRuntimeCheck[]
  permissions: DoctorPermissionCheck[]
  environment: EnvironmentInspectionResult | null
  environmentError?: string
  ollamaServerConfig?: DoctorReportInput['ollamaServerConfig']
  settings: DoctorReportInput['settings']
  speech: SpeechInspection
  readAloud: ReadAloudInspection
}): DoctorIssue[] {
  const issues: DoctorIssue[] = []

  if (input.environmentError) {
    issues.push(doctorIssue(
      'error',
      'Environment inspection failed',
      input.environmentError,
    ))
  }

  const npxCheck = input.commands.find((check) => check.id === 'npx')
  if (!npxCheck || npxCheck.status !== 'available') {
    issues.push(doctorIssue(
      'error',
      'npx is unavailable',
      npxCheck?.hint
        ?? 'Install Node.js so Gemma Desktop can run commands that depend on npx.',
    ))
  }

  if (input.settings.tools.chromeMcp.lastStatus?.state === 'error') {
    issues.push(doctorIssue(
      'warning',
      'Managed browser last health check failed',
      input.settings.tools.chromeMcp.lastStatus.message,
    ))
  }

  const primaryRuntimes = input.runtimes.filter((runtime) =>
    runtime.id === 'ollama' || runtime.id === 'lmstudio' || runtime.id === 'omlx',
  )
  const requiredRuntimeIssues = primaryRuntimes.filter((runtime) => runtime.id !== 'omlx')
  const runningPrimaryRuntimes = primaryRuntimes.filter(
    (runtime) => runtime.status === 'running',
  )

  if (primaryRuntimes.length === 0 || runningPrimaryRuntimes.length === 0) {
    issues.push(doctorIssue(
      'error',
      'No compatible runtime is healthy',
      'Gemma Desktop could not confirm a healthy Ollama, LM Studio, or oMLX endpoint. Start one of them and make sure its local server is reachable from the app.',
    ))
  }

  for (const runtime of requiredRuntimeIssues) {
    if (runtime.status === 'stopped') {
      issues.push(doctorIssue(
        'warning',
        `${runtime.label} is installed but not responding`,
        runtimeStartupHint(runtime.id),
      ))
    }

    if (runtime.status === 'running' && runtime.modelCount === 0) {
      issues.push(doctorIssue(
        'warning',
        `${runtime.label} is running without visible models`,
        `Gemma Desktop reached ${runtime.label}, but it did not discover any non-embedding models yet.`,
      ))
    }
  }

  const helperTarget = resolveDoctorHelperTarget(input.settings)
  const helperModelId = helperTarget.modelId
  const configuredPrimaryModelIds = [...new Set(
    [
      resolveSavedDefaultSessionPrimaryTarget(input.settings.modelSelection),
      resolveConfiguredSessionPrimaryTarget(
        { conversationKind: 'normal', baseMode: 'build' },
        input.settings.modelSelection,
      ),
      resolveConfiguredSessionPrimaryTarget(
        { conversationKind: 'research', baseMode: 'explore' },
        input.settings.modelSelection,
      ),
    ]
      .filter((target) => isOllamaModelRuntime(target.runtimeId))
      .map((target) => target.modelId),
  )]

  const ollamaConfigDrift = describeOllamaServerConfigDrift(
    input.ollamaServerConfig,
    input.settings.runtimes.ollama,
  )
  if (ollamaConfigDrift.length > 0) {
    issues.push(doctorIssue(
      'warning',
      'Ollama server settings differ from Gemma Desktop',
      `Doctor found ${formatOllamaServerConfigDrift(ollamaConfigDrift)}. Gemma Desktop will not restart or reconfigure Ollama automatically. Update your Ollama launch environment and restart Ollama manually when you want these server-level settings to take effect.`,
    ))
  }

  if (
    input.settings.runtimes.ollama.maxLoadedModels <= 1
    && isOllamaModelRuntime(helperTarget.runtimeId)
    && configuredPrimaryModelIds.some((modelId) => modelId !== helperModelId)
  ) {
    issues.push(doctorIssue(
      'warning',
      'Ollama helper and primary defaults cannot stay loaded together',
      `Gemma Desktop is configured to keep only ${input.settings.runtimes.ollama.maxLoadedModels} Ollama model loaded at a time, but the helper default (${helperModelId}) differs from one or more primary defaults (${configuredPrimaryModelIds.join(', ')}). Ollama can multiplex parallel requests on one loaded model, but a distinct helper model needs at least two loaded-model slots to stay warm alongside the primary.`,
    ))
  }

  for (const runtime of primaryRuntimes) {
    if (runtime.id !== 'ollama' || runtime.status !== 'running') {
      continue
    }

    for (const model of runtime.models) {
      const gemmaEntry = findGemmaCatalogEntryByTag(model.id)
      if (!gemmaEntry) {
        continue
      }

      const expectedContextLength =
        model.runtimeConfig?.requestedOptions?.num_ctx
        ?? getExpectedGemmaContextLength(model.id)
      if (!expectedContextLength) {
        continue
      }

      if (!model.contextLength) {
        issues.push(doctorIssue(
          'warning',
          `${gemmaEntry.label} context length is unknown`,
          `Gemma Desktop could not confirm the effective Ollama context for ${gemmaEntry.label}. Gemma Desktop is expecting about ${(expectedContextLength / 1024).toFixed(0)}K for this model on the current profile, but the live loaded context did not come back from Ollama.`,
        ))
        continue
      }

      if (model.contextLength < expectedContextLength) {
        issues.push(doctorIssue(
          'warning',
          `${gemmaEntry.label} is below Gemma Desktop's requested context`,
          `${gemmaEntry.label} is currently reporting about ${(model.contextLength / 1024).toFixed(0)}K context in Ollama, below Gemma Desktop's requested ${(expectedContextLength / 1024).toFixed(0)}K. This means the live runtime is not matching the managed app profile.`,
        ))
      }

      const gpuResidency = model.runtimeConfig?.approxGpuResidencyPercent
      if (typeof gpuResidency === 'number' && gpuResidency < 95) {
        issues.push(doctorIssue(
          'warning',
          `${gemmaEntry.label} is spilling to CPU`,
          `${gemmaEntry.label} is only about ${gpuResidency}% resident in GPU memory right now. That usually means this context or model size is too heavy for the current machine and Ollama is offloading part of the model to CPU.`,
        ))
      }
    }
  }

  for (const permission of input.permissions) {
    if (permission.status === 'denied' || permission.status === 'restricted') {
      issues.push(doctorIssue(
        permission.id === 'screen' ? 'warning' : 'warning',
        `${permission.label} access needs attention`,
        permission.hint ?? permission.summary,
      ))
    }
  }

  if (input.speech.enabled && input.speech.supported) {
    if (input.speech.installState === 'error') {
      issues.push(doctorIssue(
        'warning',
        'Speech runtime needs repair',
        input.speech.lastError ?? input.speech.detail,
      ))
    } else if (input.speech.installState !== 'installed') {
      issues.push(doctorIssue(
        'info',
        'Speech input is not installed yet',
        input.speech.detail,
      ))
    } else if (!input.speech.healthy) {
      issues.push(doctorIssue(
        'warning',
        'Speech runtime health check failed',
        input.speech.lastError ?? input.speech.detail,
      ))
    }
  }

  if (input.readAloud.enabled && input.readAloud.supported) {
    if (input.readAloud.state === 'missing_assets') {
      issues.push(doctorIssue(
        'info',
        'Read aloud will install on first use',
        input.readAloud.detail,
      ))
    } else if (input.readAloud.state === 'error' || !input.readAloud.healthy) {
      issues.push(doctorIssue(
        'warning',
        'Read aloud needs attention',
        input.readAloud.lastError ?? input.readAloud.detail,
      ))
    }
  }

  for (const message of input.environment?.diagnosis ?? []) {
    issues.push(doctorIssue('warning', 'Runtime diagnosis', message))
  }

  for (const message of input.environment?.warnings ?? []) {
    issues.push(doctorIssue('info', 'Environment warning', message))
  }

  return issues
}

function buildDoctorIntegrationChecks(input: {
  commands: DoctorCommandCheck[]
  settings: DoctorReportInput['settings']
}): DoctorIntegrationCheck[] {
  const npxCheck = input.commands.find((check) => check.id === 'npx')
  const chromeMcp = input.settings.tools.chromeMcp

  if (!npxCheck || npxCheck.status !== 'available') {
    return [{
      id: 'chromeMcp',
      label: 'Managed Browser',
      status: 'missing_dependency',
      summary: 'Managed browser needs npx in Gemma Desktop’s app environment.',
      hint: npxCheck?.hint
        ?? 'Install Node.js so Gemma Desktop can run npx-based local tools.',
    }]
  }

  if (chromeMcp.lastStatus?.state === 'ready') {
    return [{
      id: 'chromeMcp',
      label: 'Managed Browser',
      status: 'ready',
      summary: chromeMcp.lastStatus.message,
      detail:
        chromeMcp.lastStatus.checkedAt > 0
          ? `Last checked at ${new Date(chromeMcp.lastStatus.checkedAt).toLocaleString()}.`
          : undefined,
    }]
  }

  if (chromeMcp.lastStatus?.state === 'error') {
    return [{
      id: 'chromeMcp',
      label: 'Managed Browser',
      status: 'attention',
      summary: 'The last managed browser health check failed.',
      detail: chromeMcp.lastStatus.message,
      hint:
        'Open Doctor again to re-run the browser checks. If the failure mentions installation or Chrome availability, repair that local setup first.',
    }]
  }

  return [{
    id: 'chromeMcp',
    label: 'Managed Browser',
    status: 'attention',
    summary: 'Managed Browser is waiting for its first health check.',
    hint:
      'Open Doctor to verify the managed browser install, or use Browser in chat to let Gemma Desktop warm it on demand.',
  }]
}

function buildHeadline(errorCount: number, warningCount: number): string {
  if (errorCount > 0) {
    return `${errorCount} setup issue${errorCount === 1 ? '' : 's'} need attention.`
  }

  if (warningCount > 0) {
    return `Gemma Desktop looks mostly ready, with ${warningCount} thing${warningCount === 1 ? '' : 's'} worth checking.`
  }

  return 'Gemma Desktop looks ready for local model work.'
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const runtimes = buildDoctorRuntimeChecks(input.environment, input.settings)
  const permissions = buildDoctorPermissionChecks(
    input.platform,
    input.permissionStatuses,
  )
  const speech = buildDoctorSpeechCheck({
    speech: input.speech,
    permissions,
  })
  const readAloud = buildDoctorReadAloudCheck({
    readAloud: input.readAloud,
  })
  const integrations = buildDoctorIntegrationChecks({
    commands: input.commands,
    settings: input.settings,
  })
  const issues = buildDoctorIssues({
    commands: input.commands,
    runtimes,
    permissions,
    environment: input.environment,
    environmentError: input.environmentError,
    ollamaServerConfig: input.ollamaServerConfig,
    settings: input.settings,
    speech: input.speech,
    readAloud: input.readAloud,
  })
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length

  return {
    generatedAt: input.generatedAt,
    summary: {
      ready: errorCount === 0,
      headline: buildHeadline(errorCount, warningCount),
      errorCount,
      warningCount,
    },
    app: input.app,
    machine: {
      platform: input.environment?.machine.platform ?? input.machine.platform,
      release: input.environment?.machine.release ?? input.machine.release,
      arch: input.environment?.machine.arch ?? input.machine.arch,
      cpuModel: input.environment?.machine.cpuModel ?? input.machine.cpuModel,
      cpuCount: input.environment?.machine.cpuCount ?? input.machine.cpuCount,
      totalMemoryGB: Number(
        (
          (input.environment?.machine.totalMemoryBytes
            ?? input.machine.totalMemoryBytes)
          / (1024 * 1024 * 1024)
        ).toFixed(1),
      ),
    },
    commands: input.commands,
    runtimes,
    speech,
    readAloud,
    permissions,
    integrations,
    issues,
  }
}
