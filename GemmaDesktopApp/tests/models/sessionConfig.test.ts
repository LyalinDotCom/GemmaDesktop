import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '@gemma-desktop/sdk-core'
import {
  APP_SESSION_METADATA_KEY,
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
  it('does not persist legacy per-session primary model source metadata', () => {
    const metadata = createSessionMetadata(null, makeConfig())
    const appMetadata = metadata[APP_SESSION_METADATA_KEY] as Record<string, unknown>

    expect(appMetadata).not.toHaveProperty('primaryModelSource')
  })

  it('ignores legacy primary model source metadata when restoring config', () => {
    const metadata = createSessionMetadata(null, makeConfig())
    const appMetadata = metadata[APP_SESSION_METADATA_KEY] as Record<string, unknown>
    const restored = getSessionConfig(makeSnapshot({
      ...metadata,
      [APP_SESSION_METADATA_KEY]: {
        ...appMetadata,
        primaryModelSource: 'custom',
      },
    }))

    expect(restored).not.toHaveProperty('primaryModelSource')
  })
})
