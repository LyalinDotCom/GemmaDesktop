export type AppTerminalStatus =
  | 'idle'
  | 'running'
  | 'exited'
  | 'killed'
  | 'error'

export interface AppTerminalState {
  terminalId: string | null
  workingDirectory: string
  status: AppTerminalStatus
  exitCode?: number | null
  startedAt?: number
  completedAt?: number
  transcript: string
}

export function buildIdleAppTerminalState(): AppTerminalState {
  return {
    terminalId: null,
    workingDirectory: '',
    status: 'idle',
    transcript: '',
  }
}
