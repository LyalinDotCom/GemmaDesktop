import { describe, expect, it } from 'vitest'
import { __testOnly } from '../src/renderer/src/hooks/useAppState'
import type { MessageContent } from '../src/renderer/src/types'

describe('useAppState stop handling', () => {
  it('preserves plan mode and selected skills when creating a session', () => {
    expect(__testOnly.buildCreateSessionBridgeOptions({
      modelId: 'gemma4:31b',
      runtimeId: 'ollama-native',
      conversationKind: 'normal',
      workMode: 'build',
      planMode: true,
      selectedSkillIds: ['skill-a'],
      selectedToolIds: ['search_web'],
      workingDirectory: '/tmp/project',
      title: 'Plan first',
    })).toEqual({
      modelId: 'gemma4:31b',
      runtimeId: 'ollama-native',
      conversationKind: 'normal',
      workMode: 'build',
      planMode: true,
      selectedSkillIds: ['skill-a'],
      selectedToolIds: ['search_web'],
      workingDirectory: '/tmp/project',
      title: 'Plan first',
    })
  })

  it('marks the latest streaming tool and research blocks as stopped', () => {
    const content: MessageContent[] = [
      {
        type: 'tool_call',
        toolName: 'write_file',
        input: { path: 'src/App.tsx' },
        status: 'running',
      },
      {
        type: 'research_panel',
        panel: {
          runId: 'run-1',
          runStatus: 'running',
          stage: 'workers',
          title: 'DeepMind April 2026',
          plan: {
            status: 'completed',
            label: 'Research plan created',
            topicCount: 2,
          },
          sources: {
            status: 'running',
            label: 'Gathering 12 sources and counting…',
            totalSources: 12,
            targetSources: 20,
            distinctDomains: 3,
            targetDomains: 8,
            topDomains: [],
            otherDomainCount: 0,
            otherDomainSourceCount: 0,
          },
          topics: [
            {
              id: 'topic-1',
              title: 'Gemma 4',
              status: 'running',
              sourceCount: 5,
              searchCount: 2,
              fetchCount: 3,
              label: 'Researching Gemma 4',
            },
          ],
          synthesis: {
            status: 'pending',
            label: 'Synthesize the final report',
          },
          liveHint: 'Topic workers are reading sources',
        },
      },
    ]

    expect(__testOnly.finalizeStreamingContentForStopping(content)).toEqual([
      {
        type: 'tool_call',
        toolName: 'write_file',
        input: { path: 'src/App.tsx' },
        status: 'error',
      },
      {
        type: 'research_panel',
        panel: {
          runId: 'run-1',
          runStatus: 'cancelled',
          stage: 'workers',
          title: 'DeepMind April 2026',
          plan: {
            status: 'completed',
            label: 'Research plan created',
            topicCount: 2,
          },
          sources: {
            status: 'cancelled',
            label: 'Gathering 12 sources and counting…',
            totalSources: 12,
            targetSources: 20,
            distinctDomains: 3,
            targetDomains: 8,
            topDomains: [],
            otherDomainCount: 0,
            otherDomainSourceCount: 0,
          },
          topics: [
            {
              id: 'topic-1',
              title: 'Gemma 4',
              status: 'cancelled',
              sourceCount: 5,
              searchCount: 2,
              fetchCount: 3,
              label: 'Researching Gemma 4',
            },
          ],
          synthesis: {
            status: 'pending',
            label: 'Synthesize the final report',
          },
          liveHint: undefined,
        },
      },
    ])
  })
})
