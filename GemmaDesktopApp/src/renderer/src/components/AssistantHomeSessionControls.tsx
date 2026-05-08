import { useMemo, useState } from 'react'
import { ChevronDown, MessageCircle, Plus, Search } from 'lucide-react'
import type { GlobalChatConversationSummary } from '@shared/globalChat'

interface AssistantHomeSessionControlsProps {
  sessions: GlobalChatConversationSummary[]
  currentSessionId: string | null
  busy: boolean
  onSelectSession: (sessionId: string) => void
  onStartNewSession: () => void
}

function formatSessionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function searchableText(session: GlobalChatConversationSummary): string {
  return [
    session.title,
    session.lastMessage,
    formatSessionTime(session.updatedAt),
  ].join(' ').toLowerCase()
}

function hasSessionContent(session: GlobalChatConversationSummary): boolean {
  return session.messageCount > 0 || session.lastMessage.trim().length > 0
}

export function listSelectableAssistantHomeSessions(
  sessions: GlobalChatConversationSummary[],
  currentSessionId: string | null,
): GlobalChatConversationSummary[] {
  return sessions
    .filter((session) => session.id !== currentSessionId && hasSessionContent(session))
    .sort((left, right) =>
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt,
    )
}

export function AssistantHomeSessionControls({
  sessions,
  currentSessionId,
  busy,
  onSelectSession,
  onStartNewSession,
}: AssistantHomeSessionControlsProps) {
  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()
  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null
  const selectableSessions = useMemo(
    () => listSelectableAssistantHomeSessions(sessions, currentSessionId),
    [currentSessionId, sessions],
  )
  const sessionPickerDisabled = busy || selectableSessions.length === 0
  const newChatDisabled = busy || !currentSession || !hasSessionContent(currentSession)
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) {
      return selectableSessions
    }

    return selectableSessions.filter((session) =>
      searchableText(session).includes(normalizedQuery),
    )
  }, [normalizedQuery, selectableSessions])

  const handleSelectSession = (sessionId: string) => {
    setPickerOpen(false)
    if (sessionId === currentSessionId) {
      return
    }
    onSelectSession(sessionId)
  }

  return (
    <div className="assistant-home-session-controls no-drag relative z-[140] w-full">
      <div className="flex flex-wrap items-center gap-2 rounded-[22px] border border-white/12 bg-black/28 p-1.5 shadow-[0_22px_70px_-54px_rgba(34,211,238,0.42)] backdrop-blur-xl">
        <div className="relative isolate min-w-[13rem] flex-1">
          <div className={`flex h-9 items-center rounded-[16px] border border-white/10 bg-white/[0.055] px-2.5 text-zinc-200 focus-within:border-cyan-200/35 focus-within:bg-white/[0.08] ${
            sessionPickerDisabled ? 'opacity-45' : ''
          }`}>
            <Search size={14} className="mr-2 shrink-0 text-zinc-400" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPickerOpen(true)
              }}
              onFocus={() => {
                if (!sessionPickerDisabled) {
                  setPickerOpen(true)
                }
              }}
              disabled={sessionPickerDisabled}
              placeholder={selectableSessions.length > 0 ? 'Search chats' : 'No saved chats yet'}
              aria-label="Search Assistant Chat sessions"
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <button
              type="button"
              onClick={() => {
                if (sessionPickerDisabled) {
                  setPickerOpen(false)
                  return
                }
                setPickerOpen((current) => !current)
              }}
              disabled={sessionPickerDisabled}
              aria-expanded={pickerOpen}
              aria-label="Open Assistant Chat session list"
              title={
                selectableSessions.length > 0
                  ? 'Open Assistant Chat session list'
                  : 'No saved Assistant Chat sessions'
              }
              className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed"
            >
              <ChevronDown size={14} />
            </button>
          </div>

          {pickerOpen && !sessionPickerDisabled && (
            <div className="absolute left-0 right-0 top-full z-[160] mt-2 max-h-72 overflow-auto rounded-[18px] border border-cyan-100/20 bg-[#070817] p-1.5 shadow-[0_32px_96px_-42px_rgba(0,0,0,0.98),0_0_0_1px_rgba(255,255,255,0.04)]">
              {filteredSessions.length > 0 ? (
                filteredSessions.map((session) => {
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => handleSelectSession(session.id)}
                      disabled={busy}
                      className="flex w-full items-start gap-2 rounded-[14px] px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-white/[0.07] disabled:cursor-default disabled:opacity-70"
                    >
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-cyan-100">
                        <MessageCircle size={12} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-zinc-100">
                          {session.title || 'Assistant Chat'}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-zinc-400">
                          {session.lastMessage || formatSessionTime(session.updatedAt)}
                        </span>
                      </span>
                    </button>
                  )
                })
              ) : (
                <div className="px-3 py-2 text-sm text-zinc-400">
                  No chats found
                </div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onStartNewSession}
          disabled={newChatDisabled}
          aria-label="Start new Assistant Chat session"
          title={
            newChatDisabled
              ? 'Send a message before starting a new Assistant Chat session'
              : 'Start new Assistant Chat session'
          }
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[16px] border border-emerald-200/25 bg-emerald-300/12 px-3 text-sm font-medium text-emerald-50 shadow-[0_16px_44px_-34px_rgba(52,211,153,0.58)] hover:bg-emerald-300/18 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={15} />
          New chat
        </button>
      </div>
    </div>
  )
}
