import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendShellTranscript } from '../src/shared/shellSession'

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

import { AppTerminalManager } from '../src/main/appTerminal'

describe('app terminal manager', () => {
  beforeEach(() => {
    mockPtyState.instances.length = 0
    mockPtyState.spawn.mockClear()
  })

  it('starts an interactive shell in the requested working directory', () => {
    const onUpdated = vi.fn()
    const manager = new AppTerminalManager({
      appendTranscript: appendShellTranscript,
      onUpdated,
    })

    const state = manager.start({
      workingDirectory: '/tmp/project',
      cols: 120,
      rows: 40,
      startedAt: 1_000,
    })

    expect(mockPtyState.spawn).toHaveBeenCalledWith(
      expect.any(String),
      process.platform === 'win32' ? [] : ['-l'],
      expect.objectContaining({
        cwd: '/tmp/project',
        cols: 120,
        rows: 40,
      }),
    )
    expect(state).toEqual(expect.objectContaining({
      status: 'running',
      workingDirectory: '/tmp/project',
    }))

    mockPtyState.instances[0]?.emitData('ready\n')
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'ready\n',
    }))
  })

  it('supports input, resize, and terminate while retaining the last state', () => {
    const onUpdated = vi.fn()
    const manager = new AppTerminalManager({
      appendTranscript: appendShellTranscript,
      onUpdated,
    })

    manager.start({
      workingDirectory: '/tmp/project',
      startedAt: 1_000,
    })

    manager.write('npm run dev\n')
    manager.resize(140, 50)
    manager.terminate()
    mockPtyState.instances[0]?.emitExit(130)

    expect(mockPtyState.instances[0]?.write).toHaveBeenCalledWith('npm run dev\n')
    expect(mockPtyState.instances[0]?.resize).toHaveBeenCalledWith(140, 50)
    expect(mockPtyState.instances[0]?.kill).toHaveBeenCalled()
    expect(onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'killed',
      exitCode: 130,
    }))
    expect(manager.getState()).toEqual(expect.objectContaining({
      status: 'killed',
      exitCode: 130,
    }))
  })

  it('reuses the running PTY until the shell exits', () => {
    const manager = new AppTerminalManager({
      appendTranscript: appendShellTranscript,
      onUpdated: vi.fn(),
    })

    const firstState = manager.start({
      workingDirectory: '/tmp/project',
      startedAt: 1_000,
    })
    const secondState = manager.start({
      workingDirectory: '/tmp/other',
      startedAt: 2_000,
    })

    expect(mockPtyState.spawn).toHaveBeenCalledTimes(1)
    expect(secondState).toEqual(firstState)
  })
})
