import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '@gemma-desktop/sdk-core'
import {
  createSessionMetadata,
  getSessionConfig,
  normalizeSessionConfig,
  type AppSessionConfig,
} from '../../src/main/sessionConfig'

function makeConfig(
  overrides: Partial<AppSessionConfig> = {},
): AppSessionConfig {
  return normalizeSessionConfig({
    conversationKind: 'normal',
    baseMode: 'explore',
    planMode: false,
    preferredRuntimeId: 'ollama-native',
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    approvalMode: 'require_approval',
    surface: 'default',
    visibility: 'visible',
    storageScope: 'project',
    ...overrides,
  })
}

function makeSnapshot(metadata: Record<string, unknown>): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    modelId: 'gemma4:26b',
    runtimeId: 'ollama-native',
    mode: 'assistant',
    maxSteps: 20,
    started: false,
    workingDirectory: '/tmp/project',
    history: [],
    metadata,
    savedAt: new Date(0).toISOString(),
  }
}

describe('session config metadata', () => {
  it('persists whether the primary model follows settings or is customized', () => {
    const defaultMetadata = createSessionMetadata(
      null,
      makeConfig({ primaryModelSource: 'default' }),
    )
    const customMetadata = createSessionMetadata(
      null,
      makeConfig({ primaryModelSource: 'custom' }),
    )

    expect(getSessionConfig(makeSnapshot(defaultMetadata)).primaryModelSource).toBe('default')
    expect(getSessionConfig(makeSnapshot(customMetadata)).primaryModelSource).toBe('custom')
  })

  it('leaves legacy sessions without a model source marker unpinned', () => {
    const legacyMetadata = createSessionMetadata(null, makeConfig())

    expect(getSessionConfig(makeSnapshot(legacyMetadata)).primaryModelSource).toBeUndefined()
  })
})
