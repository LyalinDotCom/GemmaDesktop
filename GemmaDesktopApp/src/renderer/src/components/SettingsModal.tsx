import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Bell,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import {
  ABOUT_CREDIT_SECTIONS,
  ABOUT_SCREEN_INTRO,
} from '@shared/about'
import type {
  AppSettings,
  BootstrapState,
  AppToolPolicyMode,
  GemmaInstallState,
  ModelSummary,
  ReadAloudInspection,
  ReadAloudTestInput,
  SpeechInspection,
  TerminalAppInfo,
} from '@/types'
import type { NotificationPermissionState } from '@shared/notifications'
import {
  OLLAMA_CONTEXT_PRESET_VALUES,
  formatOllamaContextPreset,
} from '@shared/ollamaRuntimeConfig'
import {
  READ_ALOUD_VOICE_OPTIONS,
  clampReadAloudSpeed,
} from '@shared/readAloud'
import {
  listKnownReasoningControlModels,
} from '@shared/reasoningSettings'
import { ASK_GEMINI_DEFAULT_MODEL } from '@shared/geminiModels'
import {
  Button,
  MetaList,
  Note,
  Select,
  SettingsField,
  SettingsRow,
  SettingsSection,
  Tag,
  TextInput,
  Toggle,
} from './settings/Primitives'

interface SettingsModalProps {
  settings: AppSettings
  defaultModelSelection: AppSettings['modelSelection']
  models: ModelSummary[]
  gemmaInstallStates: GemmaInstallState[]
  bootstrapState: BootstrapState
  onClose: () => void
  onUpdate: (patch: Partial<AppSettings>) => void | Promise<void>
  onEnsureGemmaModel: (tag: string) => Promise<{
    ok: boolean
    tag: string
    installed: boolean
    cancelled?: boolean
    error?: string
  }>
  initialTab?: SettingsTab
  speechStatus: SpeechInspection | null
  readAloudStatus: ReadAloudInspection | null
  notificationPermission: NotificationPermissionState
  onInstallSpeech: () => void | Promise<unknown>
  onRepairSpeech: () => void | Promise<unknown>
  onRemoveSpeech: () => void | Promise<unknown>
  onTestReadAloud: (input?: ReadAloudTestInput) => void | Promise<unknown>
  onRequestNotificationPermission: () => void | Promise<unknown>
  onSendTestNotification: () => void | Promise<unknown>
}

export type SettingsTab =
  | 'general'
  | 'ollama'
  | 'notifications'
  | 'context'
  | 'runtimes'
  | 'speech'
  | 'voice'
  | 'chrome'
  | 'integrations'
  | 'tools'
  | 'about'

const TAB_ENTRIES: ReadonlyArray<readonly [SettingsTab, string]> = [
  ['general', 'General'],
  ['ollama', 'Ollama'],
  ['notifications', 'Notifications'],
  ['context', 'Context'],
  ['runtimes', 'Runtimes'],
  ['speech', 'Speech'],
  ['voice', 'Voice'],
  ['chrome', 'Browser'],
  ['integrations', 'Integrations'],
  ['tools', 'Tools'],
  ['about', 'About'],
] as const

export interface DefaultModelOption {
  modelId: string
  runtimeId: string
  label: string
  providerLabel: string
  apiTypeLabel: string
}

const TOOL_POLICY_SECTIONS = [
  {
    title: 'Workspace Read',
    description: 'Direct read tools plus delegated agents for broader multi-file inspection inside the current workspace.',
    tools: [
      { name: 'list_tree', label: 'List Tree', description: 'Browse nearby files and folders in a shallow repo-aware tree around a known path.' },
      { name: 'search_paths', label: 'Search Paths', description: 'Recursively discover files or folders by ranked query or deterministic glob.' },
      { name: 'search_text', label: 'Search Text', description: 'Search workspace file contents with literal matching by default and optional regex.' },
      { name: 'read_file', label: 'Read File', description: 'Read one known file with offset/limit windows and continuation hints.' },
      { name: 'read_files', label: 'Read Files', description: 'Batch-read several known files together under a shared byte budget.' },
      { name: 'workspace_inspector_agent', label: 'Workspace Inspector Agent', description: 'Delegated agent for broader read-only workspace inspection across multiple files.' },
      { name: 'workspace_search_agent', label: 'Workspace Search Agent', description: 'Delegated agent for multi-step codebase search and summarization.' },
    ],
  },
  {
    title: 'Workspace Write',
    description: 'Direct file mutation tools plus a delegated agent for broader edit tasks inside the workspace.',
    tools: [
      { name: 'write_file', label: 'Write File', description: 'Create or overwrite files directly.' },
      { name: 'edit_file', label: 'Edit File', description: 'Replace exact text inside existing files.' },
      { name: 'workspace_editor_agent', label: 'Workspace Editor Agent', description: 'Delegated agent that plans and applies broader file creation or edit tasks.' },
    ],
  },
  {
    title: 'Commands',
    description: 'Direct shell execution plus a delegated agent that chooses commands from repository context.',
    tools: [
      { name: 'exec_command', label: 'Exec Command', description: 'Run a shell command in the workspace.' },
      { name: 'workspace_command_agent', label: 'Workspace Command Agent', description: 'Delegated agent that inspects the repo, picks commands, and runs them.' },
    ],
  },
  {
    title: 'Web',
    description: 'Direct web lookup tools plus a delegated agent for broader web research.',
    tools: [
      { name: 'fetch_url', label: 'Fetch URL', description: 'Direct tool that fetches and extracts readable content from one public URL.' },
      { name: 'search_web', label: 'Search Web', description: 'Direct tool that runs one public web search to find candidate sources.' },
      { name: 'web_research_agent', label: 'Web Research Agent', description: 'Delegated agent for multi-source web research, comparison, and synthesis.' },
    ],
  },
  {
    title: 'Files',
    description: 'Inspect file types safely first, then use smart file reads that can turn PDFs, images, and audio into cached text.',
    tools: [
      { name: 'inspect_file', label: 'Inspect File', description: 'Direct tool that classifies a local file and suggests the safest read strategy.' },
    ],
  },
  {
    title: 'Skills',
    description: 'Let the model activate installed skills when they are relevant to the current session.',
    tools: [
      { name: 'activate_skill', label: 'Activate Skill', description: 'Load an installed skill into the current session when it becomes relevant.' },
    ],
  },
] as const

const TOOL_POLICY_TOOL_ORDER = TOOL_POLICY_SECTIONS.flatMap((section) =>
  section.tools.map((tool) => tool.name),
)

const DEFAULT_TOOL_POLICY: AppSettings['toolPolicy'] = {
  explore: {
    allowedTools: [
      'list_tree', 'search_paths', 'search_text', 'inspect_file', 'read_file', 'read_files',
      'fetch_url', 'search_web',
      'workspace_inspector_agent', 'workspace_search_agent', 'web_research_agent',
      'activate_skill',
    ],
  },
  build: {
    allowedTools: [
      'list_tree', 'search_paths', 'search_text', 'inspect_file', 'read_file', 'read_files',
      'write_file', 'edit_file', 'exec_command',
      'fetch_url', 'search_web',
      'workspace_inspector_agent', 'workspace_search_agent', 'workspace_editor_agent',
      'workspace_command_agent', 'web_research_agent',
      'activate_skill',
    ],
  },
}

function cloneToolPolicySettings(
  policy: AppSettings['toolPolicy'],
): AppSettings['toolPolicy'] {
  return {
    explore: { allowedTools: [...policy.explore.allowedTools] },
    build: { allowedTools: [...policy.build.allowedTools] },
  }
}

function formatBytes(value: number | null): string | null {
  if (!value || value <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatSpeechInstallState(installState: SpeechInspection['installState']): string {
  switch (installState) {
    case 'not_installed': return 'Not installed'
    case 'installing': return 'Installing'
    case 'installed': return 'Installed'
    case 'repairing': return 'Repairing'
    case 'removing': return 'Removing'
    case 'unsupported': return 'Unsupported'
    case 'error': return 'Needs attention'
    default: return installState
  }
}

function formatReadAloudState(state: ReadAloudInspection['state']): string {
  switch (state) {
    case 'missing_assets': return 'Not installed'
    case 'installing': return 'Installing'
    case 'loading': return 'Preparing'
    case 'ready': return 'Ready'
    case 'error': return 'Needs attention'
    case 'unsupported': return 'Unsupported'
    default: return 'Unknown'
  }
}

function buildReadAloudProgressLabel(
  status: ReadAloudInspection | null,
): string | null {
  const progress = status?.installProgress
  if (!progress) return null
  const filename = progress.assetPath.split('/').pop() ?? progress.assetPath
  const downloaded = formatBytes(progress.downloadedBytes) ?? '0 B'
  const total = formatBytes(progress.totalBytes) ?? 'unknown size'
  const percent = progress.percent != null ? `${progress.percent}%` : null
  return [filename, percent, `${downloaded} / ${total}`].filter(Boolean).join(' · ')
}

function formatContextLengthLabel(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value >= 1024 ? `${Math.round(value / 1024)}K` : `${value}`
}

function formatNotificationPermissionLabel(
  status: NotificationPermissionState['status'],
): string {
  switch (status) {
    case 'default': return 'Not requested'
    case 'granted': return 'Allowed'
    case 'denied': return 'Blocked'
    case 'unsupported': return 'Unsupported'
  }
}

function compareModelOptionText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function providerLabelForRuntime(runtimeId: string, runtimeName?: string): string {
  if (runtimeId.startsWith('ollama')) return 'Ollama'
  if (runtimeId.startsWith('lmstudio')) return 'LM Studio'
  if (runtimeId.startsWith('llamacpp')) return 'llama.cpp'
  if (runtimeId.startsWith('omlx')) return 'oMLX'
  return runtimeName?.trim() || runtimeId
}

function apiTypeLabelForRuntime(runtimeId: string): string {
  if (runtimeId.endsWith('-openai')) return 'OpenAI-compatible API'
  if (runtimeId.endsWith('-native')) return 'Native API'
  if (runtimeId.endsWith('-server')) return 'Server API'
  return runtimeId
}

function modelTargetValue(target: {
  modelId: string
  runtimeId: string
}): string {
  return JSON.stringify([target.runtimeId, target.modelId])
}

function sameModelTarget(
  left: { modelId: string; runtimeId: string },
  right: { modelId: string; runtimeId: string },
): boolean {
  return left.modelId === right.modelId && left.runtimeId === right.runtimeId
}

function optionSearchText(option: DefaultModelOption): string {
  return [
    option.label,
    option.providerLabel,
    option.apiTypeLabel,
    option.runtimeId,
    option.modelId,
  ].join(' ').toLowerCase()
}

export function formatDefaultModelOptionLabel(option: DefaultModelOption): string {
  return `${option.label} - ${option.providerLabel} - ${option.apiTypeLabel}`
}

function compareDefaultModelOptions(
  left: DefaultModelOption,
  right: DefaultModelOption,
): number {
  return (
    compareModelOptionText(left.label, right.label)
    || compareModelOptionText(left.providerLabel, right.providerLabel)
    || compareModelOptionText(left.apiTypeLabel, right.apiTypeLabel)
    || compareModelOptionText(left.runtimeId, right.runtimeId)
    || compareModelOptionText(left.modelId, right.modelId)
  )
}

export function groupDefaultModelOptions(options: DefaultModelOption[]): Array<{
  providerLabel: string
  options: DefaultModelOption[]
}> {
  const byProvider = new Map<string, DefaultModelOption[]>()
  for (const option of options) {
    const providerOptions = byProvider.get(option.providerLabel) ?? []
    providerOptions.push(option)
    byProvider.set(option.providerLabel, providerOptions)
  }

  return [...byProvider.entries()]
    .sort(([left], [right]) => compareModelOptionText(left, right))
    .map(([providerLabel, providerOptions]) => ({
      providerLabel,
      options: [...providerOptions].sort(compareDefaultModelOptions),
    }))
}

export function DefaultModelTargetPicker({
  ariaLabel,
  value,
  groups,
  onSelect,
  initialOpen = false,
}: {
  ariaLabel: string
  value: { modelId: string; runtimeId: string }
  groups: Array<{ providerLabel: string; options: DefaultModelOption[] }>
  onSelect: (target: { modelId: string; runtimeId: string }) => void
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedOption = groups
    .flatMap((group) => group.options)
    .find((option) => sameModelTarget(option, value))
  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = normalizedQuery
    ? groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          optionSearchText(option).includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.options.length > 0)
    : groups

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  return (
    <div ref={rootRef} className={`relative ${open ? 'z-30' : 'z-0'}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-700 outline-none transition-colors hover:border-zinc-300 focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:focus:border-indigo-700"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium text-zinc-800 dark:text-zinc-100">
            {selectedOption?.label ?? value.modelId}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {selectedOption
              ? `${selectedOption.providerLabel} · ${selectedOption.apiTypeLabel}`
              : value.runtimeId}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
              <Search size={13} className="shrink-0 text-zinc-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by model, provider, or API..."
                className="min-w-0 flex-1 bg-transparent text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200 dark:placeholder:text-zinc-500"
              />
            </div>
          </div>
          <div
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
            onWheel={(event) => event.stopPropagation()}
          >
            {visibleGroups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-zinc-500 dark:text-zinc-400">
                No models match this filter.
              </div>
            ) : visibleGroups.map((group) => (
              <div key={group.providerLabel}>
                <div className="bg-zinc-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:bg-zinc-950 dark:text-zinc-500">
                  {group.providerLabel}
                </div>
                {group.options.map((option) => {
                  const selected = sameModelTarget(option, value)
                  return (
                    <button
                      key={modelTargetValue(option)}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelect({
                          modelId: option.modelId,
                          runtimeId: option.runtimeId,
                        })
                        setOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                        selected
                          ? 'bg-indigo-600 text-white'
                          : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {option.label}
                        </span>
                        <span
                          className={`mt-0.5 block truncate text-[11px] ${
                            selected ? 'text-indigo-200' : 'text-zinc-400'
                          }`}
                        >
                          {option.apiTypeLabel} · {option.runtimeId}
                        </span>
                      </span>
                      {selected && (
                        <Check size={13} className="shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsModal({
  settings,
  defaultModelSelection,
  models,
  bootstrapState,
  onClose,
  onUpdate,
  initialTab = 'general',
  speechStatus,
  readAloudStatus,
  notificationPermission,
  onInstallSpeech,
  onRepairSpeech,
  onRemoveSpeech,
  onTestReadAloud,
  onRequestNotificationPermission,
  onSendTestNotification,
}: SettingsModalProps) {
  const [local, setLocal] = useState(settings)
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [installedTerminals, setInstalledTerminals] = useState<TerminalAppInfo[]>([])
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false)

  const commitUpdate = (patch: Partial<AppSettings>): void => {
    void Promise.resolve(onUpdate(patch)).catch((error) => {
      console.error('Failed to update settings:', error)
    })
  }

  const handleToolPolicyToggle = (mode: AppToolPolicyMode, toolName: string) => {
    const nextAllowed = new Set(local.toolPolicy[mode].allowedTools)
    if (nextAllowed.has(toolName)) {
      nextAllowed.delete(toolName)
    } else {
      nextAllowed.add(toolName)
    }
    const toolPolicy = {
      ...local.toolPolicy,
      [mode]: {
        allowedTools: TOOL_POLICY_TOOL_ORDER.filter((name) => nextAllowed.has(name)),
      },
    }
    setLocal({ ...local, toolPolicy })
    commitUpdate({ toolPolicy })
  }

  const restoreDefaultToolPolicy = () => {
    const toolPolicy = cloneToolPolicySettings(DEFAULT_TOOL_POLICY)
    setLocal({ ...local, toolPolicy })
    commitUpdate({ toolPolicy })
  }

  useEffect(() => { setLocal(settings) }, [settings])
  useEffect(() => { setActiveTab(initialTab) }, [initialTab])

  useEffect(() => {
    let cancelled = false
    void window.gemmaDesktopBridge.terminals.listInstalled()
      .then((terminals) => { if (!cancelled) setInstalledTerminals(terminals) })
      .catch((error) => { console.error('Failed to inspect installed terminals:', error) })
    return () => { cancelled = true }
  }, [])

  const handleClose = () => {
    void Promise.resolve(onUpdate(local)).catch((error) => {
      console.error('Failed to persist settings before closing:', error)
    })
    onClose()
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      handleClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [local, onUpdate, onClose])

  const handleThemeChange = (theme: AppSettings['theme']) => {
    setLocal({ ...local, theme })
    commitUpdate({ theme })
  }

  const handleOllamaKeepAliveToggle = () => {
    const keepAliveEnabled = !(local.runtimes.ollama?.keepAliveEnabled ?? true)
    const runtimes = {
      ...local.runtimes,
      ollama: { ...local.runtimes.ollama, keepAliveEnabled },
    }
    setLocal({ ...local, runtimes })
    commitUpdate({ runtimes })
  }

  const handleOllamaProfileContextChange = (modelId: string, nextValue: number) => {
    const ollama = {
      ...local.ollama,
      modelProfiles: {
        ...local.ollama.modelProfiles,
        [modelId]: { ...local.ollama.modelProfiles[modelId], num_ctx: nextValue },
      },
    }
    setLocal({ ...local, ollama })
    commitUpdate({ ollama })
  }

  const handleOllamaProfileFieldChange = (
    modelId: string,
    key: 'temperature' | 'top_p' | 'top_k' | 'num_predict' | 'repeat_penalty' | 'seed',
    rawValue: string,
  ) => {
    const nextValue = rawValue.trim().length > 0 ? Number(rawValue) : undefined
    const currentProfile = local.ollama.modelProfiles[modelId] ?? {}
    const ollama = {
      ...local.ollama,
      modelProfiles: {
        ...local.ollama.modelProfiles,
        [modelId]: {
          ...currentProfile,
          [key]: Number.isFinite(nextValue) ? nextValue : undefined,
        },
      },
    }
    setLocal({ ...local, ollama })
  }

  const persistOllamaProfile = (modelId: string) => {
    commitUpdate({
      ollama: {
        ...local.ollama,
        modelProfiles: {
          ...local.ollama.modelProfiles,
          [modelId]: { ...local.ollama.modelProfiles[modelId] },
        },
      },
    })
  }

  const handlePickDefaultDirectory = async () => {
    const picked = await window.gemmaDesktopBridge.folders.pickDirectory(
      local.defaultProjectDirectory,
    )
    if (!picked) return
    const next = { ...local, defaultProjectDirectory: picked }
    setLocal(next)
    commitUpdate({ defaultProjectDirectory: picked })
  }

  const openExternalTarget = (target: string) => {
    void window.gemmaDesktopBridge.links.openTarget(target).catch((error) => {
      console.error(`Failed to open external link: ${target}`, error)
    })
  }

  const handlePreviewVoice = async () => {
    setPreviewBusy(true)
    try {
      await Promise.resolve(onTestReadAloud({
        voice: local.readAloud.defaultVoice,
        speed: local.readAloud.speed,
      }))
    } catch (error) {
      console.error('Failed to preview read aloud voice:', error)
    } finally {
      setPreviewBusy(false)
    }
  }

  const readAloudProgressLabel = buildReadAloudProgressLabel(readAloudStatus)

  const findTargetModel = (target: {
    modelId: string
    runtimeId: string
  }): ModelSummary | undefined =>
    models.find(
      (model) =>
        model.id === target.modelId
        && model.runtimeId === target.runtimeId,
    )
  const defaultModelOptions = ((): DefaultModelOption[] => {
    const byValue = new Map<string, DefaultModelOption>()
    const addTarget = (
      target: { modelId: string; runtimeId: string },
    ) => {
      const value = modelTargetValue(target)
      if (byValue.has(value)) {
        return
      }
      const targetModel = findTargetModel(target)
      byValue.set(value, {
        ...target,
        label: targetModel?.name ?? target.modelId,
        providerLabel: providerLabelForRuntime(
          target.runtimeId,
          targetModel?.runtimeName,
        ),
        apiTypeLabel: apiTypeLabelForRuntime(target.runtimeId),
      })
    }

    addTarget(local.modelSelection.mainModel)
    addTarget(local.modelSelection.helperModel)
    addTarget(defaultModelSelection.mainModel)
    addTarget(defaultModelSelection.helperModel)
    for (const model of models) {
      addTarget({
        modelId: model.id,
        runtimeId: model.runtimeId,
      })
    }
    return [...byValue.values()]
  })()
  const defaultModelOptionGroups = groupDefaultModelOptions(defaultModelOptions)
  const updateModelSelectionTarget = (
    key: 'mainModel' | 'helperModel',
    target: { modelId: string; runtimeId: string },
  ) => {
    const modelSelection = {
      ...local.modelSelection,
      [key]: target,
    }
    setLocal({ ...local, modelSelection })
    commitUpdate({ modelSelection })
  }

  const modelSelectionMatchesBuiltIn =
    local.modelSelection.mainModel.modelId === defaultModelSelection.mainModel.modelId
    && local.modelSelection.mainModel.runtimeId === defaultModelSelection.mainModel.runtimeId
    && local.modelSelection.helperModel.modelId === defaultModelSelection.helperModel.modelId
    && local.modelSelection.helperModel.runtimeId === defaultModelSelection.helperModel.runtimeId

  const resetModelSelection = () => {
    const modelSelection = {
      mainModel: { ...defaultModelSelection.mainModel },
      helperModel: { ...defaultModelSelection.helperModel },
    }
    setLocal({ ...local, modelSelection })
    commitUpdate({ modelSelection })
  }

  const previewButtonLabel =
    readAloudStatus?.state === 'installing' && readAloudProgressLabel
      ? `Installing… ${readAloudStatus.installProgress?.percent ?? 0}%`
      : previewBusy
        ? 'Previewing…'
        : 'Preview Voice'

  return (
    <div className="absolute inset-x-0 bottom-0 top-12 z-50 flex items-center justify-center overflow-hidden bg-black/40 px-4 py-6 backdrop-blur-sm sm:px-6">
      <div className="no-drag flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">
            Settings
          </h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Save and close settings"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Settings sections"
            className="scrollbar-thin w-44 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50/60 px-2 py-3 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            {TAB_ENTRIES.map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                aria-current={activeTab === tab ? 'page' : undefined}
                className={`mb-0.5 flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-6 px-8 py-6">
              {activeTab === 'general' && (
                <>
                  <SettingsSection title="Appearance" description="Theme and visual ambiance.">
                    <SettingsRow
                      label="Theme"
                      description="Match the app to your preferred contrast."
                    >
                      <div className="mt-1 inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                        {(['light', 'dark', 'system'] as const).map((t) => (
                          <button
                            key={t}
                            onClick={() => handleThemeChange(t)}
                            className={`rounded px-3 py-1 text-xs font-medium capitalize transition-colors ${
                              local.theme === t
                                ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      label="Ambient effects"
                      description="Subtle calming visuals while the model is thinking."
                      control={
                        <Toggle
                          ariaLabel="Toggle ambient effects"
                          checked={local.ambientEffects.enabled}
                          onChange={() => {
                            const ambientEffects = {
                              ...local.ambientEffects,
                              enabled: !local.ambientEffects.enabled,
                            }
                            setLocal({ ...local, ambientEffects })
                            commitUpdate({ ambientEffects })
                          }}
                        />
                      }
                    />
                  </SettingsSection>

                  <SettingsSection title="Composer" description="How the message input behaves.">
                    <SettingsRow
                      label="Enter to send"
                      description="Press Enter to send messages, Shift+Enter for newline."
                      control={
                        <Toggle
                          ariaLabel="Toggle Enter to send"
                          checked={local.enterToSend}
                          onChange={() => {
                            const enterToSend = !local.enterToSend
                            setLocal({ ...local, enterToSend })
                            commitUpdate({ enterToSend })
                          }}
                        />
                      }
                    />
                  </SettingsSection>

                  <SettingsSection
                    title="Default Models"
                    description="Main is the saved default for new conversations, research, and automations. Helper is the saved default for lightweight background work."
                    trailing={
                      <Button
                        variant="secondary"
                        disabled={modelSelectionMatchesBuiltIn}
                        onClick={resetModelSelection}
                        title="Restore the built-in Gemma defaults"
                      >
                        <RotateCcw size={12} />
                        Reset Defaults
                      </Button>
                    }
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <SettingsField
                        label="Main Model"
                        hint="Used for new conversations, research, and automations. The conversation model picker can override per-session."
                      >
                        <DefaultModelTargetPicker
                          ariaLabel="Default main model"
                          value={local.modelSelection.mainModel}
                          groups={defaultModelOptionGroups}
                          onSelect={(target) =>
                            updateModelSelectionTarget('mainModel', target)}
                        />
                      </SettingsField>

                      <SettingsField
                        label="Helper Model"
                        hint={
                          <>
                            Used for titles and helper turns. Bootstrap target:
                            {' '}
                            <code>{bootstrapState.helperRuntimeId}/{bootstrapState.helperModelId}</code>.
                          </>
                        }
                      >
                        <DefaultModelTargetPicker
                          ariaLabel="Default helper model"
                          value={local.modelSelection.helperModel}
                          groups={defaultModelOptionGroups}
                          onSelect={(target) =>
                            updateModelSelectionTarget('helperModel', target)}
                        />
                      </SettingsField>
                    </div>
                  </SettingsSection>

                  <SettingsSection
                    title="Workspace"
                    description="Defaults for project locations and external tools."
                  >
                    <SettingsField
                      label="Project Picker Start Folder"
                      hint="The starting location when you pick a folder for a new project."
                    >
                      <div className="flex gap-2">
                        <TextInput
                          type="text"
                          value={local.defaultProjectDirectory}
                          onChange={(e) => setLocal({ ...local, defaultProjectDirectory: e.target.value })}
                          onBlur={() => commitUpdate({ defaultProjectDirectory: local.defaultProjectDirectory })}
                          className="font-mono text-xs"
                        />
                        <Button variant="secondary" onClick={handlePickDefaultDirectory}>
                          <FolderOpen size={12} />
                          Browse
                        </Button>
                      </div>
                    </SettingsField>

                    <SettingsField
                      label="Preferred Terminal"
                      hint={
                        installedTerminals.length === 0
                          ? 'No supported terminal apps detected. The sidebar terminal button stays disabled until one is available.'
                          : 'The terminal icon in each project header opens that folder in this app.'
                      }
                    >
                      <Select
                        value={local.terminal.preferredAppId ?? ''}
                        onChange={(event) => {
                          const preferredAppId = event.target.value.trim() || null
                          const terminal = { ...local.terminal, preferredAppId }
                          setLocal({ ...local, terminal })
                          commitUpdate({ terminal })
                        }}
                      >
                        <option value="">
                          Automatic ({installedTerminals[0]?.label ?? 'first detected terminal'})
                        </option>
                        {installedTerminals.map((terminal) => (
                          <option key={terminal.id} value={terminal.id}>
                            {terminal.label}
                          </option>
                        ))}
                      </Select>
                    </SettingsField>
                  </SettingsSection>
                </>
              )}

              {activeTab === 'ollama' && (
                <SettingsSection
                  title="Managed Ollama Runtime Profiles"
                  description="Gemma Desktop sends explicit Ollama options on native chat requests and warm-loads instead of relying on hidden server defaults. Profiles below are enforced on ollama-native; the OpenAI-compatible endpoint cannot set context size per request."
                >
                  {listKnownReasoningControlModels().map((model) => {
                    const runtimeModel = models.find((entry) =>
                      entry.id === model.tag && entry.runtimeId === 'ollama-native',
                    )
                    const profile = local.ollama.modelProfiles[model.tag] ?? {}
                    const baseParameters = runtimeModel?.runtimeConfig?.baseParameters
                    const liveConfig = runtimeModel?.runtimeConfig
                    const liveContextLabel = formatContextLengthLabel(
                      liveConfig?.loadedContextLength ?? runtimeModel?.contextLength,
                    )
                    const nominalContextLabel = formatContextLengthLabel(
                      liveConfig?.nominalContextLength,
                    )
                    const gpuResidencyLabel =
                      typeof liveConfig?.approxGpuResidencyPercent === 'number'
                        ? `${liveConfig.approxGpuResidencyPercent}% GPU`
                        : null
                    const requestedSummary = (Object.entries(profile) as Array<[string, number | undefined]>)
                      .flatMap(([key, value]) => value != null ? [`${key}=${value}`] : [])
                      .join(' · ') || 'no explicit profile'

                    return (
                      <div key={model.tag} className="space-y-3 border-t border-zinc-100 pt-4 first:border-t-0 first:pt-0 dark:border-zinc-900">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                            {model.label}
                          </div>
                          <Tag tone="success">Ollama</Tag>
                          <Tag>{runtimeModel?.status ?? 'not visible'}</Tag>
                          {liveContextLabel ? <Tag>live {liveContextLabel}</Tag> : null}
                          {gpuResidencyLabel ? <Tag>{gpuResidencyLabel}</Tag> : null}
                        </div>

                        <MetaList
                          items={[
                            <span key="base">
                              Base params: {baseParameters
                                ? Object.entries(baseParameters).map(([k, v]) => `${k}=${String(v)}`).join(' · ')
                                : 'not available yet'}
                            </span>,
                            <span key="ctx">
                              Nominal: {nominalContextLabel ?? model.contextBadge} · Live: {liveContextLabel ?? 'not loaded'}
                            </span>,
                          ]}
                        />

                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                          <SettingsField label="Context Length">
                            <Select
                              value={profile.num_ctx ?? ''}
                              onChange={(event) => {
                                const nextValue = Number(event.target.value)
                                if (Number.isFinite(nextValue) && nextValue > 0) {
                                  handleOllamaProfileContextChange(model.tag, nextValue)
                                }
                              }}
                            >
                              {OLLAMA_CONTEXT_PRESET_VALUES.map((value) => (
                                <option key={value} value={value}>
                                  {formatOllamaContextPreset(value)} ({value.toLocaleString()})
                                </option>
                              ))}
                            </Select>
                          </SettingsField>

                          <SettingsField label="Temperature">
                            <TextInput
                              type="number"
                              step="0.05"
                              value={profile.temperature ?? ''}
                              onChange={(e) => handleOllamaProfileFieldChange(model.tag, 'temperature', e.target.value)}
                              onBlur={() => persistOllamaProfile(model.tag)}
                            />
                          </SettingsField>

                          <SettingsField label="Top P">
                            <TextInput
                              type="number"
                              step="0.01"
                              value={profile.top_p ?? ''}
                              onChange={(e) => handleOllamaProfileFieldChange(model.tag, 'top_p', e.target.value)}
                              onBlur={() => persistOllamaProfile(model.tag)}
                            />
                          </SettingsField>

                          <SettingsField label="Top K">
                            <TextInput
                              type="number"
                              step="1"
                              value={profile.top_k ?? ''}
                              onChange={(e) => handleOllamaProfileFieldChange(model.tag, 'top_k', e.target.value)}
                              onBlur={() => persistOllamaProfile(model.tag)}
                            />
                          </SettingsField>

                          <SettingsField label="Num Predict">
                            <TextInput
                              type="number"
                              step="1"
                              placeholder="leave unset"
                              value={profile.num_predict ?? ''}
                              onChange={(e) => handleOllamaProfileFieldChange(model.tag, 'num_predict', e.target.value)}
                              onBlur={() => persistOllamaProfile(model.tag)}
                            />
                          </SettingsField>

                          <SettingsField label="Repeat Penalty">
                            <TextInput
                              type="number"
                              step="0.05"
                              placeholder="leave unset"
                              value={profile.repeat_penalty ?? ''}
                              onChange={(e) => handleOllamaProfileFieldChange(model.tag, 'repeat_penalty', e.target.value)}
                              onBlur={() => persistOllamaProfile(model.tag)}
                            />
                          </SettingsField>
                        </div>

                        <Note>Requested now: {requestedSummary}</Note>
                      </div>
                    )
                  })}
                </SettingsSection>
              )}

              {activeTab === 'notifications' && (
                <SettingsSection
                  title="macOS Notifications"
                  description="Native notifications let Gemma Desktop reach you when work finishes or needs input while you are somewhere else."
                  trailing={
                    <Toggle
                      ariaLabel="Toggle notifications"
                      checked={local.notifications.enabled}
                      onChange={() => {
                        const notifications = { ...local.notifications, enabled: !local.notifications.enabled }
                        setLocal({ ...local, notifications })
                        commitUpdate({ notifications })
                      }}
                    />
                  }
                >
                  <SettingsRow
                    label="System Permission"
                    description={
                      notificationPermission.status === 'granted'
                        ? 'macOS is allowing Gemma Desktop to show notifications.'
                        : notificationPermission.status === 'denied'
                          ? 'macOS blocked notifications. Open System Settings › Notifications › Gemma Desktop to turn them back on.'
                          : notificationPermission.status === 'unsupported'
                            ? 'This build does not currently support the macOS notification flow.'
                            : 'Gemma Desktop has not asked macOS for notification permission yet.'
                    }
                    control={
                      <div className="flex items-center gap-2">
                        <Tag>{formatNotificationPermissionLabel(notificationPermission.status)}</Tag>
                        {notificationPermission.status === 'default' && (
                          <Button
                            variant="primary"
                            onClick={() => {
                              void Promise.resolve(onRequestNotificationPermission()).catch((error) => {
                                console.error('Failed to request notification permission:', error)
                              })
                            }}
                          >
                            <Bell size={12} />
                            Allow
                          </Button>
                        )}
                        {notificationPermission.status === 'granted' && (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              void Promise.resolve(onSendTestNotification()).catch((error) => {
                                console.error('Failed to send test notification:', error)
                              })
                            }}
                          >
                            Send Test
                          </Button>
                        )}
                      </div>
                    }
                  />

                  {notificationPermission.promptPending && notificationPermission.status === 'default' ? (
                    <Note tone="warning">
                      A notification was suppressed because macOS permission has not been granted yet.
                    </Note>
                  ) : null}

                  {([
                    ['automationFinished', 'Automation Finished', 'Notify whenever an automation run ends, even if Gemma Desktop is not focused.'],
                    ['actionRequired', 'Action Required', 'Notify when plan mode or tool work pauses because Gemma Desktop is waiting on you and the window is not focused.'],
                    ['sessionCompleted', 'Session Complete', 'Notify when a conversation finishes in the background or in a different visible surface.'],
                  ] as const).map(([key, label, description]) => (
                    <SettingsRow
                      key={key}
                      label={label}
                      description={description}
                      control={
                        <Toggle
                          ariaLabel={`Toggle ${label}`}
                          checked={local.notifications[key]}
                          disabled={!local.notifications.enabled || notificationPermission.status === 'unsupported'}
                          onChange={() => {
                            const notifications = { ...local.notifications, [key]: !local.notifications[key] }
                            setLocal({ ...local, notifications })
                            commitUpdate({ notifications })
                          }}
                        />
                      }
                    />
                  ))}

                  <Note>Turning the master switch off pauses delivery without clearing individual category choices.</Note>
                </SettingsSection>
              )}

              {activeTab === 'context' && (
                <>
                  <SettingsSection
                    title="Auto Compaction"
                    description="Compact long sessions before the next turn starts so local models keep enough clean context headroom."
                  >
                    <SettingsRow
                      label="Auto compact"
                      description="Run compaction when context fills past the threshold below."
                      control={
                        <Toggle
                          ariaLabel="Toggle auto compaction"
                          checked={local.compaction.autoCompactEnabled}
                          onChange={() => {
                            const compaction = { ...local.compaction, autoCompactEnabled: !local.compaction.autoCompactEnabled }
                            setLocal({ ...local, compaction })
                            commitUpdate({ compaction })
                          }}
                        />
                      }
                    />

                    <SettingsField
                      label="Compact at context %"
                      hint="45% is the conservative default for local/tool-heavy sessions."
                    >
                      <TextInput
                        type="number"
                        min={5}
                        max={90}
                        disabled={!local.compaction.autoCompactEnabled}
                        value={local.compaction.autoCompactThresholdPercent}
                        onChange={(e) => {
                          const nextValue = Math.min(90, Math.max(5, Number(e.target.value) || 45))
                          setLocal({
                            ...local,
                            compaction: { ...local.compaction, autoCompactThresholdPercent: nextValue },
                          })
                        }}
                        onBlur={() => commitUpdate({ compaction: local.compaction })}
                      />
                    </SettingsField>
                  </SettingsSection>

                  <SettingsSection
                    title="Automations"
                    description="Behavior for scheduled tasks and long-running runs."
                  >
                    <SettingsRow
                      label="Keep automations awake"
                      description="On macOS, prevent sleep while scheduled tasks are running."
                      control={
                        <Toggle
                          ariaLabel="Toggle keep automations awake"
                          checked={local.automations.keepAwakeWhileRunning}
                          onChange={() => {
                            const automations = { ...local.automations, keepAwakeWhileRunning: !local.automations.keepAwakeWhileRunning }
                            setLocal({ ...local, automations })
                            commitUpdate({ automations })
                          }}
                        />
                      }
                    />
                  </SettingsSection>
                </>
              )}

              {activeTab === 'runtimes' && (
                <>
                  <SettingsSection
                    title="Ollama"
                    description="Endpoint and keep-alive coordination. Gemma Desktop coordinates primary model loading itself."
                  >
                    <SettingsField
                      label="Endpoint"
                      hint={
                        <>
                          Current target:
                          {' '}
                          <code>helper={bootstrapState.helperRuntimeId}/{bootstrapState.helperModelId}</code>
                          {', '}
                          <code>numParallel={local.runtimes.ollama?.numParallel ?? 1}</code>
                          {', '}
                          <code>maxLoadedModels={local.runtimes.ollama?.maxLoadedModels ?? 2}</code>
                          {', '}
                          <code>keepAlive={(local.runtimes.ollama?.keepAliveEnabled ?? true) ? 'on' : 'off'}</code>.
                        </>
                      }
                    >
                      <TextInput
                        type="text"
                        value={local.runtimes.ollama?.endpoint ?? ''}
                        onChange={(e) => {
                          const runtimes = {
                            ...local.runtimes,
                            ollama: { ...local.runtimes.ollama, endpoint: e.target.value },
                          }
                          setLocal({ ...local, runtimes })
                        }}
                        onBlur={() => commitUpdate({ runtimes: local.runtimes })}
                        className="font-mono text-xs"
                      />
                    </SettingsField>

                    <SettingsRow
                      label="Keep Ollama models warm"
                      description="Preload helper and primary models and send long keep-alive hints. Doctor reports server-level setting drift so you can adjust Ollama manually."
                      control={
                        <Toggle
                          ariaLabel="Toggle Ollama model keep-alive"
                          checked={local.runtimes.ollama?.keepAliveEnabled ?? true}
                          onChange={handleOllamaKeepAliveToggle}
                        />
                      }
                    />
                  </SettingsSection>

                  <SettingsSection
                    title="LM Studio"
                    description="Saved defaults can target LM Studio too. Gemma Desktop blocks conflicting primary models from starting at the same time."
                  >
                    <SettingsField
                      label="Endpoint"
                      hint={
                        <>
                          Current default:
                          {' '}
                          <code>maxConcurrentPredictions={local.runtimes.lmstudio?.maxConcurrentPredictions ?? 4}</code>.
                        </>
                      }
                    >
                      <TextInput
                        type="text"
                        value={local.runtimes.lmstudio?.endpoint ?? ''}
                        onChange={(e) => {
                          const runtimes = {
                            ...local.runtimes,
                            lmstudio: { ...local.runtimes.lmstudio, endpoint: e.target.value },
                          }
                          setLocal({ ...local, runtimes })
                        }}
                        onBlur={() => commitUpdate({ runtimes: local.runtimes })}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                  </SettingsSection>

                  <SettingsSection title="llama.cpp" description="Endpoint settings stay editable here.">
                    <SettingsField label="Endpoint">
                      <TextInput
                        type="text"
                        value={local.runtimes.llamacpp?.endpoint ?? ''}
                        onChange={(e) => {
                          const runtimes = {
                            ...local.runtimes,
                            llamacpp: { ...local.runtimes.llamacpp, endpoint: e.target.value },
                          }
                          setLocal({ ...local, runtimes })
                        }}
                        onBlur={() => commitUpdate({ runtimes: local.runtimes })}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                  </SettingsSection>

                  <SettingsSection
                    title="oMLX"
                    description="External OpenAI-compatible oMLX servers are detected when reachable. Gemma Desktop lists visible models, but does not install or start oMLX."
                  >
                    <SettingsField label="Endpoint">
                      <TextInput
                        type="text"
                        value={local.runtimes.omlx?.endpoint ?? ''}
                        onChange={(e) => {
                          const runtimes = {
                            ...local.runtimes,
                            omlx: { ...local.runtimes.omlx, endpoint: e.target.value },
                          }
                          setLocal({ ...local, runtimes })
                        }}
                        onBlur={() => commitUpdate({ runtimes: local.runtimes })}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                    <SettingsField
                      label="API key / PIN"
                      hint="Optional Bearer token for oMLX servers that protect OpenAI-compatible endpoints."
                    >
                      <TextInput
                        type="password"
                        autoComplete="off"
                        value={local.runtimes.omlx?.apiKey ?? ''}
                        onChange={(e) => {
                          const runtimes = {
                            ...local.runtimes,
                            omlx: { ...local.runtimes.omlx, apiKey: e.target.value },
                          }
                          setLocal({ ...local, runtimes })
                        }}
                        onBlur={() => commitUpdate({ runtimes: local.runtimes })}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                  </SettingsSection>
                </>
              )}

              {activeTab === 'speech' && (
                <SettingsSection
                  title="Speech Input"
                  description="Managed whisper.cpp powers the composer microphone button. Runs separately from chat models."
                  trailing={
                    <Toggle
                      ariaLabel="Toggle speech input"
                      checked={local.speech.enabled}
                      onChange={() => {
                        const speech = { ...local.speech, enabled: !local.speech.enabled }
                        setLocal({ ...local, speech })
                        commitUpdate({ speech })
                      }}
                    />
                  }
                >
                  <SettingsRow
                    label="Status"
                    description={speechStatus?.detail ?? 'Checking Managed whisper.cpp status…'}
                    control={
                      <Tag tone={speechStatus?.installState === 'error' ? 'warning' : 'neutral'}>
                        {formatSpeechInstallState(speechStatus?.installState ?? 'not_installed')}
                      </Tag>
                    }
                  >
                    {speechStatus?.lastError ? (
                      <Note tone="warning">{speechStatus.lastError}</Note>
                    ) : null}
                  </SettingsRow>

                  <SettingsRow
                    label="Provider"
                    description={`${speechStatus?.providerLabel ?? 'Managed whisper.cpp'} · ${speechStatus?.modelLabel ?? 'large-v3-turbo-q5_0'}`}
                  >
                    <MetaList
                      items={[
                        formatBytes(speechStatus?.networkDownloadBytes ?? null) ? (
                          <span key="dl">Download: {formatBytes(speechStatus?.networkDownloadBytes ?? null)}</span>
                        ) : null,
                        formatBytes(speechStatus?.diskUsageBytes ?? null) ? (
                          <span key="size">Installed: {formatBytes(speechStatus?.diskUsageBytes ?? null)}</span>
                        ) : null,
                        speechStatus?.runtimeVersion ? (
                          <span key="ver">Runtime: {speechStatus.runtimeVersion}</span>
                        ) : null,
                        speechStatus?.installLocation ? (
                          <span key="path" className="truncate font-mono">{speechStatus.installLocation}</span>
                        ) : null,
                      ].filter((item): item is ReactElement => item !== null)}
                    />
                  </SettingsRow>

                  <div className="flex flex-wrap items-center gap-2">
                    {(speechStatus?.installState === 'not_installed'
                      || speechStatus?.installState === 'unsupported'
                      || !speechStatus?.installed) && (
                      <Button
                        variant="primary"
                        onClick={() => {
                          void Promise.resolve(onInstallSpeech()).catch((error) => {
                            console.error('Failed to install speech runtime:', error)
                          })
                        }}
                        disabled={speechStatus?.busy || speechStatus?.supported === false}
                      >
                        {speechStatus?.busy ? <Loader2 size={12} className="animate-spin" /> : null}
                        Install
                      </Button>
                    )}
                    {(speechStatus?.installState === 'error' || speechStatus?.installed) && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void Promise.resolve(onRepairSpeech()).catch((error) => {
                            console.error('Failed to repair speech runtime:', error)
                          })
                        }}
                        disabled={speechStatus?.busy || speechStatus?.supported === false}
                      >
                        {speechStatus?.busy ? <Loader2 size={12} className="animate-spin" /> : null}
                        Repair
                      </Button>
                    )}
                    {speechStatus?.installed ? (
                      <Button
                        variant="danger"
                        onClick={() => {
                          void Promise.resolve(onRemoveSpeech()).catch((error) => {
                            console.error('Failed to remove speech runtime:', error)
                          })
                        }}
                        disabled={speechStatus.busy}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>

                  <Note>
                    Speech installs into Gemma Desktop's app data when this build has a real installer source. Development builds can also bootstrap from a local whisper.cpp checkout. No system Python is required.
                  </Note>
                </SettingsSection>
              )}

              {activeTab === 'voice' && (
                <SettingsSection
                  title="Read Aloud"
                  description="Kokoro voice output reads assistant responses aloud without requiring Python or a separate runtime install."
                  trailing={
                    <Toggle
                      ariaLabel="Toggle read aloud"
                      checked={local.readAloud.enabled}
                      onChange={() => {
                        const readAloud = { ...local.readAloud, enabled: !local.readAloud.enabled }
                        setLocal({ ...local, readAloud })
                        commitUpdate({ readAloud })
                      }}
                    />
                  }
                >
                  <SettingsRow
                    label="Status"
                    description={readAloudStatus?.detail ?? 'Checking Kokoro voice assets…'}
                    control={
                      <Tag tone={readAloudStatus?.state === 'error' ? 'warning' : 'neutral'}>
                        {formatReadAloudState(readAloudStatus?.state ?? 'missing_assets')}
                      </Tag>
                    }
                  >
                    {readAloudStatus?.lastError ? (
                      <Note tone="warning">{readAloudStatus.lastError}</Note>
                    ) : null}
                    {readAloudStatus?.installProgress ? (
                      <div className="mt-2 space-y-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-[width] duration-200"
                            style={{ width: `${readAloudStatus.installProgress.percent ?? 0}%` }}
                          />
                        </div>
                        <Note>{readAloudProgressLabel}</Note>
                      </div>
                    ) : null}
                  </SettingsRow>

                  <SettingsRow
                    label="Provider"
                    description={[
                      readAloudStatus?.providerLabel ?? 'Kokoro',
                      readAloudStatus?.modelLabel ?? 'Kokoro 82M',
                      readAloudStatus?.dtype ?? 'q8',
                      readAloudStatus?.backend ?? 'cpu',
                    ].join(' · ')}
                  >
                    <MetaList
                      items={[
                        formatBytes(readAloudStatus?.bundledBytes ?? null) ? (
                          <span key="size">Installed: {formatBytes(readAloudStatus?.bundledBytes ?? null)}</span>
                        ) : null,
                        readAloudStatus?.assetRoot ? (
                          <span key="path" className="truncate font-mono">{readAloudStatus.assetRoot}</span>
                        ) : null,
                      ].filter((item): item is ReactElement => item !== null)}
                    />
                  </SettingsRow>

                  <SettingsField label="Voice">
                    <Select
                      value={local.readAloud.defaultVoice}
                      onChange={(event) => {
                        const readAloud = {
                          ...local.readAloud,
                          defaultVoice: event.target.value as AppSettings['readAloud']['defaultVoice'],
                        }
                        setLocal({ ...local, readAloud })
                        commitUpdate({ readAloud })
                      }}
                    >
                      {READ_ALOUD_VOICE_OPTIONS.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label} · {voice.accent} · {voice.gender}
                        </option>
                      ))}
                    </Select>
                  </SettingsField>

                  <SettingsField
                    label={`Speed · ${local.readAloud.speed.toFixed(2)}x`}
                    hint="Adjust how quickly Gemma Desktop speaks generated responses."
                  >
                    <input
                      type="range"
                      min={0.7}
                      max={1.3}
                      step={0.05}
                      value={local.readAloud.speed}
                      onChange={(event) => {
                        const readAloud = { ...local.readAloud, speed: clampReadAloudSpeed(event.target.value) }
                        setLocal({ ...local, readAloud })
                      }}
                      onMouseUp={() => commitUpdate({ readAloud: local.readAloud })}
                      onTouchEnd={() => commitUpdate({ readAloud: local.readAloud })}
                      onBlur={() => commitUpdate({ readAloud: local.readAloud })}
                      className="w-full accent-indigo-600"
                    />
                  </SettingsField>

                  <Button
                    variant="primary"
                    onClick={() => { void handlePreviewVoice() }}
                    disabled={
                      previewBusy
                      || !local.readAloud.enabled
                      || !readAloudStatus?.supported
                      || readAloudStatus.state === 'installing'
                      || readAloudStatus.state === 'loading'
                    }
                  >
                    {previewBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                    {previewButtonLabel}
                  </Button>

                  <Note>
                    Gemma Desktop downloads Kokoro voice files automatically the first time you preview or read a response aloud, then reuses them locally one message at a time.
                  </Note>
                </SettingsSection>
              )}

              {activeTab === 'chrome' && (
                <SettingsSection
                  title="Chrome DevTools"
                  description="Opt into the advanced Chrome DevTools MCP integration for live Chrome debugging. Built-in Browser stays available by default; Build chats can flip to Chrome DevTools when enabled here."
                  trailing={
                    <Toggle
                      ariaLabel="Toggle Chrome DevTools"
                      checked={local.tools.chromeMcp.enabled}
                      onChange={() => {
                        const tools = {
                          ...local.tools,
                          chromeMcp: { ...local.tools.chromeMcp, enabled: !local.tools.chromeMcp.enabled },
                        }
                        setLocal({ ...local, tools })
                        commitUpdate({ tools })
                      }}
                    />
                  }
                >
                  <SettingsRow
                    label="Availability"
                    description="Built-in Browser is always available to the agent. Chrome DevTools appears as a Build-only per-conversation toggle once enabled."
                  />
                  <SettingsRow
                    label="Approval Behavior"
                    description="Built-in Browser actions run immediately. Chrome DevTools asks for approval before page-mutating actions in your live Chrome session."
                  />
                  <SettingsRow
                    label="Managed Browser Status"
                    description={local.tools.chromeMcp.lastStatus?.message ?? 'Managed browser has not been used yet.'}
                  >
                    {local.tools.chromeMcp.lastStatus?.checkedAt ? (
                      <Note>
                        Updated {new Date(local.tools.chromeMcp.lastStatus.checkedAt).toLocaleString()}
                      </Note>
                    ) : null}
                  </SettingsRow>
                </SettingsSection>
              )}

              {activeTab === 'integrations' && (
                <>
                  <SettingsSection
                    title="Gemini CLI (Ask Gemini)"
                    description={
                      <>
                        The <code>ask_gemini</code> tool sends second-opinion prompts to the locally installed Gemini CLI.
                      </>
                    }
                  >
                    <SettingsField
                      label="Model"
                      hint={
                        <>
                          Defaults to <code>{ASK_GEMINI_DEFAULT_MODEL}</code>. Tool calls can request a one-off model override.
                        </>
                      }
                    >
                      <TextInput
                        type="text"
                        spellCheck={false}
                        value={local.integrations.geminiCli.model}
                        onChange={(e) => {
                          const integrations = {
                            ...local.integrations,
                            geminiCli: { ...local.integrations.geminiCli, model: e.target.value },
                          }
                          setLocal({ ...local, integrations })
                          commitUpdate({ integrations })
                        }}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                  </SettingsSection>

                  <SettingsSection
                    title="Gemini API (web search)"
                    description={
                      <>
                        The <code>search_web</code> tool grounds Gemini search through the official Gemini API. Paste an API key from{' '}
                        <a
                          href="https://aistudio.google.com/app/apikey"
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 underline hover:text-indigo-700 dark:text-indigo-400"
                        >
                          aistudio.google.com/app/apikey
                        </a>
                        . Without a key, web search returns a clear failure to the agent.
                      </>
                    }
                  >
                    <SettingsField label="API key">
                      <div className="relative">
                        <TextInput
                          type={showGeminiApiKey ? 'text' : 'password'}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="AIza..."
                          value={local.integrations.geminiApi.apiKey}
                          onChange={(e) => {
                            const integrations = {
                              ...local.integrations,
                              geminiApi: { ...local.integrations.geminiApi, apiKey: e.target.value },
                            }
                            setLocal({ ...local, integrations })
                            commitUpdate({ integrations })
                          }}
                          className="pr-9 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => setShowGeminiApiKey((prev) => !prev)}
                          title={showGeminiApiKey ? 'Hide API key' : 'Show API key'}
                          className="absolute inset-y-0 right-1.5 flex items-center rounded-md px-1.5 text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                        >
                          {showGeminiApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </SettingsField>

                    <SettingsField
                      label="Model"
                      hint={
                        <>
                          Defaults to <code>gemini-3-flash-preview</code>. Any Gemini model that supports the <code>googleSearch</code> tool will work.
                        </>
                      }
                    >
                      <TextInput
                        type="text"
                        value={local.integrations.geminiApi.model}
                        onChange={(e) => {
                          const integrations = {
                            ...local.integrations,
                            geminiApi: { ...local.integrations.geminiApi, model: e.target.value },
                          }
                          setLocal({ ...local, integrations })
                          commitUpdate({ integrations })
                        }}
                        className="font-mono text-xs"
                      />
                    </SettingsField>
                  </SettingsSection>
                </>
              )}

              {activeTab === 'tools' && (
                <SettingsSection
                  title="Tool Policy"
                  description="Explore, Plan, and Build each have their own tool allow-list. These settings are enforced again at execution time, even if a prompt asks for more."
                  trailing={
                    <Button variant="secondary" onClick={restoreDefaultToolPolicy}>
                      <RotateCcw size={12} />
                      Restore Defaults
                    </Button>
                  }
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-2 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
                    <div>Tool</div>
                    <div className="text-center">Explore</div>
                    <div className="text-center">Build</div>
                  </div>

                  {TOOL_POLICY_SECTIONS.map((section) => (
                    <div key={section.title} className="space-y-1.5">
                      <div className="px-1">
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          {section.title}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
                          {section.description}
                        </div>
                      </div>
                      <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
                        {section.tools.map((tool, index) => (
                          <div
                            key={tool.name}
                            className={`grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-2 px-3 py-2 ${
                              index > 0 ? 'border-t border-zinc-100 dark:border-zinc-900' : ''
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                {tool.label}
                              </div>
                              <div className="mt-0.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
                                {tool.description}
                              </div>
                            </div>
                            {(['explore', 'build'] as const).map((mode) => {
                              const enabled = local.toolPolicy[mode].allowedTools.includes(tool.name)
                              return (
                                <button
                                  key={`${tool.name}-${mode}`}
                                  onClick={() => handleToolPolicyToggle(mode, tool.name)}
                                  className={`h-7 rounded text-[11px] font-medium transition-colors ${
                                    enabled
                                      ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                      : 'border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900'
                                  }`}
                                  title={`${enabled ? 'Disable' : 'Enable'} ${tool.label} in ${mode} mode`}
                                >
                                  {enabled ? 'On' : 'Off'}
                                </button>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  <Note>Disabling a tool here hard-blocks it even if a prompt or mode preset would otherwise allow it.</Note>
                </SettingsSection>
              )}

              {activeTab === 'about' && (
                <>
                  <SettingsSection
                    title={ABOUT_SCREEN_INTRO.title}
                    description={
                      <>
                        {ABOUT_SCREEN_INTRO.description}
                        <br />
                        <span className="mt-1 inline-block text-[11px] text-zinc-500 dark:text-zinc-400">
                          {ABOUT_SCREEN_INTRO.scopeNote}
                        </span>
                      </>
                    }
                  >
                    <SettingsRow
                      label="Managed Speech Runtime"
                      description={
                        speechStatus?.detail
                          ?? 'Managed whisper.cpp installs into Gemma Desktop app data when this build has a configured installer source.'
                      }
                    >
                      <MetaList
                        items={[
                          <span key="prov">{speechStatus?.providerLabel ?? 'Managed whisper.cpp'}</span>,
                          <span key="mod">Model: {speechStatus?.modelLabel ?? 'large-v3-turbo-q5_0'}</span>,
                          <span key="stat">Status: {formatSpeechInstallState(speechStatus?.installState ?? 'not_installed')}</span>,
                          speechStatus?.runtimeVersion ? (
                            <span key="ver">Runtime: {speechStatus.runtimeVersion}</span>
                          ) : null,
                        ].filter((item): item is ReactElement => item !== null)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      label="Internal Foundation"
                      description={
                        <>
                          Gemma Desktop also builds on our own <span className="font-mono">@gemma-desktop/sdk-*</span> packages for runtime adapters, attachments, tools, and session orchestration. Credits below focus on the upstream projects behind features people actually see and use.
                        </>
                      }
                    />
                  </SettingsSection>

                  {ABOUT_CREDIT_SECTIONS.map((section) => (
                    <SettingsSection
                      key={section.id}
                      title={section.title}
                      description={section.description}
                    >
                      {section.entries.map((entry) => (
                        <SettingsRow
                          key={entry.id}
                          label={entry.name}
                          description={entry.role}
                          control={
                            entry.website ? (
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  if (!entry.website) return
                                  openExternalTarget(entry.website)
                                }}
                                title={`Open ${entry.name}`}
                              >
                                Open
                                <ExternalLink size={11} />
                              </Button>
                            ) : undefined
                          }
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Tag>{entry.kind === 'system' ? 'System' : 'Open source'}</Tag>
                            {entry.license ? <Tag>{entry.license}</Tag> : null}
                            {entry.version ? <Tag>v{entry.version}</Tag> : null}
                          </div>
                          {entry.notes ? <Note>{entry.notes}</Note> : null}
                        </SettingsRow>
                      ))}
                    </SettingsSection>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-zinc-200 px-6 py-3 dark:border-zinc-800">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Changes save as you go · Gemma Desktop v0.1.0
          </p>
          <Button variant="primary" size="md" onClick={handleClose}>
            Save & Close
          </Button>
        </div>
      </div>
    </div>
  )
}
