import { describe, expect, it } from 'vitest'
import {
  applyDirectToolProgressToBlocks,
  appendToolCallBlock,
  applyDelegatedProgressToBlocks,
  applyToolResultToBlocks,
  createInitialSessionLiveActivity,
  refreshLiveActivityFromToolBlocks,
} from '../src/main/toolProgress'

describe('tool progress helpers', () => {
  it('updates live activity and active tool fields when a tool call starts', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'edit_file',
        input: { path: 'src/App.tsx' },
        callId: 'tool-edit',
      },
      2_000,
    )
    const activity = refreshLiveActivityFromToolBlocks(
      createInitialSessionLiveActivity(1_000),
      blocks,
      2_000,
      1,
    )

    expect(activity.activeToolName).toBe('edit_file')
    expect(activity.activeToolLabel).toBe('Updating files')
    expect(activity.runningToolCount).toBe(1)
    expect(activity.completedToolCount).toBe(0)
    expect(activity.recentProgressCount).toBe(1)
    expect(activity.lastProgressAt).toBe(2_000)
  })

  it('appends summarized delegated progress to the matching parent tool block', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'web_research_agent',
        input: { goal: 'Find recent browser engine changes' },
        callId: 'parent-tool',
      },
      1_000,
    )

    const started = applyDelegatedProgressToBlocks(
      blocks,
      {
        parentToolCallId: 'parent-tool',
        parentToolName: 'web_research_agent',
        kind: 'started',
        childSessionId: 'child-session',
        childTurnId: 'child-turn',
      },
      1_100,
    )
    const searched = applyDelegatedProgressToBlocks(
      started.blocks,
      {
        parentToolCallId: 'parent-tool',
        parentToolName: 'web_research_agent',
        kind: 'event',
        childEventType: 'tool.call',
        childPayload: {
          toolName: 'search_web',
        },
      },
      1_200,
    )
    const fetched = applyDelegatedProgressToBlocks(
      searched.blocks,
      {
        parentToolCallId: 'parent-tool',
        parentToolName: 'web_research_agent',
        kind: 'event',
        childEventType: 'tool.result',
        childPayload: {
          toolName: 'fetch_url',
        },
      },
      1_300,
    )

    expect(started.changed).toBe(true)
    expect(searched.changed).toBe(true)
    expect(fetched.changed).toBe(true)
    expect(fetched.blocks[0]?.progressEntries?.map((entry) => entry.label)).toEqual([
      'Starting web research agent',
      'Searching web',
      'Fetched 1 source',
    ])
    expect(fetched.blocks[0]?.worker?.label).toBe('Web research agent')
    expect(fetched.blocks[0]?.worker?.goal).toBe('Find recent browser engine changes')
    expect(fetched.blocks[0]?.worker?.childSessionId).toBe('child-session')
    expect(fetched.blocks[0]?.worker?.childTurnId).toBe('child-turn')
    expect(fetched.blocks[0]?.worker?.currentAction).toBe('Fetched source')
    expect(fetched.blocks[0]?.worker?.counters?.toolCalls).toBe(1)
    expect(fetched.blocks[0]?.worker?.counters?.toolResults).toBe(1)
    expect(fetched.blocks[0]?.worker?.counters?.fetchedSources).toBe(1)
  })

  it('hydrates delegated web research agent results with sources and trace metadata', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'web_research_agent',
        input: { goal: 'Check browser engine release notes' },
        callId: 'tool-research',
      },
      1_000,
    )

    const updated = applyToolResultToBlocks(
      blocks,
      {
        callId: 'tool-research',
        output: 'Checked sources.',
        structuredOutput: {
          summary: 'Compared the latest browser engine notes.',
          sources: ['https://example.com/notes'],
        },
        metadata: {
          childSessionId: 'session_child',
          childTurnId: 'turn_child',
          childTrace: 'trace text',
        },
      },
      1_900,
    )

    expect(updated[0]?.worker?.childSessionId).toBe('session_child')
    expect(updated[0]?.worker?.childTurnId).toBe('turn_child')
    expect(updated[0]?.worker?.traceText).toBe('trace text')
    expect(updated[0]?.worker?.resultSummary).toBe('Compared the latest browser engine notes.')
    expect(updated[0]?.worker?.resultData?.sources).toEqual(['https://example.com/notes'])
    expect(updated[0]?.worker?.counters?.sourcesUsed).toBe(1)
  })

  it('tracks workspace inspection and workspace search agent tool activity', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'workspace_search_agent',
        input: { goal: 'Find the renderer hook that manages live activity' },
        callId: 'tool-search',
      },
      1_000,
    )

    const updated = applyDelegatedProgressToBlocks(
      blocks,
      {
        parentToolCallId: 'tool-search',
        parentToolName: 'workspace_search_agent',
        kind: 'event',
        childSessionId: 'child-session',
        childTurnId: 'child-turn',
        childEventType: 'tool.call',
        childPayload: {
          toolName: 'search_paths',
          input: {
            query: 'live activity',
          },
        },
      },
      1_200,
    )

    expect(updated.blocks[0]?.worker?.label).toBe('Workspace search agent')
    expect(updated.blocks[0]?.worker?.currentAction).toBe('Inspecting project')
    expect(updated.blocks[0]?.worker?.counters?.toolCalls).toBe(1)
    expect(updated.blocks[0]?.worker?.timeline?.[1]).toMatchObject({
      label: 'Inspecting project',
      detail: 'live activity',
    })
  })

  it('captures delegated workspace editor agent outputs as changed files', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'workspace_editor_agent',
        input: { goal: 'Update the worker card UI' },
        callId: 'tool-edit-workspace',
      },
      1_000,
    )

    const updated = applyToolResultToBlocks(
      blocks,
      {
        callId: 'tool-edit-workspace',
        output: 'Updated files.',
        structuredOutput: {
          summary: 'Updated the worker card UI.',
          appliedWrites: [
            { path: 'src/components/ToolCallBlock.tsx' },
            { path: 'src/lib/workerInspector.ts' },
          ],
        },
      },
      1_800,
    )

    expect(updated[0]?.worker?.resultData?.filesChanged).toEqual([
      'src/components/ToolCallBlock.tsx',
      'src/lib/workerInspector.ts',
    ])
    expect(updated[0]?.worker?.counters).toEqual(
      expect.objectContaining({
        filesChanged: 2,
      }),
    )
  })

  it('captures delegated workspace command agent outputs as runnable commands', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'workspace_command_agent',
        input: { goal: 'Run the worker inspector tests' },
        callId: 'tool-command-worker',
      },
      1_000,
    )

    const updated = applyToolResultToBlocks(
      blocks,
      {
        callId: 'tool-command-worker',
        output: 'Ran tests.',
        structuredOutput: {
          summary: 'Ran the targeted worker inspector tests.',
          commands: [
            { command: 'npm test -- workerInspector', cwd: 'GemmaDesktopApp' },
          ],
        },
      },
      1_900,
    )

    expect(updated[0]?.worker?.resultData?.commands).toEqual([
      {
        command: 'npm test -- workerInspector',
        cwd: 'GemmaDesktopApp',
      },
    ])
    expect(updated[0]?.worker?.counters).toEqual(
      expect.objectContaining({
        commandsRun: 1,
      }),
    )
  })

  it('clears or rolls forward the active tool as tool results arrive', () => {
    let blocks = appendToolCallBlock(
      [],
      {
        toolName: 'read_file',
        input: { path: 'src/main/ipc.ts' },
        callId: 'tool-read',
      },
      1_000,
    )
    blocks = appendToolCallBlock(
      blocks,
      {
        toolName: 'edit_file',
        input: { path: 'src/App.tsx' },
        callId: 'tool-edit',
      },
      1_200,
    )

    let activity = refreshLiveActivityFromToolBlocks(
      createInitialSessionLiveActivity(500),
      blocks,
      1_200,
      2,
    )
    expect(activity.activeToolName).toBe('edit_file')
    expect(activity.runningToolCount).toBe(2)

    blocks = applyToolResultToBlocks(
      blocks,
      {
        callId: 'tool-edit',
        output: 'Updated src/App.tsx',
      },
      1_500,
    )
    activity = refreshLiveActivityFromToolBlocks(activity, blocks, 1_500, 1)

    expect(activity.activeToolName).toBe('read_file')
    expect(activity.activeToolLabel).toBe('Inspecting project')
    expect(activity.runningToolCount).toBe(1)
    expect(activity.completedToolCount).toBe(1)

    blocks = applyToolResultToBlocks(
      blocks,
      {
        callId: 'tool-read',
        output: 'Read file contents',
      },
      1_900,
    )
    activity = refreshLiveActivityFromToolBlocks(activity, blocks, 1_900, 1)

    expect(activity.activeToolName).toBeUndefined()
    expect(activity.activeToolLabel).toBeUndefined()
    expect(activity.runningToolCount).toBe(0)
    expect(activity.completedToolCount).toBe(2)
  })

  it('applies direct tool progress updates to the matching tool block', () => {
    const blocks = appendToolCallBlock(
      [],
      {
        toolName: 'read_file',
        input: { path: 'attention_is_all_you_need.pdf' },
        callId: 'tool-read-file',
      },
      1_000,
    )

    const updated = applyDirectToolProgressToBlocks(
      blocks,
      {
        callId: 'tool-read-file',
        toolName: 'read_file',
        id: 'pdf-extract',
        label: 'Reading page 3 of 14',
      },
      1_200,
    )

    expect(updated.changed).toBe(true)
    expect(updated.blocks[0]?.progressEntries).toEqual([
      {
        id: 'pdf-extract',
        label: 'Reading page 3 of 14',
        timestamp: 1_200,
        tone: undefined,
      },
    ])
  })
})
