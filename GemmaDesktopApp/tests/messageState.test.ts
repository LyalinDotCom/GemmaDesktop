import { describe, expect, it } from 'vitest'
import {
  appendChatMessage,
  getRenderableChatMessages,
  updateChatMessage,
} from '../src/renderer/src/lib/messageState'
import type { ChatMessage } from '../src/renderer/src/types'

function buildMessage(
  id: string,
  content: ChatMessage['content'],
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1_000,
  }
}

function buildUserMessage(id: string, timestamp: number): ChatMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: id }],
    timestamp,
  }
}

function buildAssistantTextMessage(
  id: string,
  text: string,
  timestamp: number,
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
  }
}

function buildBackgroundProcessNotice(
  id: string,
  command: string,
  timestamp: number,
  status: 'running' | 'exited' = 'running',
  exitCode?: number,
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      {
        type: 'shell_session',
        terminalId: `terminal-${id}`,
        command,
        workingDirectory: '/tmp/project',
        status,
        startedAt: timestamp,
        completedAt: status === 'exited' ? timestamp + 5_000 : undefined,
        exitCode,
        transcript: '',
        collapsed: false,
        displayMode: 'sidebar',
      },
    ],
    timestamp,
  }
}

describe('message state helpers', () => {
  it('replaces an existing message in place during streaming updates', () => {
    const initial = buildMessage('shell-1', [
      {
        type: 'shell_session',
        terminalId: 'terminal-1',
        command: 'pwd',
        workingDirectory: '/tmp/project',
        status: 'running',
        startedAt: 1_000,
        transcript: '',
        collapsed: false,
      },
    ])
    const updated = buildMessage('shell-1', [
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
    ])

    expect(updateChatMessage([initial], updated)).toEqual([updated])
  })

  it('upserts by id when a shell card is first inserted', () => {
    const message = buildMessage('shell-2', [
      {
        type: 'shell_session',
        terminalId: 'terminal-2',
        command: 'ls',
        workingDirectory: '/tmp/project',
        status: 'running',
        startedAt: 1_000,
        transcript: '',
        collapsed: false,
      },
    ])

    expect(appendChatMessage([], message)).toEqual([message])
  })
})

describe('getRenderableChatMessages', () => {
  it('returns the input untouched when there are no background notices', () => {
    const messages = [
      buildUserMessage('user-1', 1_000),
      buildAssistantTextMessage('assistant-1', 'reply', 2_000),
    ]
    expect(getRenderableChatMessages(messages)).toBe(messages)
  })

  it('removes a background-process notice from chat rendering', () => {
    const user = buildUserMessage('user-1', 1_000)
    const notice = buildBackgroundProcessNotice('process-1', 'npm run dev', 1_500)
    const assistant = buildAssistantTextMessage('assistant-1', 'started server', 5_000)

    const renderable = getRenderableChatMessages([user, notice, assistant])

    expect(renderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('keeps status-only process updates out of chat rendering', () => {
    const user = buildUserMessage('user-1', 1_000)
    const noticeRunning = buildBackgroundProcessNotice('process-1', 'npm run dev', 1_500, 'running')
    const assistant = buildAssistantTextMessage('assistant-1', 'started server', 5_000)
    const initialOrder = [user, noticeRunning, assistant]
    const initialRenderable = getRenderableChatMessages(initialOrder)

    const noticeExited = buildBackgroundProcessNotice('process-1', 'npm run dev', 1_500, 'exited', 1)
    const updatedOrder = [user, noticeExited, assistant]
    const updatedRenderable = getRenderableChatMessages(updatedOrder)

    expect(initialRenderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
    ])
    expect(updatedRenderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('removes notices per turn when multiple turns are present', () => {
    const messages = [
      buildUserMessage('user-1', 1_000),
      buildBackgroundProcessNotice('process-1', 'npm run dev', 1_200),
      buildAssistantTextMessage('assistant-1', 'started dev server', 1_400),
      buildUserMessage('user-2', 5_000),
      buildBackgroundProcessNotice('process-2', 'npm test', 5_200),
      buildAssistantTextMessage('assistant-2', 'tests passing', 5_400),
    ]

    const renderable = getRenderableChatMessages(messages)

    expect(renderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ])
  })

  it('removes intro-section notices too', () => {
    const intro = buildBackgroundProcessNotice('process-1', 'npm run dev', 100)
    const user = buildUserMessage('user-1', 1_000)
    const assistant = buildAssistantTextMessage('assistant-1', 'reply', 2_000)

    const renderable = getRenderableChatMessages([intro, user, assistant])
    expect(renderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('keeps relative order of non-notice messages within one turn', () => {
    const messages = [
      buildUserMessage('user-1', 1_000),
      buildBackgroundProcessNotice('process-a', 'npm run dev', 1_100),
      buildAssistantTextMessage('assistant-1', 'first reply', 1_200),
      buildBackgroundProcessNotice('process-b', 'npm run watch', 1_300),
      buildAssistantTextMessage('assistant-2', 'second reply', 1_400),
    ]

    const renderable = getRenderableChatMessages(messages)

    expect(renderable.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
      'assistant-2',
    ])
  })

  it('does not remove shell_session blocks without sidebar displayMode (chat shells)', () => {
    const user = buildUserMessage('user-1', 1_000)
    const chatShell: ChatMessage = {
      id: 'shell-chat-1',
      role: 'assistant',
      content: [
        {
          type: 'shell_session',
          terminalId: 'terminal-chat',
          command: 'ls',
          workingDirectory: '/tmp',
          status: 'exited',
          exitCode: 0,
          startedAt: 1_100,
          completedAt: 1_200,
          transcript: '',
          collapsed: false,
          displayMode: 'chat',
        },
      ],
      timestamp: 1_100,
    }
    const assistant = buildAssistantTextMessage('assistant-1', 'reply', 2_000)

    const renderable = getRenderableChatMessages([user, chatShell, assistant])
    expect(renderable.map((m) => m.id)).toEqual([
      'user-1',
      'shell-chat-1',
      'assistant-1',
    ])
  })
})
