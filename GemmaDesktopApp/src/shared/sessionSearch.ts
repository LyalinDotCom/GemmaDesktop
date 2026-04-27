export interface SessionSearchRequest {
  query: string
  sessionIds: string[]
}

export interface SessionSearchResult {
  sessionId: string
  title: string
  workingDirectory: string
  conversationKind: 'normal' | 'research'
  updatedAt: number
  snippet: string
}
