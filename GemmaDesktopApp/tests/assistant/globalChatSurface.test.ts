import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssistantHome } from '../../src/renderer/src/components/AssistantHome'
import { AssistantHomeSessionControls } from '../../src/renderer/src/components/AssistantHomeSessionControls'
import { ChatCanvas } from '../../src/renderer/src/components/ChatCanvas'
import { GlobalChatSwitchBar } from '../../src/renderer/src/components/GlobalChatSwitchBar'
import { TalkPanel } from '../../src/renderer/src/components/TalkPanel'

const rendererCss = readFileSync(
  join(__dirname, '../../src/renderer/src/index.css'),
  'utf8',
)

describe('Assistant Chat surface copy', () => {
  it('renders the work-screen top bar as an Assistant Home switch without dropdown actions', () => {
    const markup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          pinnedToDock: false,
          busy: false,
          onOpenHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(markup).toContain('aria-label="Open Assistant Home"')
    expect(markup).toContain('global-chat-switch-bar')
    expect(markup).toContain('global-chat-switch-bar-nebula')
    expect(markup).toContain('assistant-home-nebula')
    expect(markup).toContain('nebula-field-vivid')
    expect(markup).not.toContain('lucide-brain')
    expect(markup).not.toContain('bg-cyan-300')
    expect(markup).not.toContain('self-stretch rounded-full')
    expect(markup).not.toContain('lucide-chevron')
    expect(markup).not.toContain('aria-label="Context: ~4096 / 32768 tokens (13%)"')
    expect(markup).toContain('aria-label="Pin Assistant Chat to the right dock"')
    expect(markup).not.toContain('aria-label="Switch to Work mode"')
    expect(markup).toContain('no-drag pointer-events-none absolute')
    expect(markup).not.toContain('pointer-events-none fixed')
    expect(markup).toContain('rounded-xl p-1.5')
    expect(markup).not.toContain('aria-label="Assistant Chat actions"')
    expect(markup).not.toContain('shared composer')
    expect(markup).not.toContain('Built-in assistant chat')
    expect(rendererCss).toContain('.global-chat-switch-bar:hover .global-chat-switch-bar-nebula')
    expect(rendererCss).toContain('.global-chat-switch-bar:hover::after')
  })

  it('switches the top bar controls into pinned work mode', () => {
    const markup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          pinnedToDock: true,
          busy: false,
          onOpenHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(markup).toContain('aria-label="Open Assistant Home"')
    expect(markup).toContain('aria-label="Unpin Assistant Chat from the right dock"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('aria-label="Context: ~4096 / 32768 tokens (13%)"')
    expect(markup).not.toContain('border-b-transparent')
  })

  it('hides context from the top switch bar', () => {
    const markup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          pinnedToDock: false,
          busy: false,
          onOpenHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(markup).toContain('aria-label="Open Assistant Home"')
    expect(markup).not.toContain('aria-label="Context: ~4096 / 32768 tokens (13%)"')
  })

  it('speeds the full-bar nebula indicator while the assistant is busy', () => {
    const idleMarkup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          pinnedToDock: false,
          busy: false,
          onOpenHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )
    const busyMarkup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          pinnedToDock: false,
          busy: true,
          onOpenHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(idleMarkup).not.toContain('global-chat-switch-bar-busy')
    expect(idleMarkup).not.toContain('nebula-field-busy')
    expect(busyMarkup).toContain('global-chat-switch-bar-busy')
    expect(busyMarkup).toContain('nebula-field-busy')
    expect(busyMarkup).not.toContain('bg-cyan-300')
  })

  it('renders Assistant Home history at full height without an expander', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const transcriptIndex = markup.indexOf('assistant-home-transcript w-full')

    expect(markup).not.toContain('aria-label="Expand chat"')
    expect(markup).not.toContain('aria-label="Shrink chat"')
    expect(markup).not.toContain('lucide-maximize2')
    expect(markup).not.toContain('lucide-minimize2')
    expect(markup).not.toContain('assistant-home-transcript-toolbar')
    expect(markup).toContain('assistant-home-transcript w-full dark')
    expect(markup).toContain('assistant-home-stage-expanded')
    expect(markup).toContain('assistant-home-transcript-expanded')
    expect(markup).not.toContain('assistant-home-title')
    expect(markup).not.toContain('Hi, I&#x27;m Gemma')
    expect(markup).not.toContain('assistant-home-brain-mark')
    expect(transcriptIndex).toBeGreaterThanOrEqual(0)
    expect(markup).not.toContain('absolute right-3 top-3')
    expect(markup).not.toContain('aria-label="Switch to Work mode"')
    expect(markup).not.toContain('>Assistant Home<')
  })

  it('renders the Assistant Home global chat session controls above the chat', () => {
    const controls = createElement(AssistantHomeSessionControls, {
      sessions: [
        {
          id: 'talk-00000000-0000-4000-8000-000000000000',
          title: 'Assistant Chat',
          lastMessage: 'Current thread',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          messageCount: 2,
        },
        {
          id: 'talk-00000000-0000-4000-8000-000000000001',
          title: 'Assistant Chat',
          lastMessage: 'Previous thread',
          createdAt: 1_690_000_000_000,
          updatedAt: 1_690_000_000_000,
          messageCount: 3,
        },
      ],
      currentSessionId: 'talk-00000000-0000-4000-8000-000000000000',
      busy: false,
      onFocusCurrentSession: () => {},
      onSelectSession: () => {},
      onStartNewSession: () => {},
    })
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        sessionControlsSlot: controls,
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const controlsIndex = markup.indexOf('assistant-home-session-controls')
    const transcriptIndex = markup.indexOf('assistant-home-transcript w-full')

    expect(markup).toContain('>Current chat<')
    expect(markup).toContain('>Last session<')
    expect(markup).toContain('aria-label="Search Assistant Chat sessions"')
    expect(markup).toContain('aria-label="Start new Assistant Chat session"')
    expect(markup).toContain('lucide-plus')
    expect(markup).toContain('assistant-home-session-controls no-drag relative z-[90]')
    expect(controlsIndex).toBeGreaterThanOrEqual(0)
    expect(controlsIndex).toBeLessThan(transcriptIndex)
  })

  it('disables Last session and session search when there is no previous chat content', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHomeSessionControls, {
        sessions: [
          {
            id: 'talk-00000000-0000-4000-8000-000000000000',
            title: 'Assistant Chat',
            lastMessage: '',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            messageCount: 0,
          },
          {
            id: 'talk-00000000-0000-4000-8000-000000000001',
            title: 'Assistant Chat',
            lastMessage: '',
            createdAt: 1_690_000_000_000,
            updatedAt: 1_690_000_000_000,
            messageCount: 0,
          },
        ],
        currentSessionId: 'talk-00000000-0000-4000-8000-000000000000',
        busy: false,
        onFocusCurrentSession: () => {},
        onSelectSession: () => {},
        onStartNewSession: () => {},
      }),
    )

    expect(markup).toContain('title="No previous Assistant Chat session"')
    expect(markup).toContain('placeholder="No saved chats yet"')
    expect(markup).toContain('title="No saved Assistant Chat sessions"')
    expect(markup).toContain('title="Send a message before starting a new Assistant Chat session"')
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBe(4)
  })

  it('keeps expanded Assistant Home chat history in the reserved space above the composer', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    expect(markup).toContain('assistant-home-stage flex max-h-full w-full max-w-3xl')
    expect(markup).toContain('assistant-home-stage-with-conversation')
    expect(markup).toContain('w-full max-w-3xl flex-none')
    expect(rendererCss).toContain('.assistant-home-stage-expanded {\n    height: 100%;')
    expect(rendererCss).toContain('@media (max-height: 760px)')
    expect(rendererCss).toContain('.assistant-home-transcript-shell-expanded {\n    display: flex;')
    expect(rendererCss).toContain('.assistant-home-transcript-expanded {\n    flex: 1 1 auto;')
    expect(rendererCss).toContain('height: auto;')
    expect(rendererCss).toContain('.assistant-home-transcript .assistant-action-button')
    expect(rendererCss).not.toContain('height: min(76vh, calc(100vh - 11rem));')
  })

  it('can render a stable empty Assistant Home history box for fresh chats', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: null,
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const transcriptIndex = markup.indexOf('assistant-home-transcript w-full')
    const composerIndex = markup.indexOf('>composer<')

    expect(markup).toContain('assistant-home-stage-with-conversation')
    expect(markup).toContain('assistant-home-transcript-shell')
    expect(transcriptIndex).toBeGreaterThanOrEqual(0)
    expect(composerIndex).toBeGreaterThan(transcriptIndex)
  })

  it('renders CoBrowse inside the Assistant Home surface instead of the work-mode dock', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const chatPaneIndex = markup.indexOf('assistant-home-chat-pane')
    const browserPanelIndex = markup.indexOf('data-testid="cobrowse-browser"')

    expect(markup).toContain('assistant-home-cobrowse-shell')
    expect(markup).toContain('assistant-home-cobrowse-panel')
    expect(markup).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')
    expect(markup).toContain('assistant-home-cobrowse-panel no-drag relative z-30 flex h-full min-h-0')
    expect(markup).not.toContain('grid-cols-1')
    expect(markup).not.toContain('xl:grid-cols')
    expect(chatPaneIndex).toBeGreaterThanOrEqual(0)
    expect(browserPanelIndex).toBeGreaterThan(chatPaneIndex)
  })

  it('places Assistant Home streaming progress under the transcript before the composer', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        conversationStatusSlot: createElement(
          'div',
          { className: 'assistant-chat-bottom-status' },
          'thinking status',
        ),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: true,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const transcriptIndex = markup.indexOf('assistant-home-transcript w-full')
    const statusIndex = markup.indexOf('assistant-home-transcript-status')
    const composerIndex = markup.indexOf('>composer<')

    expect(statusIndex).toBeGreaterThan(transcriptIndex)
    expect(statusIndex).toBeLessThan(composerIndex)
    expect(markup).toContain('assistant-chat-bottom-status')
    expect(rendererCss).toContain('.assistant-home-transcript-status')
  })

  it('places the spoken response switch before the Assistant Home work mode button', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        assistantNarrationMode: 'off',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onToggleAssistantNarration: () => {},
      }),
    )
    const summaryMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        assistantNarrationMode: 'summary',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onToggleAssistantNarration: () => {},
      }),
    )
    const fullMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        assistantNarrationMode: 'full',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onToggleAssistantNarration: () => {},
      }),
    )

    const toggleIndex = offMarkup.indexOf('aria-label="Spoken responses off"')
    const workModeIndex = offMarkup.indexOf('>Work mode<')
    const coBrowseIndex = offMarkup.indexOf('>CoBrowse<')

    expect(toggleIndex).toBeGreaterThanOrEqual(0)
    expect(toggleIndex).toBeLessThan(workModeIndex)
    expect(coBrowseIndex).toBeGreaterThan(workModeIndex)
    expect(offMarkup).toContain('lucide-volume-x')
    expect(offMarkup).toContain('lucide-earth')
    expect(summaryMarkup).toContain('aria-label="Speak summaries"')
    expect(summaryMarkup).toContain('lucide-audio-lines')
    expect(fullMarkup).toContain('aria-label="Read full responses"')
    expect(fullMarkup).toContain('lucide-book-open-text')
  })

  it('renders CoBrowse as a mode on/off toggle with a clear active state', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )
    const onMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )

    expect(offMarkup).toContain('aria-label="Start CoBrowse"')
    expect(offMarkup).toContain('aria-pressed="false"')
    expect(offMarkup).not.toContain('border-cyan-300/45 bg-cyan-300/15 text-cyan-50')

    expect(onMarkup).toContain('aria-label="Exit CoBrowse"')
    expect(onMarkup).toContain('aria-pressed="true"')
    expect(onMarkup).toContain('border-cyan-300/45 bg-cyan-300/15 text-cyan-50')
    expect(onMarkup).toContain('rounded-full bg-cyan-200')
    expect(onMarkup).not.toContain('border-sky-300/30')
    expect(onMarkup).not.toContain('bg-sky-300/[0.10]')
  })

  it('uses a unified ghost+accent visual language across the welcome action row', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        assistantNarrationMode: 'off',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onToggleAssistantNarration: () => {},
      }),
    )

    // The three welcome-row controls share the same height token and ghost palette.
    const pillCount = markup.match(/border-white\/12 bg-white\/\[0\.04\]/g)?.length ?? 0
    expect(pillCount).toBeGreaterThanOrEqual(3)
    expect(markup).toContain('h-12')
    expect(markup).not.toContain('h-11 w-11')
    expect(markup).not.toContain('border-emerald-300/45')
    expect(markup).not.toContain('border-cyan-300/40')
    expect(markup).not.toContain('bg-sky-300/[0.10]')
  })

  it('places Assistant Home read aloud playback after the welcome buttons', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        readAloudSlot: createElement('div', { 'data-testid': 'read-aloud-slot' }, 'read aloud playback'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
      }),
    )

    const composerIndex = markup.indexOf('>composer<')
    const workModeIndex = markup.indexOf('>Work mode<')
    const coBrowseIndex = markup.indexOf('>CoBrowse<')
    const readAloudIndex = markup.indexOf('data-testid="read-aloud-slot"')

    expect(composerIndex).toBeGreaterThanOrEqual(0)
    expect(workModeIndex).toBeGreaterThan(composerIndex)
    expect(coBrowseIndex).toBeGreaterThan(workModeIndex)
    expect(readAloudIndex).toBeGreaterThan(coBrowseIndex)
    expect(markup).not.toContain('aria-label="Pin Assistant Chat to the right dock"')
    expect(markup).not.toContain('lucide-pin')
    expect(markup).not.toContain('>Pin chat<')
    expect(markup).not.toContain('>Pinned to dock<')
  })

  it('locks Work mode in the welcome row while CoBrowse is on', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )
    const onMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )

    // Off: no disabled attribute on Work mode or Exit CoBrowse.
    expect(offMarkup).not.toContain('disabled=""')

    // On: Work mode is disabled. Exit CoBrowse stays clickable when idle.
    expect(onMarkup).toContain('title="Stop CoBrowse first"')
    expect(onMarkup).not.toContain('aria-label="Pin Assistant Chat to the right dock')
    expect(onMarkup).toContain('aria-label="Exit CoBrowse"')
    // One disabled button (Work mode); Exit CoBrowse is still enabled.
    const disabledCount = onMarkup.match(/disabled=""/g)?.length ?? 0
    expect(disabledCount).toBe(1)
  })

  it('locks Exit CoBrowse while a session is busy', () => {
    const idleMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )
    const busyMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: true,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
      }),
    )

    expect(idleMarkup).toContain('aria-label="Exit CoBrowse"')
    expect(busyMarkup).toContain(
      'aria-label="Exit CoBrowse (Wait for the assistant to finish before stopping CoBrowse)"',
    )
    // Busy + CoBrowse on -> Work mode and Exit CoBrowse are disabled.
    const idleDisabledCount = idleMarkup.match(/disabled=""/g)?.length ?? 0
    const busyDisabledCount = busyMarkup.match(/disabled=""/g)?.length ?? 0
    expect(idleDisabledCount).toBe(1)
    expect(busyDisabledCount).toBe(2)
  })

  it('keeps the top GlobalChatSwitchBar free of Welcome-only CoBrowse state', () => {
    const markup = renderToStaticMarkup(
      createElement(GlobalChatSwitchBar, {
        pinnedToDock: false,
        busy: false,
        onOpenHome: () => {},
        onTogglePin: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Open Assistant Home"')
    expect(markup).toContain('aria-label="Pin Assistant Chat to the right dock"')
    expect(markup).not.toContain('Stop CoBrowse first')
    expect(markup).not.toContain('aria-label="Switch to Work mode')
    expect(markup).not.toContain('disabled=""')
  })

  it('mutes inline streaming progress when Assistant Home owns the external status', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        sessionId: 'assistant-global',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }],
            timestamp: 1000,
          },
        ],
        streamingContent: null,
        isGenerating: true,
        isCompacting: false,
        autoExpandActiveBlocks: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        forceAutoScroll: true,
        liveActivity: null,
        topPaddingClass: 'pt-4',
        contentLayout: 'expanded',
        streamingStatusPlacement: 'external',
      }),
    )

    const dotsIndex = markup.indexOf('assistant-streaming-dots')

    expect(markup).toContain('aria-label="Working"')
    expect(dotsIndex).toBeGreaterThanOrEqual(0)
    expect(markup).not.toContain('assistant-chat-bottom-status')
  })

  it('renders pinned context in the docked Assistant Chat panel', () => {
    const markup = renderToStaticMarkup(
      createElement(TalkPanel, {
        variant: 'docked',
        title: 'Assistant Chat',
        targetKind: 'fallback',
        sessionId: 'assistant-global',
        messages: [],
        draftText: '',
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        pendingCompaction: null,
        pendingToolApproval: null,
        liveActivity: null,
        sessionContext: {
          tokensUsed: 4096,
          contextLength: 32768,
        },
        loading: false,
        error: null,
        enterToSend: true,
        onRetry: async () => {},
        onSend: async () => {},
        onCancel: async () => {},
        onCompact: async () => {},
        onSaveDraft: async () => {},
        onClearSession: async () => {},
      }),
    )

    const contextIndex = markup.indexOf('aria-label="Context: ~4096 / 32768 tokens (13%)"')
    const sendIndex = markup.indexOf('title="Send message"', contextIndex)

    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(sendIndex).toBeGreaterThan(contextIndex)
    expect(markup).not.toContain('flex-shrink-0 border-t px-4 py-3')
    expect(markup).toContain('flex-shrink-0 px-4 pb-[21px] pt-[7px]')
    expect(markup).toContain('flex min-h-[44px] items-center')
    expect(markup).not.toContain('flex min-h-[44px] items-end')
    expect(markup).not.toContain('border-t border-zinc-200/80 px-4 py-2')
  })

  it('locks the docked Assistant Chat composer when CoBrowse user control blocks sending', () => {
    const reason = 'Release browser control before sending another CoBrowse request.'
    const markup = renderToStaticMarkup(
      createElement(TalkPanel, {
        variant: 'docked',
        title: 'Assistant Chat',
        targetKind: 'fallback',
        sessionId: 'assistant-global',
        messages: [],
        draftText: 'Find the open story',
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        conversationRunDisabledReason: reason,
        pendingCompaction: null,
        pendingToolApproval: null,
        liveActivity: null,
        loading: false,
        error: null,
        enterToSend: true,
        onRetry: async () => {},
        onSend: async () => {},
        onCancel: async () => {},
        onCompact: async () => {},
        onSaveDraft: async () => {},
        onClearSession: async () => {},
      }),
    )

    expect(markup).toContain(reason)
    expect(markup.match(/<textarea[^>]*>/)?.[0] ?? '')
      .toMatch(/\sdisabled(?=[\s=>])/)
    expect(markup).toContain(`title="${reason}"`)
    expect(markup).toContain('disabled=""')
  })
})
