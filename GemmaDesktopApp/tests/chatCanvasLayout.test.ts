import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatCanvas } from '../src/renderer/src/components/ChatCanvas'

describe('ChatCanvas layout', () => {
  it('uses the full available pane width in expanded split layout', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        contentLayout: 'expanded',
      }),
    )

    expect(markup).toContain('class="w-full px-4 pb-4 pt-4"')
    expect(markup).not.toContain('max-w-chat')
  })

  it('disables assistant history actions while the agent is running', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Explain local models' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Local models run on your machine.' }],
            timestamp: 2000,
          },
        ],
        streamingContent: null,
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        getReadAloudButtonState: () => ({
          visible: true,
          ariaLabel: 'Read aloud',
          title: 'Read aloud',
          disabled: false,
          active: false,
          icon: 'volume' as const,
        }),
        onToggleSelectionMode: () => {},
      }),
    )

    expect(markup).toContain('Wait for the session run to finish before selecting sentences.')
    expect(markup).toContain('Read aloud is unavailable while the session run is active')
    expect(markup).toContain('Wait for the session run to finish before copying this turn.')
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBe(3)
  })

  it('adds the persisted primary model label to completed turn durations', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Summarize the runtime' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Runtime summary complete.' }],
            timestamp: 2000,
            durationMs: 15_000,
            primaryModelId: 'gemma4:26b',
          },
        ],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
      }),
    )

    expect(markup).toContain('gemma4:26b')
    expect(markup).toContain('15s')
    expect(markup).toContain('text-zinc-400 dark:text-zinc-500')
    expect(markup).toContain('font-medium text-zinc-700 dark:text-zinc-100')
  })

  it('keeps completed turn durations compact when no model label is provided', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Summarize the runtime' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Runtime summary complete.' }],
            timestamp: 2000,
            durationMs: 15_000,
          },
        ],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
      }),
    )

    expect(markup).toContain('>15s</span>')
    expect(markup).not.toContain(' in 15s')
  })

  it('uses the Work-mode latest-turn primary model fallback when metadata is missing', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Summarize the runtime' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Runtime summary complete.' }],
            timestamp: 2000,
            durationMs: 15_000,
          },
        ],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        latestAssistantFallbackPrimaryModelId: 'gemma4:26b',
      }),
    )

    expect(markup).toContain('gemma4:26b')
    expect(markup).toContain('15s')
  })

  it('keeps the streaming assistant row visible without rendering background process notices', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build me a black hole simulation' }],
            timestamp: 1000,
          },
          {
            id: 'process-1',
            role: 'assistant',
            content: [
              {
                type: 'shell_session',
                terminalId: 'terminal-1',
                command: 'cd blackhole-sim && npm run dev',
                workingDirectory: '/tmp/blackhole-sim',
                status: 'running',
                startedAt: 1500,
                transcript: '',
                collapsed: false,
                displayMode: 'sidebar',
              },
            ],
            timestamp: 1500,
          },
        ],
        streamingContent: [
          { type: 'thinking', text: 'Checking the dev server output.' },
          { type: 'text', text: 'I have the simulation running and I am verifying it now.' },
        ],
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
      }),
    )

    expect(markup).toContain('I have the simulation running and I am verifying it now.')
    expect(markup).not.toContain('Background process')
    expect(markup).not.toContain('cd blackhole-sim &amp;&amp; npm run dev')
  })

  it('ignores hidden background process notices when choosing latest assistant metadata', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Start the dev server' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'The dev server is starting.' }],
            timestamp: 2000,
            durationMs: 10_000,
          },
          {
            id: 'process-1',
            role: 'assistant',
            content: [
              {
                type: 'shell_session',
                terminalId: 'terminal-1',
                command: 'npm run dev',
                workingDirectory: '/tmp/project',
                status: 'running',
                startedAt: 2500,
                transcript: '',
                collapsed: false,
                displayMode: 'sidebar',
              },
            ],
            timestamp: 2500,
          },
        ],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        latestAssistantFallbackPrimaryModelId: 'gemma4:26b',
      }),
    )

    expect(markup).toContain('The dev server is starting.')
    expect(markup).toContain('gemma4:26b')
    expect(markup).not.toContain('Background process')
  })
})
