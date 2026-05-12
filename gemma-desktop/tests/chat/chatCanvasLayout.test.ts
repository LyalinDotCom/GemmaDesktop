import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatCanvas } from '../../src/renderer/src/components/ChatCanvas'

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
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
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

  it('collapses assistant tool and thinking follow-up messages under the prior assistant response', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Check Hacker News' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'I will check the top stories.' }],
            timestamp: 2000,
          },
          {
            id: 'assistant-thinking-1',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'Now I need to open the browser.' }],
            timestamp: 2100,
          },
          {
            id: 'assistant-tool-1',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'browser',
                input: { operation: 'open' },
                status: 'success',
                output: 'Opened Hacker News.',
                startedAt: 2200,
                completedAt: 3200,
              },
            ],
            timestamp: 2200,
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

    expect(markup).toContain('I will check the top stories.')
    expect(markup).toContain('browser open')
    expect(markup).not.toContain('Events')
    expect(markup).not.toContain('Thinking / browser open')
    expect(markup).not.toContain('Now I need to open the browser.')
    expect(markup).not.toContain('Opened Hacker News.')
  })

  it('collapses assistant tool and thinking lead-in messages into the first visible assistant response', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build a black hole simulation' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-thinking-1',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I need to inspect the target folder.' }],
            timestamp: 2000,
          },
          {
            id: 'assistant-tool-1',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'list_tree',
                input: { path: '/test-projects/sim05-blackhole' },
                status: 'error',
                output: 'Directory not found.',
                startedAt: 2100,
                completedAt: 2600,
              },
            ],
            timestamp: 2100,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'I will create the simulation files now.' }],
            timestamp: 2700,
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

    expect(markup).toContain('I will create the simulation files now.')
    expect(markup).toContain('list tree')
    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(markup).not.toContain('I need to inspect the target folder.')
    expect(markup).not.toContain('Directory not found.')
  })

  it('collapses completed event-only messages into the active streaming response', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build a black hole simulation' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-thinking-1',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I need to inspect the target folder.' }],
            timestamp: 2000,
          },
          {
            id: 'assistant-tool-1',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'list_tree',
                input: { path: '/test-projects/sim06-blackhole' },
                status: 'error',
                output: 'Directory not found.',
                startedAt: 2100,
                completedAt: 2600,
              },
            ],
            timestamp: 2100,
          },
          {
            id: 'assistant-thinking-2',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I should create the web app files.' }],
            timestamp: 2700,
          },
        ],
        streamingContent: [
          {
            type: 'text',
            text: "I'll start by creating the directory and the basic file structure.",
          },
        ],
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
      }),
    )

    expect(markup).toContain('I&#x27;ll start by creating the directory')
    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(markup).not.toContain('I need to inspect the target folder.')
    expect(markup).not.toContain('I should create the web app files.')
  })

  it('collapses event-only assistant messages into one timeline while waiting for visible output', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build a black hole simulation' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-thinking-1',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I need to inspect the target folder.' }],
            timestamp: 2000,
          },
          {
            id: 'assistant-thinking-2',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'The directory is missing so I should write files.' }],
            timestamp: 2100,
          },
        ],
        streamingContent: null,
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        streamingStatusPlacement: 'bottom',
      }),
    )

    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(markup).not.toContain('I need to inspect the target folder.')
    expect(markup).not.toContain('The directory is missing so I should write files.')
  })

  it('collapses inline assistant tool and thinking blocks into one event timeline', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Open Hacker News' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will open the page.' },
              { type: 'thinking', text: 'Preparing browser navigation.' },
              {
                type: 'tool_call',
                toolName: 'browser',
                input: { operation: 'open' },
                status: 'success',
                output: 'Opened.',
                startedAt: 2200,
                completedAt: 3200,
              },
              { type: 'text', text: 'The page is open.' },
              {
                type: 'tool_call',
                toolName: 'Gemma low helper',
                input: { modelId: 'gemma4:e2b' },
                status: 'success',
                summary: 'Checked the final answer',
              },
            ],
            timestamp: 2000,
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

    expect(markup).toContain('I will open the page.')
    expect(markup).toContain('The page is open.')
    expect(markup).toContain('browser open')
    expect(markup).toContain('Thinking (1) / browser open (1)')
    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(markup).not.toContain('Events')
    expect(markup).not.toContain('Thinking / browser open')
    expect(markup).not.toContain('Gemma low helper')
    expect(markup).not.toContain('Checked the final answer')
    expect(markup).not.toContain('Preparing browser navigation.')
    expect(markup).not.toContain('Opened.')
  })

  it('keeps separate assistant event timelines in chronological order around visible output', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build the black hole simulation' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'I need to inspect the target folder.' },
              {
                type: 'tool_call',
                toolName: 'list_tree',
                input: { path: '/test-projects/sim02-blackhole' },
                status: 'success',
                output: 'Directory not found.',
                startedAt: 2100,
                completedAt: 2600,
              },
              {
                type: 'text',
                text: 'I will build the simulation with vanilla WebGL.',
              },
              {
                type: 'file_edit',
                path: 'test-projects/sim02-blackhole/index.html',
                changeType: 'created',
                addedLines: 17,
                removedLines: 0,
                diff: '--- /dev/null\n+++ b/index.html\n@@\n+<!doctype html>\n',
              },
              { type: 'thinking', text: 'Now I need to validate the generated files.' },
              {
                type: 'tool_call',
                toolName: 'exec_command',
                input: { command: 'npm run validate' },
                status: 'success',
                output: 'Validation passed.',
                startedAt: 3000,
                completedAt: 5000,
              },
              { type: 'text', text: 'Validation passed and the app is ready.' },
              { type: 'thinking', text: 'I should summarize the result.' },
              { type: 'text', text: 'Created the black hole simulation.' },
            ],
            timestamp: 2000,
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

    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(3)
    const firstEventIndex = markup.indexOf('list tree')
    const firstTextIndex = markup.indexOf('I will build the simulation with vanilla WebGL.')
    const fileEditIndex = markup.indexOf('test-projects/sim02-blackhole/index.html')
    const secondEventIndex = markup.indexOf('exec command npm run validate')
    const secondTextIndex = markup.indexOf('Validation passed and the app is ready.')
    const thirdEventIndex = markup.lastIndexOf('Thinking')
    const finalTextIndex = markup.indexOf('Created the black hole simulation.')

    expect(firstEventIndex).toBeGreaterThanOrEqual(0)
    expect(firstTextIndex).toBeGreaterThan(firstEventIndex)
    expect(fileEditIndex).toBeGreaterThan(firstTextIndex)
    expect(secondEventIndex).toBeGreaterThan(fileEditIndex)
    expect(secondTextIndex).toBeGreaterThan(secondEventIndex)
    expect(thirdEventIndex).toBeGreaterThan(secondTextIndex)
    expect(finalTextIndex).toBeGreaterThan(thirdEventIndex)
    expect(markup).not.toContain('Now I need to validate the generated files.')
    expect(markup).not.toContain('I should summarize the result.')
  })

  it('summarizes every collapsed event run in timeline order', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Build the app' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-thinking-1',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I need a plan.' }],
            timestamp: 2000,
          },
          {
            id: 'assistant-thinking-2',
            role: 'assistant',
            content: [{ type: 'thinking', text: 'I should inspect the files.' }],
            timestamp: 2100,
          },
          {
            id: 'assistant-write-1',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'write_file',
                input: { path: 'index.html' },
                status: 'success',
              },
            ],
            timestamp: 2200,
          },
          {
            id: 'assistant-write-2',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'write_file',
                input: { path: 'style.css' },
                status: 'success',
              },
            ],
            timestamp: 2300,
          },
          {
            id: 'assistant-write-3',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'write_file',
                input: { path: 'script.js' },
                status: 'success',
              },
            ],
            timestamp: 2400,
          },
          {
            id: 'assistant-read-1',
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolName: 'read_file',
                input: { path: 'script.js' },
                status: 'success',
              },
            ],
            timestamp: 2500,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'I created the app.' }],
            timestamp: 2600,
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

    const thinkingIndex = markup.indexOf('Thinking (2)')
    const writeIndex = markup.indexOf('write file (3)')
    const readIndex = markup.indexOf('read file (1)')
    const textIndex = markup.indexOf('I created the app.')

    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(thinkingIndex).toBeGreaterThanOrEqual(0)
    expect(writeIndex).toBeGreaterThan(thinkingIndex)
    expect(readIndex).toBeGreaterThan(writeIndex)
    expect(textIndex).toBeGreaterThan(readIndex)
    expect(markup).not.toContain('I should inspect the files.')
  })

  it('collapses event-only streaming content before visible text arrives', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Open Hacker News' }],
            timestamp: 1000,
          },
        ],
        streamingContent: [
          { type: 'thinking', text: 'Preparing browser navigation.' },
          {
            type: 'tool_call',
            toolName: 'browser',
            input: { operation: 'open' },
            status: 'running',
            startedAt: 2200,
          },
        ],
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        streamingStatusPlacement: 'bottom',
      }),
    )

    expect(markup).toContain('browser open')
    expect(markup.match(/data-assistant-event-timeline="true"/g)?.length ?? 0).toBe(1)
    expect(markup).not.toContain('Preparing browser navigation.')
  })

  it('does not render in-message streaming dots when streaming status is placed below the chat', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Summarize the news' }],
            timestamp: 1000,
          },
        ],
        streamingContent: [
          { type: 'text', text: 'The summary is arriving.' },
        ],
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        streamingStatusPlacement: 'bottom',
      }),
    )

    expect(markup).toContain('The summary is arriving.')
    expect(markup).toContain('assistant-chat-bottom-status')
    expect(markup).not.toContain('assistant-streaming-dots mt-2')
  })

  it('does not render in-message streaming dots when streaming status is external', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Test' }],
            timestamp: 1000,
          },
        ],
        streamingContent: [
          { type: 'text', text: 'Working on it.' },
        ],
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        streamingStatusPlacement: 'external',
      }),
    )

    expect(markup).toContain('Working on it.')
    expect(markup).not.toContain('assistant-streaming-dots')
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

  it('marks completed research reports as top-scroll anchors', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Research Kyiv news' }],
            timestamp: 1000,
          },
          {
            id: 'research-1',
            role: 'assistant',
            content: [
              { type: 'text', text: '# Research Report\n\nLong report body.' },
              {
                type: 'folder_link',
                path: '/tmp/research-artifacts',
                label: 'Open research artifacts',
              },
            ],
            timestamp: 2000,
            durationMs: 20_000,
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

    expect(markup).toContain('data-research-report-id="research-1"')
  })
})
