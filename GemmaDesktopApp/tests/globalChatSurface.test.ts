import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssistantHome } from '../src/renderer/src/components/AssistantHome'
import { ChatCanvas } from '../src/renderer/src/components/ChatCanvas'
import { GlobalChatSwitchBar } from '../src/renderer/src/components/GlobalChatSwitchBar'
import { TalkPanel } from '../src/renderer/src/components/TalkPanel'

const rendererCss = readFileSync(
  join(__dirname, '../src/renderer/src/index.css'),
  'utf8',
)

describe('Assistant Chat surface copy', () => {
  it('renders the top bar as a home/work switch without dropdown actions', () => {
    const markup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          assistantHomeVisible: true,
          pinnedToDock: false,
          busy: false,
          onToggleHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(markup).toContain('aria-label="Switch to Work mode"')
    expect(markup).not.toContain('aria-label="Context: ~4096 / 32768 tokens (13%)"')
    expect(markup).toContain('aria-label="Pin Assistant Chat to the right dock"')
    expect(markup).not.toContain('aria-label="Assistant Chat actions"')
    expect(markup).not.toContain('shared composer')
    expect(markup).not.toContain('Built-in assistant chat')
  })

  it('switches the top bar controls into pinned work mode', () => {
    const markup = renderToStaticMarkup(
      createElement(
        GlobalChatSwitchBar,
        {
          assistantHomeVisible: false,
          pinnedToDock: true,
          busy: false,
          onToggleHome: () => {},
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
          assistantHomeVisible: false,
          pinnedToDock: false,
          busy: false,
          onToggleHome: () => {},
          onTogglePin: () => {},
        },
      ),
    )

    expect(markup).toContain('aria-label="Open Assistant Home"')
    expect(markup).not.toContain('aria-label="Context: ~4096 / 32768 tokens (13%)"')
  })

  it('renders the Assistant Home chat expander outside the transcript without decorative header badges', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
      }),
    )

    const toolbarIndex = markup.indexOf('assistant-home-transcript-toolbar')
    const transcriptIndex = markup.indexOf('assistant-home-transcript w-full')
    const expandButtonIndex = markup.indexOf('aria-label="Expand chat"')

    expect(markup).toContain('aria-label="Expand chat"')
    expect(markup).toContain('lucide-maximize2')
    expect(markup).toContain('assistant-home-transcript w-full dark')
    expect(markup).not.toContain('assistant-home-title')
    expect(markup).not.toContain('Hi, I&#x27;m Gemma')
    expect(toolbarIndex).toBeGreaterThanOrEqual(0)
    expect(expandButtonIndex).toBeGreaterThan(toolbarIndex)
    expect(expandButtonIndex).toBeLessThan(transcriptIndex)
    expect(markup).not.toContain('absolute right-3 top-3')
    expect(markup).not.toContain('aria-label="Switch to Work mode"')
    expect(markup).not.toContain('lucide-brain')
    expect(markup).not.toContain('>Assistant Home<')
  })

  it('keeps expanded Assistant Home chat history in the reserved space above the composer', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: true,
        busy: false,
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
      }),
    )

    expect(markup).toContain('assistant-home-stage flex max-h-full')
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

  it('renders CoBrowse inside the Assistant Home surface instead of the work-mode dock', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        coBrowseSlot: createElement('div', { 'data-testid': 'cobrowse-browser' }, 'browser'),
        hasConversation: false,
        busy: false,
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        assistantNarrationMode: 'off',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        assistantNarrationMode: 'summary',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        assistantNarrationMode: 'full',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        assistantNarrationMode: 'off',
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
        onToggleAssistantNarration: () => {},
      }),
    )

    // All four pills share the same height token and the ghost/idle palette.
    const pillCount = markup.match(/border-white\/12 bg-white\/\[0\.04\]/g)?.length ?? 0
    expect(pillCount).toBeGreaterThanOrEqual(4)
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onTogglePin: () => {},
      }),
    )

    const composerIndex = markup.indexOf('>composer<')
    const workModeIndex = markup.indexOf('>Work mode<')
    const coBrowseIndex = markup.indexOf('>CoBrowse<')
    const pinIndex = markup.indexOf('aria-label="Pin Assistant Chat to the right dock"')
    const readAloudIndex = markup.indexOf('data-testid="read-aloud-slot"')

    expect(composerIndex).toBeGreaterThanOrEqual(0)
    expect(workModeIndex).toBeGreaterThan(composerIndex)
    expect(coBrowseIndex).toBeGreaterThan(workModeIndex)
    expect(pinIndex).toBeGreaterThan(coBrowseIndex)
    expect(readAloudIndex).toBeGreaterThan(pinIndex)
    expect(markup).toContain('title="Pin Assistant Chat to the right dock"')
    expect(markup).toContain('lucide-pin')
    expect(markup).not.toContain('>Pin chat<')
    expect(markup).not.toContain('>Pinned to dock<')
  })

  it('locks Work mode and Pin in the welcome row while CoBrowse is on', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(AssistantHome, {
        conversationSlot: createElement('div', null, 'conversation'),
        supportSlot: null,
        composerSlot: createElement('div', null, 'composer'),
        hasConversation: false,
        busy: false,
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
      }),
    )

    // Off: no disabled attribute on Work mode, Pin, or Exit CoBrowse.
    expect(offMarkup).not.toContain('disabled=""')

    // On: Work mode (visible-text label, locked via title) and Pin (icon-only,
    // locked via aria-label) are disabled. Exit CoBrowse stays clickable when
    // the session is idle.
    expect(onMarkup).toContain('title="Stop CoBrowse first"')
    expect(onMarkup).toContain(
      'aria-label="Pin Assistant Chat to the right dock (Stop CoBrowse first)"',
    )
    expect(onMarkup).toContain('aria-label="Exit CoBrowse"')
    // Two disabled buttons (Work mode + Pin); Exit CoBrowse is still enabled.
    const disabledCount = onMarkup.match(/disabled=""/g)?.length ?? 0
    expect(disabledCount).toBe(2)
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
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
        pinnedToDock: false,
        onWorkMode: () => {},
        onCoBrowse: () => {},
        onExitCoBrowse: () => {},
        onTogglePin: () => {},
      }),
    )

    expect(idleMarkup).toContain('aria-label="Exit CoBrowse"')
    expect(busyMarkup).toContain(
      'aria-label="Exit CoBrowse (Wait for the assistant to finish before stopping CoBrowse)"',
    )
    // Busy + CoBrowse on → Work mode, Pin, AND Exit CoBrowse all disabled (3).
    const idleDisabledCount = idleMarkup.match(/disabled=""/g)?.length ?? 0
    const busyDisabledCount = busyMarkup.match(/disabled=""/g)?.length ?? 0
    expect(idleDisabledCount).toBe(2)
    expect(busyDisabledCount).toBe(3)
  })

  it('locks the top GlobalChatSwitchBar Brain toggle and Pin while CoBrowse is on', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(GlobalChatSwitchBar, {
        assistantHomeVisible: true,
        pinnedToDock: false,
        busy: false,
        coBrowseActive: false,
        onToggleHome: () => {},
        onTogglePin: () => {},
      }),
    )
    const onMarkup = renderToStaticMarkup(
      createElement(GlobalChatSwitchBar, {
        assistantHomeVisible: true,
        pinnedToDock: false,
        busy: false,
        coBrowseActive: true,
        onToggleHome: () => {},
        onTogglePin: () => {},
      }),
    )

    expect(offMarkup).not.toContain('disabled=""')
    expect(onMarkup).toContain(
      'aria-label="Switch to Work mode (Stop CoBrowse first)"',
    )
    expect(onMarkup).toContain(
      'aria-label="Pin Assistant Chat to the right dock (Stop CoBrowse first)"',
    )
    const disabledCount = onMarkup.match(/disabled=""/g)?.length ?? 0
    expect(disabledCount).toBe(2)
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
