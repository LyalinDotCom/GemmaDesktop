/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSessions = vi.hoisted(() => ({
  instances: [] as Array<{
    options: {
      voiceName: string
      systemInstruction: string
      onToolCall: (call: { name: string; args: Record<string, unknown> }) => Record<string, unknown>
      onEvent: (event: unknown) => void
    }
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    sendSystemUpdate: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@/lib/voiceLiveSession', () => {
  class VoiceLiveSession {
    options: (typeof mockSessions.instances)[number]['options']
    start = vi.fn(async () => {})
    stop = vi.fn(async () => {})
    sendSystemUpdate = vi.fn()

    constructor(options: (typeof mockSessions.instances)[number]['options']) {
      this.options = options
      mockSessions.instances.push(this)
    }
  }
  return { VoiceLiveSession }
})

import {
  useVoiceMode,
  type UseVoiceModeOptions,
  type VoiceModeDelegate,
  type VoiceModeHandle,
} from '../../src/renderer/src/hooks/useVoiceMode'
import type { VoiceLiveAppCapabilities } from '../../src/renderer/src/lib/voiceLivePrompt'

function makeCapabilities(
  overrides: Partial<VoiceLiveAppCapabilities> = {},
): VoiceLiveAppCapabilities {
  return {
    surfaceLabel: 'the Assistant Chat conversation',
    conversationKind: 'normal',
    workMode: 'explore',
    planMode: false,
    workingDirectory: '/Users/dev/myapp',
    model: {
      id: 'gemma4:26b',
      name: 'Gemma 4 26B',
      runtimeName: 'Ollama',
      attachments: { image: true, audio: false, video: false, pdf: false },
    },
    coBrowseActive: false,
    chatBusy: false,
    addOnTools: [],
    canStartNewChat: { ok: true },
    canStartResearchChat: { ok: true },
    ...overrides,
  }
}

interface DelegateOverrides extends Partial<VoiceModeDelegate> {
  capabilities?: VoiceLiveAppCapabilities
}

function makeDelegate(overrides: DelegateOverrides = {}): VoiceModeDelegate {
  const { capabilities, ...rest } = overrides
  return {
    isChatBusy: () => false,
    sendToChat: vi.fn(async () => 'chat response text'),
    sendToSession: vi.fn(async () => 'session response text'),
    getCapabilities: () => capabilities ?? makeCapabilities(),
    getHistoryTurns: () => [
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ],
    startNewChat: vi.fn(async () => ({
      surfaceKey: 'session:new-chat',
      sessionId: 'new-chat',
      title: 'New conversation',
    })),
    startResearchChat: vi.fn(async () => ({
      surfaceKey: 'session:new-research',
      sessionId: 'new-research',
      title: 'Research 1',
    })),
    ...rest,
  }
}

let root: Root | null = null
let container: HTMLElement | null = null
let handle: VoiceModeHandle | null = null

function Probe({ options }: { options: UseVoiceModeOptions }) {
  handle = useVoiceMode(options)
  return null
}

function makeOptions(
  overrides: Partial<UseVoiceModeOptions> = {},
): UseVoiceModeOptions {
  return {
    apiKey: 'test-key',
    voiceName: 'Aoede',
    surfaceKey: 'assistant:talk',
    surfaceLabel: 'the Assistant Chat conversation',
    delegate: makeDelegate(),
    ...overrides,
  }
}

async function renderHook(options: UseVoiceModeOptions) {
  await act(async () => {
    root!.render(createElement(Probe, { options }))
  })
}

async function startVoice(options: UseVoiceModeOptions) {
  await renderHook(options)
  await act(async () => {
    handle!.toggle()
  })
  const session = mockSessions.instances.at(-1)!
  await act(async () => {
    session.options.onEvent({ type: 'open' })
  })
  return session
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mockSessions.instances.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  handle = null
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

describe('useVoiceMode lifecycle', () => {
  it('starts a session whose instruction carries capabilities and history', async () => {
    const session = await startVoice(makeOptions())

    expect(session.start).toHaveBeenCalled()
    expect(handle!.status).toBe('listening')
    expect(session.options.systemInstruction).toContain('Gemma 4 26B')
    expect(session.options.systemInstruction).toContain('Recent conversation history')
    expect(session.options.systemInstruction).toContain('earlier question')
  })

  it('uses the configured voice and normalizes unknown names to the default', async () => {
    const session = await startVoice(makeOptions({ voiceName: 'Aoede' }))
    expect(session.options.voiceName).toBe('Aoede')
    await act(async () => {
      handle!.toggle()
    })

    const fallbackSession = await startVoice(makeOptions({ voiceName: 'not-a-voice' }))
    expect(fallbackSession.options.voiceName).toBe('Kore')
  })

  it('builds a fresh instruction (new history) on every restart', async () => {
    let historyCalls = 0
    const delegate = makeDelegate({
      getHistoryTurns: () => {
        historyCalls += 1
        return [{ role: 'user', text: `history snapshot ${historyCalls}` }]
      },
    })
    const options = makeOptions({ delegate })
    await startVoice(options)
    await act(async () => {
      handle!.toggle()
    })
    await act(async () => {
      handle!.toggle()
    })

    expect(mockSessions.instances).toHaveLength(2)
    expect(mockSessions.instances[0]!.options.systemInstruction)
      .toContain('history snapshot 1')
    expect(mockSessions.instances[1]!.options.systemInstruction)
      .toContain('history snapshot 2')
  })

  it('stops the session when the surface changes manually', async () => {
    const options = makeOptions()
    const session = await startVoice(options)

    await renderHook({ ...options, surfaceKey: 'session:other' })

    expect(session.stop).toHaveBeenCalled()
    expect(handle!.status).toBe('off')
  })
})

describe('useVoiceMode tool routing', () => {
  it('routes send_chat_message through the delegate and reports the response', async () => {
    const delegate = makeDelegate()
    const session = await startVoice(makeOptions({ delegate }))

    let result: Record<string, unknown> | null = null
    await act(async () => {
      result = session.options.onToolCall({
        name: 'send_chat_message',
        args: { prompt: 'write a haiku' },
      })
    })

    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(delegate.sendToChat).toHaveBeenCalledWith('write a haiku')
    await act(async () => {})
    expect(session.sendSystemUpdate).toHaveBeenCalledWith(
      expect.stringContaining('chat response text'),
    )
  })

  it('returns busy without delegating when the chat model is working', async () => {
    const delegate = makeDelegate({ isChatBusy: () => true })
    const session = await startVoice(makeOptions({ delegate }))

    let result: Record<string, unknown> | null = null
    await act(async () => {
      result = session.options.onToolCall({
        name: 'send_chat_message',
        args: { prompt: 'another request' },
      })
    })

    expect(result).toMatchObject({ ok: false, status: 'busy' })
    expect(delegate.sendToChat).not.toHaveBeenCalled()
  })

  it('serves get_app_context from fresh delegate capabilities', async () => {
    let coBrowse = false
    const delegate = makeDelegate({
      getCapabilities: () => makeCapabilities({ coBrowseActive: coBrowse }),
    })
    const session = await startVoice(makeOptions({ delegate }))

    let result: { context?: string } = {}
    await act(async () => {
      result = session.options.onToolCall({ name: 'get_app_context', args: {} })
    })
    expect(result.context).toContain('CoBrowse is OFF')

    coBrowse = true
    await act(async () => {
      result = session.options.onToolCall({ name: 'get_app_context', args: {} })
    })
    expect(result.context).toContain('CoBrowse is ON')
  })

  it('rejects start_research_chat without a goal', async () => {
    const delegate = makeDelegate()
    const session = await startVoice(makeOptions({ delegate }))

    let result: Record<string, unknown> | null = null
    await act(async () => {
      result = session.options.onToolCall({
        name: 'start_research_chat',
        args: {},
      })
    })

    expect(result).toMatchObject({ ok: false, status: 'rejected' })
    expect(delegate.startResearchChat).not.toHaveBeenCalled()
  })

  it('rejects creation tools when the app reports them unavailable', async () => {
    const delegate = makeDelegate({
      capabilities: makeCapabilities({
        canStartNewChat: { ok: false, reason: 'no project directory is configured' },
      }),
    })
    const session = await startVoice(makeOptions({ delegate }))

    let result: Record<string, unknown> | null = null
    await act(async () => {
      result = session.options.onToolCall({ name: 'start_new_chat', args: {} })
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'rejected',
      detail: 'no project directory is configured',
    })
    expect(delegate.startNewChat).not.toHaveBeenCalled()
  })

  it('starts research, adopts the new surface, and narrates start + result', async () => {
    const delegate = makeDelegate()
    const options = makeOptions({ delegate })
    const session = await startVoice(options)

    let result: Record<string, unknown> | null = null
    await act(async () => {
      result = session.options.onToolCall({
        name: 'start_research_chat',
        args: { research_goal: 'state of local llms' },
      })
    })
    expect(result).toMatchObject({ ok: true, status: 'starting' })

    await act(async () => {})
    expect(delegate.startResearchChat).toHaveBeenCalled()

    // The app re-renders onto the freshly created research session; the hook
    // must adopt it instead of stopping.
    await renderHook({ ...options, surfaceKey: 'session:new-research' })
    expect(session.stop).not.toHaveBeenCalled()

    expect(session.sendSystemUpdate).toHaveBeenCalledWith(
      expect.stringContaining('"Research 1"'),
    )
    expect(delegate.sendToSession)
      .toHaveBeenCalledWith('new-research', 'state of local llms')
    await act(async () => {})
    expect(session.sendSystemUpdate).toHaveBeenCalledWith(
      expect.stringContaining('session response text'),
    )
  })

  it('starts a new chat and sends the optional first message', async () => {
    const delegate = makeDelegate()
    const options = makeOptions({ delegate })
    const session = await startVoice(options)

    await act(async () => {
      session.options.onToolCall({
        name: 'start_new_chat',
        args: { title: 'Ideas', first_message: 'list three app ideas' },
      })
    })
    await act(async () => {})

    expect(delegate.startNewChat).toHaveBeenCalledWith({ title: 'Ideas' })
    expect(session.sendSystemUpdate).toHaveBeenCalledWith(
      expect.stringContaining('"New conversation"'),
    )
    expect(delegate.sendToSession)
      .toHaveBeenCalledWith('new-chat', 'list three app ideas')
  })

  it('narrates creation failures instead of erroring the session', async () => {
    const delegate = makeDelegate({
      startResearchChat: vi.fn(async () => {
        throw new Error('the research model is not installed')
      }),
    })
    const session = await startVoice(makeOptions({ delegate }))

    await act(async () => {
      session.options.onToolCall({
        name: 'start_research_chat',
        args: { research_goal: 'anything' },
      })
    })
    await act(async () => {})

    expect(session.sendSystemUpdate).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    )
    expect(handle!.status).toBe('listening')
  })
})
