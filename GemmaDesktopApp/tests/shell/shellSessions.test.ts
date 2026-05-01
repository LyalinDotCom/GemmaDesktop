import { describe, expect, it, vi } from 'vitest'
import { appendShellTranscript } from '../../src/shared/shellSession'

const mockPtyState = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number
    rows: number
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    emitData: (chunk: string) => void
    emitExit: (exitCode: number) => void
  }>,
  spawn: vi.fn(),
}))

vi.mock('@lydell/node-pty', () => ({
  spawn: mockPtyState.spawn.mockImplementation((
    _file: string,
    _args: string[],
    options: {
      cols: number
      rows: number
    },
  ) => {
    let onDataHandler: ((chunk: string) => void) | null = null
    let onExitHandler: ((event: { exitCode: number }) => void) | null = null
    const record = {
      cols: options.cols,
      rows: options.rows,
      write: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        record.cols = cols
        record.rows = rows
      }),
      kill: vi.fn(),
      onData: (handler: (chunk: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      },
      onExit: (handler: (event: { exitCode: number }) => void) => {
        onExitHandler = handler
        return { dispose: vi.fn() }
      },
      emitData: (chunk: string) => {
        onDataHandler?.(chunk)
      },
      emitExit: (exitCode: number) => {
        onExitHandler?.({ exitCode })
      },
    }
    mockPtyState.instances.push(record)
    return record
  }),
}))

import { ShellSessionManager } from '../../src/main/shellSessions'

describe('shell session manager', () => {
  it('spawns a PTY in the session working directory and streams updates', () => {
    const onUpdated = vi.fn()
    const manager = new ShellSessionManager({
      appendTranscript: appendShellTranscript,
      onUpdated,
    })

    manager.start({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      command: 'pwd',
      workingDirectory: '/tmp/project',
      cols: 120,
      rows: 40,
      startedAt: 1_000,
    })

    expect(mockPtyState.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-lc', 'pwd']),
      expect.objectContaining({
        cwd: '/tmp/project',
        cols: 120,
        rows: 40,
      }),
    )

    mockPtyState.instances[0]?.emitData('/tmp/project\n')
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      transcript: '/tmp/project\n',
      status: 'running',
    }))
  })

  it('supports input, resize, and close lifecycle updates', () => {
    const onUpdated = vi.fn()
    const manager = new ShellSessionManager({
      appendTranscript: appendShellTranscript,
      onUpdated,
    })

    manager.start({
      terminalId: 'terminal-2',
      sessionId: 'session-2',
      messageId: 'message-2',
      command: 'cat',
      workingDirectory: '/tmp/project',
      startedAt: 1_000,
    })

    manager.write('session-2', 'terminal-2', 'hello\n')
    manager.resize('session-2', 'terminal-2', 140, 50)
    manager.close('session-2', 'terminal-2')
    mockPtyState.instances[1]?.emitExit(130)

    expect(mockPtyState.instances[1]?.write).toHaveBeenCalledWith('hello\n')
    expect(mockPtyState.instances[1]?.resize).toHaveBeenCalledWith(140, 50)
    expect(mockPtyState.instances[1]?.kill).toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      collapsed: true,
    }))
    expect(onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'killed',
      exitCode: 130,
    }))
  })

  it('can inspect a live shell session without mutating it', () => {
    const manager = new ShellSessionManager({
      appendTranscript: appendShellTranscript,
      onUpdated: vi.fn(),
    })

    manager.start({
      terminalId: 'terminal-3',
      sessionId: 'session-3',
      messageId: 'message-3',
      command: 'npm run dev',
      workingDirectory: '/tmp/project',
      startedAt: 1_000,
    })

    expect(manager.inspect('session-3', 'terminal-3')).toEqual(
      expect.objectContaining({
        terminalId: 'terminal-3',
        sessionId: 'session-3',
        status: 'running',
      }),
    )
  })
})
