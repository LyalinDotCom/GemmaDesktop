export const OPEN_PROJECT_BROWSER_TOOL = 'open_project_browser'
export const SEARCH_PROJECT_BROWSER_DOM_TOOL = 'search_project_browser_dom'
export const GET_PROJECT_BROWSER_ERRORS_TOOL = 'get_project_browser_errors'
export const RELEASE_PROJECT_BROWSER_TO_USER_TOOL = 'release_project_browser_to_user'

export const PROJECT_BROWSER_TOOL_NAMES = [
  OPEN_PROJECT_BROWSER_TOOL,
  SEARCH_PROJECT_BROWSER_DOM_TOOL,
  GET_PROJECT_BROWSER_ERRORS_TOOL,
] as const

export type ProjectBrowserToolName = (typeof PROJECT_BROWSER_TOOL_NAMES)[number]
export type ProjectBrowserControlOwner = 'agent' | 'user'

export interface ProjectBrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ProjectBrowserConsoleEntry {
  id: string
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  sourceId?: string
  lineNumber?: number
  timestamp: number
}

export interface ProjectBrowserState {
  open: boolean
  sessionId: string | null
  coBrowseActive: boolean
  controlOwner: ProjectBrowserControlOwner
  controlReason: string | null
  mounted: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  url: string | null
  title: string
  consoleErrorCount: number
  recentConsoleErrors?: string[]
  lastError: string | null
  lastUpdatedAt: number
}
