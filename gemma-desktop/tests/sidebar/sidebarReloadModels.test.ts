/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import type { AppSettings, ModelSummary, PrimaryModelAvailabilityIssue, SessionSummary, SystemStats } from '../../src/renderer/src/types'
import type { LoadDefaultModelsResult } from '../../src/shared/modelLifecycle'
import { EMPTY_SIDEBAR_STATE, type SidebarState } from '../../src/shared/sidebar'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '../../src/shared/sessionModelDefaults'

const SYSTEM_STATS: SystemStats = {
  memoryUsedGB: 8,
  memoryTotalGB: 16,
  gpuUsagePercent: 12,
  cpuUsagePercent: 18,
}

const MODEL: ModelSummary = {
  id: 'gemma4:26b',
  name: 'Gemma 4 26B',
  runtimeId: 'ollama-native',
  runtimeName: 'Ollama',
  status: 'loaded',
  parameterCount: '26B',
  quantization: 'Q4_K_M',
}

const SECONDARY_MODEL: ModelSummary = {
  id: 'qwen3:8b',
  name: 'Qwen3 8B',
  runtimeId: 'lmstudio-openai',
  runtimeName: 'LM Studio',
  status: 'available',
}

const LOAD_RESULT: LoadDefaultModelsResult = {
  ok: true,
  message: 'Reloaded expected models.',
  selection: {
    mainModel: { modelId: 'gemma4:26b', runtimeId: 'ollama-native' },
    helperModel: { modelId: 'gemma4:e2b', runtimeId: 'ollama-native' },
    helperModelEnabled: true,
  },
  targets: [],
  unloaded: [],
  loaded: [],
  skipped: [],
  errors: [],
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'Conversation 1',
    titleSource: 'user',
    modelId: 'gemma4:26b',
    runtimeId: 'ollama-native',
    conversationKind: 'normal',
    workMode: 'explore',
    planMode: false,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    workingDirectory: '/tmp/project',
    lastMessage: '',
    createdAt: 1_000,
    updatedAt: 2_000,
    isGenerating: false,
    isCompacting: false,
    ...overrides,
  }
}

function sidebarProps(input?: {
  sessions?: SessionSummary[]
  sidebarState?: SidebarState
  onReloadModels?: () => Promise<LoadDefaultModelsResult> | void
  modelSelection?: AppSettings['modelSelection']
  modelAvailabilityIssues?: PrimaryModelAvailabilityIssue[]
  onUpdateModelSelection?: (modelSelection: AppSettings['modelSelection']) => void | Promise<void>
  onLoadModelSelection?: (modelSelection: AppSettings['modelSelection']) => Promise<LoadDefaultModelsResult> | void
}) {
  return {
    sessions: input?.sessions ?? [makeSession()],
    sidebarState: input?.sidebarState ?? {
      ...EMPTY_SIDEBAR_STATE,
      projectPaths: ['/tmp/project'],
    },
    activeSessionId: 'session-1',
    onSelectSession: () => {},
    onCreateProject: () => {},
    onCreateSessionInProject: () => {},
    onOpenProject: () => {},
    onCloseProject: () => {},
    onDeleteSession: () => {},
    onRenameSession: () => {},
    onCloseProcess: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onFlagFollowUp: () => {},
    onUnflagFollowUp: () => {},
    onMovePinnedSession: () => {},
    onMoveProjectSession: () => {},
    onClearSessionOrder: () => {},
    onMoveProject: () => {},
    onClearProjectOrder: () => {},
    automations: [],
    activeAutomationId: null,
    onSelectAutomation: () => {},
    onNewAutomation: () => {},
    currentView: 'chat' as const,
    onOpenSettings: () => {},
    onOpenDoctor: () => {},
    onOpenSkills: () => {},
    selectedSkillCount: 0,
    systemStats: SYSTEM_STATS,
    models: [MODEL, SECONDARY_MODEL],
    modelSelection: input?.modelSelection,
    modelAvailabilityIssues: input?.modelAvailabilityIssues,
    onUpdateModelSelection: input?.onUpdateModelSelection,
    onLoadModelSelection: input?.onLoadModelSelection,
    onReloadModels: input?.onReloadModels ?? (() => {}),
  }
}

function getButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((entry) => entry.getAttribute('aria-label') === label)
  if (!button) {
    throw new Error(`Could not find button with label: ${label}`)
  }
  return button
}

function getButtonByLabelPrefix(container: HTMLElement, labelPrefix: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((entry) => entry.getAttribute('aria-label')?.startsWith(labelPrefix))
  if (!button) {
    throw new Error(`Could not find button with label prefix: ${labelPrefix}`)
  }
  return button
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((entry) => entry.textContent?.includes(text))
  if (!button) {
    throw new Error(`Could not find button containing text: ${text}`)
  }
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

describe('Sidebar reload models control', () => {
  let container: HTMLDivElement
  let root: Root | null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('gemmaDesktopBridge', {
      sessions: {
        search: vi.fn(async () => []),
      },
      system: {
        openEmojiPanel: vi.fn(async () => ({ ok: true })),
      },
      terminals: {
        listInstalled: vi.fn(async () => []),
        openDirectory: vi.fn(async () => ({ ok: true })),
      },
    })
    root = null
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  function renderSidebar(props = sidebarProps()): void {
    const nextRoot = createRoot(container)
    root = nextRoot
    act(() => {
      nextRoot.render(createElement(Sidebar, props))
    })
  }

  it('disables model reload while a request is running', async () => {
    const onReloadModels = vi.fn()
    renderSidebar(sidebarProps({
      sessions: [makeSession({ isGenerating: true })],
      onReloadModels,
    }))

    await click(getButtonByLabelPrefix(container, 'Show model memory'))

    const reloadButton = getButtonByLabel(container, 'Reload expected models')
    expect(reloadButton.disabled).toBe(true)
    expect(reloadButton.title).toBe('Finish or stop the running request before reloading models.')
  })

  it('requires confirmation before reloading models', async () => {
    const onReloadModels = vi.fn().mockResolvedValue(LOAD_RESULT)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderSidebar(sidebarProps({ onReloadModels }))

    await click(getButtonByLabelPrefix(container, 'Show model memory'))

    const reloadButton = getButtonByLabel(container, 'Reload expected models')
    await click(reloadButton)

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Reload expected models?'))
    expect(onReloadModels).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await click(reloadButton)

    expect(onReloadModels).toHaveBeenCalledTimes(1)
  })

  it('surfaces global primary and secondary model selection in the sidebar', async () => {
    const onUpdateModelSelection = vi.fn()
    renderSidebar(sidebarProps({ onUpdateModelSelection }))

    await click(getButtonByLabel(container, 'Global model selection'))

    expect(container.textContent).toContain('Global Models')
    expect(container.textContent).toContain('Primary powers chats, research, and automations.')
    expect(getButtonByLabel(container, 'Primary model').textContent).toContain('Gemma 4 26B')
    expect(getButtonByLabel(container, 'Secondary model').textContent).toContain('gemma4:e2b')

    await click(getButtonByLabel(container, 'Primary model'))
    await click(getButtonByText(container, 'Qwen3 8B'))

    expect(onUpdateModelSelection).toHaveBeenCalledWith({
      ...DEFAULT_MODEL_SELECTION_SETTINGS,
      mainModel: {
        modelId: 'qwen3:8b',
        runtimeId: 'lmstudio-openai',
      },
    })
  })

  it('toggles secondary model use from the global model popover', async () => {
    const onUpdateModelSelection = vi.fn()
    renderSidebar(sidebarProps({ onUpdateModelSelection }))

    await click(getButtonByLabel(container, 'Global model selection'))
    await click(getButtonByLabel(container, 'Toggle secondary model'))

    expect(onUpdateModelSelection).toHaveBeenCalledWith({
      ...DEFAULT_MODEL_SELECTION_SETTINGS,
      helperModelEnabled: false,
    })
  })

  it('loads the globally selected models from the sidebar popover', async () => {
    const onLoadModelSelection = vi.fn().mockResolvedValue(LOAD_RESULT)
    renderSidebar(sidebarProps({ onLoadModelSelection }))

    await click(getButtonByLabel(container, 'Global model selection'))
    await click(getButtonByText(container, 'Load Selected Models'))

    expect(onLoadModelSelection).toHaveBeenCalledWith(DEFAULT_MODEL_SELECTION_SETTINGS)
    expect(container.textContent).toContain('Reloaded expected models.')
  })

  it('marks selected model load failures while keeping the model selected', async () => {
    renderSidebar(sidebarProps({
      modelAvailabilityIssues: [{
        modelId: DEFAULT_MODEL_SELECTION_SETTINGS.mainModel.modelId,
        runtimeId: DEFAULT_MODEL_SELECTION_SETTINGS.mainModel.runtimeId,
        message: 'Ollama could not load gemma4:26b.',
        detectedAt: 1,
        source: 'send',
      }],
    }))

    await click(getButtonByLabel(container, 'Global model selection'))

    expect(getButtonByLabel(container, 'Primary model').textContent).toContain('Gemma 4 26B')
    expect(container.textContent).toContain('Ollama could not load gemma4:26b.')
    expect(container.querySelector('[aria-label="Primary model failed to load"]')).not.toBeNull()
  })
})
