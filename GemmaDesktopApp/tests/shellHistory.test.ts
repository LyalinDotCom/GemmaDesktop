import { describe, expect, it } from 'vitest'
import {
  serializeChatMessage,
  serializeSessionHistory,
} from '../src/renderer/src/lib/chatCopy'
import { buildSessionContextEstimate } from '../src/renderer/src/lib/sessionContext'
import type { ChatMessage } from '../src/renderer/src/types'

const shellMessage: ChatMessage = {
  id: 'shell-1',
  role: 'assistant',
  timestamp: 1_000,
  content: [
    {
      type: 'shell_session',
      terminalId: 'terminal-1',
      command: 'pwd',
      workingDirectory: '/tmp/project',
      status: 'exited',
      exitCode: 0,
      startedAt: 1_000,
      completedAt: 2_000,
      transcript: '/tmp/project\n',
      collapsed: true,
    },
  ],
}

describe('shell cards in history helpers', () => {
  it('includes shell transcripts in exported chat history', () => {
    const serialized = serializeChatMessage(shellMessage)

    expect(serialized).toContain('[Shell: !pwd]')
    expect(serialized).toContain('/tmp/project')
  })

  it('includes conversation metadata at the top of copied chat history', () => {
    const serialized = serializeSessionHistory({
      messages: [shellMessage],
      debugEnabled: false,
      debugLogs: [],
      debugSession: null,
      sessionTitle: 'Build Notes',
      workingDirectory: '/Users/me/project',
    })

    expect(
      serialized.startsWith('Conversation: Build Notes\nLocal directory: /Users/me/project'),
    ).toBe(true)
    expect(serialized).toContain('\n\n---\n\nGemma')
  })

  it('excludes shell cards from visible-chat context estimates', () => {
    expect(buildSessionContextEstimate(null, [shellMessage])).toEqual({
      tokensUsed: 0,
      source: 'visible-chat',
    })
  })
})
