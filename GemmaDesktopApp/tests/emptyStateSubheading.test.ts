import { describe, expect, it } from 'vitest'
import { buildEmptyStateSubheading } from '../src/renderer/src/lib/emptyStateSubheading'
import type { ModelSummary, SessionDetail } from '../src/renderer/src/types'

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 'session-1',
    title: 'Untitled',
    titleSource: 'user',
    modelId: 'gemma4:26b',
    runtimeId: 'ollama-native',
    usesTemporaryModelOverride: false,
    conversationKind: 'normal',
    workMode: 'explore',
    planMode: false,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    workingDirectory: '/tmp/project',
    lastMessage: '',
    createdAt: 0,
    updatedAt: 0,
    isGenerating: false,
    isCompacting: false,
    draftText: '',
    messages: [],
    ...overrides,
  }
}

function makeModel(overrides: Partial<ModelSummary>): ModelSummary {
  return {
    id: 'gemma4:26b',
    name: 'Gemma 4 26B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    status: 'available',
    ...overrides,
  }
}

describe('buildEmptyStateSubheading', () => {
  it('returns null when there is no active session', () => {
    expect(buildEmptyStateSubheading(null, [])).toBeNull()
  })

  it('uses the Gemma catalog label and the loaded context length when available', () => {
    const session = makeSession({ modelId: 'gemma4:26b' })
    const model = makeModel({
      id: 'gemma4:26b',
      contextLength: 262_144,
      runtimeConfig: {
        provider: 'ollama',
        loadedContextLength: 131_072,
      },
    })

    expect(buildEmptyStateSubheading(session, [model])).toBe(
      'Gemma 4 26B · 128K context',
    )
  })

  it('falls back to the Gemma catalog nominal size when no model is loaded', () => {
    const session = makeSession({ modelId: 'gemma4:e4b' })

    expect(buildEmptyStateSubheading(session, [])).toBe(
      'Gemma 4 E4B · 128K context',
    )
  })

  it('uses the runtime model name for non-Gemma models', () => {
    const session = makeSession({
      modelId: 'custom:abc',
      runtimeId: 'ollama-native',
    })
    const model = makeModel({
      id: 'custom:abc',
      name: 'Custom 7B',
      contextLength: 32_768,
    })

    expect(buildEmptyStateSubheading(session, [model])).toBe(
      'Custom 7B · 32K context',
    )
  })

  it('omits the context segment when no context length can be resolved', () => {
    const session = makeSession({
      modelId: 'custom:abc',
      runtimeId: 'ollama-native',
    })
    const model = makeModel({ id: 'custom:abc', name: 'Custom 7B' })

    expect(buildEmptyStateSubheading(session, [model])).toBe('Custom 7B')
  })
})
