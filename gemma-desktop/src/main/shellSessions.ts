import { spawn, type IPty } from '@lydell/node-pty'
import type { IDisposable } from '@lydell/node-pty'
import type {
  ShellSessionContentBlock,
  ShellSessionDisplayMode,
  ShellSessionStatus,
} from '../shared/shellSession'
import {
  buildCommandShellSpawnTarget,
  buildShellEnvironment,
  normalizeTerminalDimension,
} from './ptyShell'

export interface LiveShellSessionState {
  terminalId: string
  sessionId: string
  messageId: string
  command: string
  workingDirectory: string
  status: ShellSessionStatus
  exitCode?: number | null
  startedAt: number
  completedAt?: number
  transcript: string
  collapsed: boolean
  displayMode: ShellSessionDisplayMode
}

interface LiveShellSessionRecord {
  state: LiveShellSessionState
  pty: IPty
  outputDisposable: IDisposable
  exitDisposable: IDisposable
  closeRequested: boolean
}

export interface ShellSessionManagerOptions {
  appendTranscript: (currentTranscript: string, nextChunk: string) => string
  onUpdated: (state: LiveShellSessionState) => void
}

export class ShellSessionManager {
  private readonly records = new Map<string, LiveShellSessionRecord>()
  private readonly appendTranscript: ShellSessionManagerOptions['appendTranscript']
  private readonly onUpdated: ShellSessionManagerOptions['onUpdated']

  constructor(options: ShellSessionManagerOptions) {
    this.appendTranscript = options.appendTranscript
    this.onUpdated = options.onUpdated
  }

  start(input: {
    terminalId: string
    sessionId: string
    messageId: string
    command: string
    workingDirectory: string
    startedAt?: number
    cols?: number
    rows?: number
    displayMode?: ShellSessionDisplayMode
  }): LiveShellSessionState {
    const shellTarget = buildCommandShellSpawnTarget(input.command)
    const startedAt = input.startedAt ?? Date.now()
    const pty = spawn(shellTarget.file, shellTarget.args, {
      name: 'xterm-256color',
      cols: normalizeTerminalDimension(input.cols, 100),
      rows: normalizeTerminalDimension(input.rows, 28),
      cwd: input.workingDirectory,
      env: buildShellEnvironment(),
    })

    const state: LiveShellSessionState = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      command: input.command,
      workingDirectory: input.workingDirectory,
      status: 'running',
      startedAt,
      transcript: '',
      collapsed: false,
      displayMode: input.displayMode ?? 'chat',
    }

    const outputDisposable = pty.onData((chunk) => {
      const record = this.records.get(input.terminalId)
      if (!record) {
        return
      }

      record.state = {
        ...record.state,
        transcript: this.appendTranscript(record.state.transcript, chunk),
      }
      this.onUpdated(record.state)
    })

    const exitDisposable = pty.onExit(({ exitCode }) => {
      const record = this.records.get(input.terminalId)
      if (!record) {
        return
      }

      const nextState: LiveShellSessionState = {
        ...record.state,
        status: record.closeRequested ? 'killed' : 'exited',
        exitCode,
        completedAt: Date.now(),
      }
      this.records.delete(input.terminalId)
      try {
        outputDisposable.dispose()
        exitDisposable.dispose()
      } catch {
        // Best effort cleanup.
      }
      this.onUpdated(nextState)
    })

    this.records.set(input.terminalId, {
      state,
      pty,
      outputDisposable,
      exitDisposable,
      closeRequested: false,
    })

    return state
  }

  write(
    sessionId: string,
    terminalId: string,
    data: string,
  ): LiveShellSessionState | null {
    const record = this.getRecord(sessionId, terminalId)
    if (!record || record.state.status !== 'running') {
      return null
    }

    record.pty.write(data)
    return record.state
  }

  inspect(
    sessionId: string,
    terminalId: string,
  ): LiveShellSessionState | null {
    const record = this.getRecord(sessionId, terminalId)
    if (!record) {
      return null
    }

    return { ...record.state }
  }

  resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): LiveShellSessionState | null {
    const record = this.getRecord(sessionId, terminalId)
    if (!record || record.state.status !== 'running') {
      return null
    }

    const nextCols = normalizeTerminalDimension(cols, record.pty.cols)
    const nextRows = normalizeTerminalDimension(rows, record.pty.rows)
    record.pty.resize(nextCols, nextRows)
    return record.state
  }

  close(
    sessionId: string,
    terminalId: string,
  ): LiveShellSessionState | null {
    const record = this.getRecord(sessionId, terminalId)
    if (!record) {
      return null
    }

    if (record.state.status !== 'running') {
      record.state = {
        ...record.state,
        collapsed: true,
      }
      return record.state
    }

    record.closeRequested = true
    record.state = {
      ...record.state,
      collapsed: true,
    }
    this.onUpdated(record.state)
    record.pty.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    return record.state
  }

  shutdown(): void {
    for (const record of this.records.values()) {
      try {
        record.closeRequested = true
        record.pty.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
      } catch {
        // Best effort cleanup during app shutdown.
      }
    }
    this.records.clear()
  }

  hasActiveSession(sessionId: string, terminalId: string): boolean {
    return this.getRecord(sessionId, terminalId) !== null
  }

  closeAllForSession(sessionId: string): void {
    const terminalIds = [...this.records.values()]
      .filter((record) => record.state.sessionId === sessionId)
      .map((record) => record.state.terminalId)

    for (const terminalId of terminalIds) {
      this.close(sessionId, terminalId)
    }
  }

  private getRecord(
    sessionId: string,
    terminalId: string,
  ): LiveShellSessionRecord | null {
    const record = this.records.get(terminalId)
    if (!record || record.state.sessionId !== sessionId) {
      return null
    }

    return record
  }
}

export function buildShellContentBlock(
  state: LiveShellSessionState,
): ShellSessionContentBlock {
  return {
    type: 'shell_session',
    terminalId: state.terminalId,
    command: state.command,
    workingDirectory: state.workingDirectory,
    status: state.status,
    exitCode: state.exitCode,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    transcript: state.transcript,
    collapsed: state.collapsed,
    displayMode: state.displayMode,
  }
}
