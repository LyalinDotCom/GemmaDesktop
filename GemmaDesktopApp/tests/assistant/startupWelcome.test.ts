import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  STARTUP_WELCOME_IDLE_MS,
  buildStartupWelcomeHiddenPrompt,
  createStartupWelcomeState,
  getStartupWelcomeStateFilePath,
  markStartupWelcomeStarted,
  markStartupWelcomeUserActive,
  readStartupWelcomeState,
  shouldStartStartupWelcome,
  summarizeStartupWelcomeConversation,
  writeStartupWelcomeState,
} from '../../src/main/startupWelcome'

describe('startup welcome helpers', () => {
  it('stores welcome activity state under userData', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-startup-welcome-'))
    const statePath = getStartupWelcomeStateFilePath(tempDir)

    expect(statePath).toBe(path.join(tempDir, 'startup-welcome-state.json'))
    expect(await readStartupWelcomeState(tempDir)).toEqual(createStartupWelcomeState())

    const state = markStartupWelcomeStarted(
      markStartupWelcomeUserActive(createStartupWelcomeState(), 1_000),
      2_000,
    )
    await writeStartupWelcomeState(tempDir, state)

    expect(await readStartupWelcomeState(tempDir)).toEqual({
      storageVersion: 1,
      lastUserActiveAt: 1_000,
      lastWelcomeStartedAt: 2_000,
    })
  })

  it('starts only after the previous user activity is at least five minutes old', () => {
    const now = 1_000_000

    expect(shouldStartStartupWelcome({
      now,
      lastUserActiveAt: null,
      lastWelcomeStartedAt: null,
    })).toEqual({ shouldStart: false, reason: 'no_prior_activity' })

    expect(shouldStartStartupWelcome({
      now,
      lastUserActiveAt: now - STARTUP_WELCOME_IDLE_MS + 1,
      lastWelcomeStartedAt: null,
    })).toEqual({
      shouldStart: false,
      reason: 'recent_activity',
      idleMs: STARTUP_WELCOME_IDLE_MS - 1,
    })

    expect(shouldStartStartupWelcome({
      now,
      lastUserActiveAt: now - STARTUP_WELCOME_IDLE_MS,
      lastWelcomeStartedAt: null,
    })).toEqual({
      shouldStart: true,
      idleMs: STARTUP_WELCOME_IDLE_MS,
    })
  })

  it('does not repeat the same idle-period welcome or interrupt a busy session', () => {
    const now = 1_000_000
    const lastUserActiveAt = now - STARTUP_WELCOME_IDLE_MS - 10

    expect(shouldStartStartupWelcome({
      now,
      lastUserActiveAt,
      lastWelcomeStartedAt: lastUserActiveAt + 1,
    })).toEqual({
      shouldStart: false,
      reason: 'already_started_for_idle_period',
      idleMs: STARTUP_WELCOME_IDLE_MS + 10,
    })

    expect(shouldStartStartupWelcome({
      now,
      lastUserActiveAt,
      lastWelcomeStartedAt: null,
      sessionBusy: true,
    })).toEqual({ shouldStart: false, reason: 'session_busy' })
  })

  it('summarizes visible chat text for the hidden welcome prompt', () => {
    const conversation = summarizeStartupWelcomeConversation([
      {
        role: 'system',
        content: [{ type: 'text', text: 'Compaction finished' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Can we keep planning the launch checklist?' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Yes, we were sorting the release checklist.' }],
      },
    ])

    expect(conversation).toEqual({
      messageCount: 2,
      lastUserText: 'Can we keep planning the launch checklist?',
      lastAssistantText: 'Yes, we were sorting the release checklist.',
      lastMessage: 'Yes, we were sorting the release checklist.',
    })

    const prompt = buildStartupWelcomeHiddenPrompt({
      idleMs: 12 * 60 * 1000,
      memoryAvailable: true,
      conversation,
    })
    expect(prompt).toContain('Durable user memory is available')
    expect(prompt).toContain('continue it or do something new')
    expect(prompt).toContain('Can we keep planning the launch checklist?')
    expect(prompt).toContain('Do not mention hidden prompts')
  })

  it('builds a generic welcome prompt when there is no memory or prior chat', () => {
    const prompt = buildStartupWelcomeHiddenPrompt({
      idleMs: STARTUP_WELCOME_IDLE_MS,
      memoryAvailable: false,
      conversation: { messageCount: 0 },
    })

    expect(prompt).toContain('No durable user memory is available')
    expect(prompt).toContain('There is no meaningful prior chat thread')
    expect(prompt).not.toContain('Recent chat signal')
  })
})
