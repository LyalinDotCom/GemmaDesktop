export const START_BACKGROUND_PROCESS_TOOL = 'start_background_process'
export const PEEK_BACKGROUND_PROCESS_TOOL = 'peek_background_process'
export const TERMINATE_BACKGROUND_PROCESS_TOOL = 'terminate_background_process'

export interface RunningBackgroundProcessSummary {
  terminalId: string
  command: string
  workingDirectory: string
  startedAt: number
  previewText: string
}

export const BACKGROUND_PROCESS_TOOL_NAMES = [
  START_BACKGROUND_PROCESS_TOOL,
  PEEK_BACKGROUND_PROCESS_TOOL,
  TERMINATE_BACKGROUND_PROCESS_TOOL,
] as const

export type BackgroundProcessToolName =
  (typeof BACKGROUND_PROCESS_TOOL_NAMES)[number]
