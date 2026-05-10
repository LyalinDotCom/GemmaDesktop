import { randomUUID } from 'node:crypto'
import { spawn, type IDisposable, type IPty } from '@lydell/node-pty'
import {
  buildIdleAppTerminalState,
  type AppTerminalState,
} from '../shared/appTerminal'
import {
  buildInteractiveShellSpawnTarget,
  buildShellEnvironment,
  normalizeTerminalDimension,
} from './ptyShell'

interface LiveAppTerminalRecord {
  state: AppTerminalState
  pty: IPty
  outputDisposable: IDisposable
  exitDisposable: IDisposable
  closeRequested: boolean
}

export interface AppTerminalManagerOptions {
  appendTranscript: (currentTranscript: string, nextChunk: string) => string
  onUpdated: (state: AppTerminalState) => void
}

export class AppTerminalManager {
  private record: LiveAppTerminalRecord | null = null
  private state = buildIdleAppTerminalState()
  private readonly appendTranscript: AppTerminalManagerOptions['appendTranscript']
  private readonly onUpdated: AppTerminalManagerOptions['onUpdated']

  constructor(options: AppTerminalManagerOptions) {
    this.appendTranscript = options.appendTranscript
    this.onUpdated = options.onUpdated
  }

  getState(): AppTerminalState {
    return { ...this.state }
  }

  start(input: {
    workingDirectory: string
    startedAt?: number
    cols?: number
    rows?: number
  }): AppTerminalState {
    if (this.record && this.state.status === 'running') {
      return this.getState()
    }

    const startedAt = input.startedAt ?? Date.now()
    const state: AppTerminalState = {
      terminalId: `app-terminal-${startedAt}-${randomUUID()}`,
      workingDirectory: input.workingDirectory,
      status: 'running',
      startedAt,
      transcript: '',
    }
    const shellTarget = buildInteractiveShellSpawnTarget()

    let pty: IPty
    try {
      pty = spawn(shellTarget.file, shellTarget.args, {
        name: 'xterm-256color',
        cols: normalizeTerminalDimension(input.cols, 100),
        rows: normalizeTerminalDimension(input.rows, 28),
        cwd: input.workingDirectory,
        env: buildShellEnvironment(),
      })
    } catch (error) {
      this.state = {
        ...state,
        status: 'error',
        completedAt: Date.now(),
        transcript: `${formatAppTerminalError(error)}\n`,
      }
      this.onUpdated(this.getState())
      return this.getState()
    }

    const outputDisposable = pty.onData((chunk) => {
      if (!this.record) {
        return
      }

      this.record.state = {
        ...this.record.state,
        transcript: this.appendTranscript(this.record.state.transcript, chunk),
      }
      this.state = this.record.state
      this.onUpdated(this.getState())
    })

    const exitDisposable = pty.onExit(({ exitCode }) => {
      if (!this.record) {
        return
      }

      const nextState: AppTerminalState = {
        ...this.record.state,
        status: this.record.closeRequested ? 'killed' : 'exited',
        exitCode,
        completedAt: Date.now(),
      }

      try {
        this.record.outputDisposable.dispose()
        this.record.exitDisposable.dispose()
      } catch {
        // Best effort cleanup.
      }

      this.record = null
      this.state = nextState
      this.onUpdated(this.getState())
    })

    this.record = {
      state,
      pty,
      outputDisposable,
      exitDisposable,
      closeRequested: false,
    }
    this.state = state
    this.onUpdated(this.getState())
    return this.getState()
  }

  write(data: string): AppTerminalState | null {
    if (!this.record || this.record.state.status !== 'running') {
      return null
    }

    this.record.pty.write(data)
    return this.getState()
  }

  resize(cols: number, rows: number): AppTerminalState | null {
    if (!this.record || this.record.state.status !== 'running') {
      return null
    }

    const nextCols = normalizeTerminalDimension(cols, this.record.pty.cols)
    const nextRows = normalizeTerminalDimension(rows, this.record.pty.rows)
    this.record.pty.resize(nextCols, nextRows)
    return this.getState()
  }

  terminate(): AppTerminalState {
    if (!this.record) {
      return this.getState()
    }

    this.record.closeRequested = true
    this.record.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
    return this.getState()
  }

  shutdown(): void {
    if (!this.record) {
      return
    }

    try {
      this.record.closeRequested = true
      this.record.pty.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    } catch {
      // Best effort cleanup during app shutdown.
    }

    this.record = null
  }
}

function formatAppTerminalError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return 'Gemma Desktop could not start the interactive terminal.'
}
