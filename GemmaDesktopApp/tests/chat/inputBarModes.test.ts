import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  InputBar,
  isComposerSubmitLocked,
} from '../../src/renderer/src/components/InputBar'
import type { InputBarProps } from '../../src/renderer/src/components/InputBar'
import { getNextAssistantNarrationMode } from '../../src/renderer/src/lib/assistantNarrationMode'
import type { ModelSummary } from '../../src/renderer/src/types'

const model: ModelSummary = {
  id: 'gemma4:26b',
  name: 'Gemma 4 26B',
  runtimeId: 'ollama-native',
  runtimeName: 'Ollama Native',
  status: 'available',
  attachmentSupport: {
    image: true,
    pdf: true,
    audio: true,
    video: true,
  },
}

function buildProps(
  overrides: Partial<InputBarProps> = {},
): InputBarProps {
  return {
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    initialDraftText: '',
    onSend: async () => {},
    onRunShellCommand: async () => {},
    onCompact: async () => {},
    onClearHistory: async () => {},
    onCancel: () => {},
    isGenerating: false,
    isCompacting: false,
    models: [model],
    selectedModelId: model.id,
    selectedRuntimeId: model.runtimeId,
    selectedMode: 'explore',
    conversationKind: 'normal',
    planMode: false,
    onSelectConversationMode: () => {},
    modeChangeDisabled: false,
    messages: [],
    streamingContent: null,
    sessionTools: [],
    selectedToolIds: [],
    onToggleTool: () => {},
    debugOpen: false,
    debugLogs: [],
    debugSession: null,
    sessionTitle: 'Test Session',
    onToggleDebug: () => {},
    hasMessages: false,
    sessionContext: {
      tokensUsed: 0,
      contextLength: 32768,
      speed: {
        recentTps: null,
        averageTps: null,
        slowestTps: null,
        fastestTps: null,
        sampleCount: 0,
        recentSampleCount: 0,
        hasEstimatedSamples: false,
      },
      source: 'visible-chat',
    },
    liveActivity: null,
    pendingCompaction: null,
    enterToSend: true,
    autoCompactEnabled: false,
    autoCompactThresholdPercent: 80,
    speechStatus: null,
    onInstallSpeech: async () => null,
    onRepairSpeech: async () => null,
    onOpenSpeechSettings: () => {},
    pinnedQuotes: [],
    onRemovePinnedQuote: () => {},
    onClearPinnedQuotes: () => {},
    ...overrides,
  }
}

describe('InputBar mode rendering', () => {
  it('releases the local send lock once the session is busy so the next turn can queue', () => {
    expect(isComposerSubmitLocked({
      isSubmitPending: true,
      sessionBusy: false,
    })).toBe(true)

    expect(isComposerSubmitLocked({
      isSubmitPending: true,
      sessionBusy: true,
    })).toBe(false)
  })

  it('cycles spoken response modes from off to summaries to full responses', () => {
    expect(getNextAssistantNarrationMode('off')).toBe('summary')
    expect(getNextAssistantNarrationMode('summary')).toBe('full')
    expect(getNextAssistantNarrationMode('full')).toBe('off')
  })

  it('shows the Explore/Act/Plan selector for normal conversations', () => {
    const buildMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({ selectedMode: 'build' })),
    )
    const exploreMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({ selectedMode: 'explore' })),
    )
    const researchMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        conversationKind: 'research',
      })),
    )

    expect(buildMarkup).toContain('aria-label="Switch between Explore, Act, and Plan"')
    expect(buildMarkup).toContain('title="Switch to explore mode"')
    expect(buildMarkup).toContain('title="Switch to act mode"')
    expect(buildMarkup).toContain('title="Switch to plan mode"')
    expect(buildMarkup).not.toContain('aria-label="Session model size"')
    expect(buildMarkup).not.toContain('Session model: Gemma 4 26B')
    expect(buildMarkup).toContain('aria-label="Switch to YOLO approval mode"')
    expect(buildMarkup).toContain('>Ask<')
    expect(exploreMarkup).toContain('aria-label="Switch between Explore, Act, and Plan"')
    expect(researchMarkup).not.toContain('aria-label="Switch between Explore, Act, and Plan"')
    expect(researchMarkup).not.toContain('Switch to YOLO approval mode')
  })

  it('shows the selected YOLO approval mode in the toolbar', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'build',
        approvalMode: 'yolo',
        onSelectApprovalMode: () => {},
      })),
    )

    expect(markup).toContain('aria-label="Switch to require approval mode"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('>YOLO<')
  })

  it('shows a Research badge without per-conversation model selection', () => {
    const researchMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        conversationKind: 'research',
      })),
    )

    expect(researchMarkup).toContain('title="Deep research conversation"')
    expect(researchMarkup).toContain('>Research<')
    expect(researchMarkup).not.toContain('aria-label="Session model size"')
    expect(researchMarkup).not.toContain('Session model: Gemma 4 26B')
  })

  it('renders tool toggles as disabled in research conversations', () => {
    const tool = {
      id: 'ask-gemini',
      slug: 'ask-gemini',
      name: 'Ask Gemini',
      description: 'Ask Gemini for a second opinion.',
      icon: 'sparkles' as const,
      instructions: '',
      supportedPlatforms: ['darwin' as const],
      toolNames: ['ask_gemini'],
    }

    const normalMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        sessionTools: [tool],
        selectedToolIds: [tool.id],
      })),
    )
    const researchMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        conversationKind: 'research',
        sessionTools: [tool],
        selectedToolIds: [tool.id],
      })),
    )

    expect(normalMarkup).toContain('aria-label="Disable Ask Gemini"')
    expect(normalMarkup).not.toMatch(
      /<button[^>]*\sdisabled=""[^>]*aria-label="(Enable|Disable) Ask Gemini"/,
    )
    expect(researchMarkup).toContain('aria-label="Enable Ask Gemini"')
    expect(researchMarkup).toContain('aria-pressed="false"')
    expect(researchMarkup).toMatch(
      /<button[^>]*\sdisabled=""[^>]*aria-label="Enable Ask Gemini"/,
    )
  })

  it('renders the composer context indicator without the old left-side model label', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({ selectedMode: 'explore' })),
    )

    expect(markup).toContain('title="More actions"')
    expect(markup).toContain('title="Context: ~0 / 32768 tokens (0%)"')
    expect(markup).not.toContain('loaded model visible on hover')
  })

  it('renders the three-way spoken response switch in the composer controls', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        onToggleAssistantNarration: () => {},
        assistantNarrationMode: 'off',
      })),
    )
    const summaryMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        onToggleAssistantNarration: () => {},
        assistantNarrationMode: 'summary',
      })),
    )
    const fullMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        onToggleAssistantNarration: () => {},
        assistantNarrationMode: 'full',
      })),
    )

    expect(offMarkup).toContain('aria-label="Spoken responses off"')
    expect(offMarkup).toContain('lucide-volume-x')
    expect(summaryMarkup).toContain('aria-label="Speak summaries"')
    expect(summaryMarkup).toContain('lucide-audio-lines')
    expect(fullMarkup).toContain('aria-label="Read full responses"')
    expect(fullMarkup).toContain('lucide-book-open-text')
  })

  it('omits the spoken response switch unless the app wires the ephemeral state', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps()),
    )

    expect(markup).not.toContain('Spoken responses off')
    expect(markup).not.toContain('Speak summaries')
    expect(markup).not.toContain('Read full responses')
  })

  it('keeps tool controls beside the mode selector and context beside send', () => {
    const tool = {
      id: 'ask-gemini',
      slug: 'ask-gemini',
      name: 'Ask Gemini',
      description: 'Ask Gemini for a second opinion.',
      icon: 'sparkles' as const,
      instructions: '',
      supportedPlatforms: ['darwin' as const],
      toolNames: ['ask_gemini'],
    }
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        sessionTools: [tool],
        selectedToolIds: [tool.id],
      })),
    )

    const modeIndex = markup.indexOf('aria-label="Switch between Explore, Act, and Plan"')
    const toolIndex = markup.indexOf('aria-label="Disable Ask Gemini"')
    const spacerIndex = markup.indexOf('class="flex-1"', modeIndex)
    const contextIndex = markup.indexOf('title="Context: ~0 / 32768 tokens (0%)"')
    const moreIndex = markup.indexOf('title="More actions"')
    const sendIndex = markup.indexOf('title="Send message"', contextIndex)

    expect(modeIndex).toBeGreaterThanOrEqual(0)
    expect(markup).not.toContain('aria-label="Session model size"')
    expect(toolIndex).toBeGreaterThan(modeIndex)
    expect(toolIndex).toBeLessThan(spacerIndex)
    expect(moreIndex).toBeGreaterThan(spacerIndex)
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(sendIndex).toBeGreaterThan(contextIndex)
  })

  it('hides the status row controls in floating presentation but keeps composer context', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        presentation: 'floating',
      })),
    )

    expect(markup).not.toContain('aria-label="Switch between Explore, Act, and Plan"')
    expect(markup).not.toContain('aria-label="Session model size"')
    expect(markup).toContain('title="Context: ~0 / 32768 tokens (0%)"')
  })

  it('caps both default and floating composers at two lines with internal scrolling', () => {
    const floatingMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        presentation: 'floating',
      })),
    )
    const defaultMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({})),
    )

    // Floating welcome composer stays compact: it can show two lines, then
    // scrolls inside the textarea instead of pushing the welcome layout down.
    expect(floatingMarkup).toContain('min-h-[36px]')
    expect(floatingMarkup).toContain('max-h-[68px]')
    expect(floatingMarkup).toContain('overflow-y-auto')
    expect(floatingMarkup).toContain('leading-6')
    expect(floatingMarkup).not.toContain('min-h-[24px]')

    // Work-mode default composer enforces the same two-line cap so a long
    // pasted draft scrolls inside the textarea instead of climbing the chat.
    expect(defaultMarkup).toContain('min-h-[24px]')
    expect(defaultMarkup).toContain('max-h-[64px]')
    expect(defaultMarkup).toContain('overflow-y-auto')
    expect(defaultMarkup).toContain('leading-6')
    expect(defaultMarkup).not.toContain('max-h-[160px]')
    expect(defaultMarkup).not.toContain('min-h-[36px]')
    expect(defaultMarkup).not.toContain('max-h-[68px]')
  })

  it('keeps read aloud playback in the default overlay and leaves floating placement external', () => {
    const readAloudPlayback = {
      visible: true,
      phase: 'playing' as const,
      label: 'Reading selected text aloud',
      currentTimeSec: 1,
      durationSec: 4,
      canSeek: true,
      togglePlayPause: () => {},
      seekTo: () => {},
      dismiss: () => {},
    }
    const defaultMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({ readAloudPlayback })),
    )
    const floatingMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        presentation: 'floating',
        readAloudPlayback,
      })),
    )

    expect(defaultMarkup).toContain(
      'class="pointer-events-auto absolute inset-x-3 top-0 z-20 -translate-y-[52%]"',
    )
    expect(floatingMarkup).not.toContain('Reading selected text aloud')
    expect(floatingMarkup).not.toContain('aria-label="Read aloud playback position"')
    expect(floatingMarkup).not.toContain('-translate-y-[52%]')
  })

  it('lets the main composer fill the split pane when a right panel is pinned', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        layout: 'expanded',
      })),
    )

    expect(markup).toContain('class="w-full flex items-center gap-2')
    expect(markup).toContain('class="relative px-4 pb-4 pt-3"')
    expect(markup).toContain('class="w-full"')
    expect(markup).not.toContain('mx-auto w-full max-w-chat')
    expect(markup).not.toContain('class="relative px-6 pb-4 pt-3"')
  })

  it('only advertises busy queueing for normal work conversations', () => {
    const buildMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        initialDraftText: 'queue this',
        selectedMode: 'build',
        isGenerating: true,
      })),
    )
    const exploreMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        isGenerating: true,
      })),
    )
    const planMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'build',
        planMode: true,
        isGenerating: true,
      })),
    )
    const researchMarkup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        conversationKind: 'research',
        isGenerating: true,
      })),
    )

    expect(buildMarkup).toContain('Queue the next message while this turn runs')
    expect(buildMarkup.match(/<textarea[^>]*>/)?.[0] ?? '')
      .not.toMatch(/\sdisabled(?=[\s=>])/)
    expect(buildMarkup.match(/<button[^>]*title="Queue message"[^>]*>/)?.[0] ?? '')
      .not.toMatch(/\sdisabled(?=[\s=>])/)
    expect(exploreMarkup).toContain('Queue the next message while this turn runs')
    expect(planMarkup).toContain('Wait for plan mode to finish before sending another prompt.')
    expect(researchMarkup).toContain('Wait for deep research to finish before sending another prompt.')
  })

  it('locks the attachment control while the agent is running', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        selectedMode: 'explore',
        isGenerating: true,
      })),
    )

    expect(markup).toContain('Wait for this turn to finish before attaching files')
    expect(markup.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? '')
      .toMatch(/\sdisabled(?=[\s=>])/)
    expect(
      markup.match(/<button[^>]*aria-label="Wait for this turn to finish before attaching files"[^>]*>/)?.[0] ?? '',
    ).toMatch(/\sdisabled(?=[\s=>])/)
  })

  it('can disable busy queueing for turn-taking surfaces like CoBrowse', () => {
    const reason = 'Wait for the current CoBrowse turn to finish before sending another request.'
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        initialDraftText: 'queue this',
        selectedMode: 'explore',
        isGenerating: true,
        busyQueueDisabledReason: reason,
      })),
    )

    expect(markup).toContain(reason)
    expect(markup).toContain(`title="${reason}"`)
    expect(markup).toContain('disabled=""')
  })

  it('surfaces the app-wide conversation run lock', () => {
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        initialDraftText: 'hello',
        conversationRunDisabledReason:
          'Gemma Desktop is already answering in "Other". Wait for that conversation to finish or stop it before starting another one.',
      })),
    )

    expect(markup).toContain('Gemma Desktop is already answering in &quot;Other&quot;.')
    expect(markup).toContain('disabled=""')
  })

  it('keeps model switching out of the composer when only sending is blocked', () => {
    const reason =
      'oMLX could not load gemma-4-26b-a4b-it-nvfp4. Chats using omlx-openai / gemma-4-26b-a4b-it-nvfp4 are paused until you switch them to another model or restart after the model is available.'
    const markup = renderToStaticMarkup(
      createElement(InputBar, buildProps({
        initialDraftText: 'hello',
        conversationRunDisabledReason: reason,
      })),
    )

    expect(markup).not.toContain('aria-label="Session model size"')
    expect(markup).toContain(reason)
    expect(markup.match(/<button[^>]*disabled=""[^>]*title="oMLX could not load[^"]*"[^>]*>/)?.[0] ?? '')
      .toMatch(/\sdisabled(?=[\s=>])/)
  })
})
