import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GLOBAL_CHAT_FALLBACK_SESSION_ID } from '../src/shared/globalChat'
import { FirstRunModelSetup } from '../src/renderer/src/components/FirstRunModelSetup'
import { shouldShowFirstRunModelSetup } from '../src/renderer/src/lib/firstRunModelSetup'
import type { BootstrapState, ModelSummary, RuntimeSummary, SessionSummary } from '../src/renderer/src/types'
import type { SidebarState } from '../src/shared/sidebar'

const runtimes: RuntimeSummary[] = [
  {
    id: 'ollama-native',
    name: 'Ollama',
    status: 'running',
  },
  {
    id: 'omlx-openai',
    name: 'oMLX',
    status: 'stopped',
  },
]

const models: ModelSummary[] = [
  {
    id: 'gemma4:26b',
    name: 'Gemma 4 26B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    status: 'available',
  },
]

const idleBootstrap: Pick<BootstrapState, 'status'> = {
  status: 'idle',
}

const emptySidebar: Pick<SidebarState, 'lastActiveSessionId' | 'projectPaths'> = {
  lastActiveSessionId: null,
  projectPaths: [],
}

function session(
  id: string,
  overrides: Partial<Pick<SessionSummary, 'lastMessage'>> = {},
): Pick<SessionSummary, 'id' | 'lastMessage'> {
  return { id, lastMessage: '', ...overrides }
}

describe('FirstRunModelSetup', () => {
  it('asks users to choose a provider before downloading anything', () => {
    const markup = renderToStaticMarkup(
      createElement(FirstRunModelSetup, {
        runtimes,
        models,
        gemmaInstallStates: [],
        onChoose: () => {},
        onDismiss: () => {},
        onEnsureGemmaModel: async () => {},
      }),
    )

    expect(markup).toContain('Choose how Gemma Desktop should run models')
    expect(markup).toContain('Nothing will be downloaded until you ask for it.')
    expect(markup).toContain('Ollama')
    expect(markup).toContain('oMLX')
    expect(markup).toContain('LM Studio')
    expect(markup).toContain('Gemma 4 26B')
    expect(markup).toContain('Optional guided Gemma downloads')
    expect(markup).toContain('Decide Later')
  })
})

describe('shouldShowFirstRunModelSetup', () => {
  it('shows the chooser only for a fresh app state after the risk dialog', () => {
    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: emptySidebar,
      sessions: [],
    })).toBe(true)
  })

  it('does not show the chooser over existing user workspaces just because localStorage is missing', () => {
    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: {
        ...emptySidebar,
        projectPaths: ['/Users/sam/project'],
      },
      sessions: [],
    })).toBe(false)

    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: {
        ...emptySidebar,
        lastActiveSessionId: 'session-1',
      },
      sessions: [],
    })).toBe(false)

    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: emptySidebar,
      sessions: [session('session-1')],
    })).toBe(false)
  })

  it('does not treat the empty built-in Assistant Chat as existing workspace state', () => {
    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: emptySidebar,
      sessions: [session(GLOBAL_CHAT_FALLBACK_SESSION_ID)],
    })).toBe(true)
  })

  it('treats a used built-in Assistant Chat as existing user state', () => {
    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: idleBootstrap,
      sidebar: emptySidebar,
      sessions: [session(GLOBAL_CHAT_FALLBACK_SESSION_ID, { lastMessage: 'hi' })],
    })).toBe(false)
  })

  it('waits while bootstrap is active so it cannot sit on top of explicit retry/download work', () => {
    expect(shouldShowFirstRunModelSetup({
      startupRiskAccepted: true,
      dismissed: false,
      bootstrapState: { status: 'pulling_models' },
      sidebar: emptySidebar,
      sessions: [],
    })).toBe(false)
  })
})
