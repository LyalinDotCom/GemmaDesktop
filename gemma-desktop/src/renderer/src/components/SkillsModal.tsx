import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import type { InstalledSkillRecord, SkillCatalogEntry } from '@/types'

interface SkillsModalProps {
  open: boolean
  selectedSkillIds: string[]
  installedSkills: InstalledSkillRecord[]
  onClose: () => void
  onToggleSkill: (skillId: string, nextSelected: boolean) => void
  onInstall: (input: {
    repo: string
    skillName: string
  }) => Promise<InstalledSkillRecord[]>
  onRemove: (skillId: string) => Promise<InstalledSkillRecord[]>
}

function formatTokenEstimate(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k tok`
  }
  return `${tokens} tok`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return 'Something went wrong.'
}

export function SkillsModal({
  open,
  selectedSkillIds,
  installedSkills,
  onClose,
  onToggleSkill,
  onInstall,
  onRemove,
}: SkillsModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SkillCatalogEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [hasCompletedSearch, setHasCompletedSearch] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [expandedSkillIds, setExpandedSkillIds] = useState<string[]>([])
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'error'
    message: string
  } | null>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const searchRequestRef = useRef(0)

  const selectedIds = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds])
  const installedSkillBySlug = useMemo(
    () =>
      new Map(
        installedSkills.map((skill) => [skill.slug.toLowerCase(), skill] as const),
      ),
    [installedSkills],
  )
  const isMutating = installingId !== null || removingId !== null
  const activeMutationLabel = installingId
    ? 'Installing skill...'
    : removingId
      ? 'Removing skill...'
      : null

  const runSearch = useCallback(async (rawQuery: string, immediate = false) => {
    const trimmed = rawQuery.trim()
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }

    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId

    if (!trimmed) {
      setResults([])
      setSearching(false)
      setHasCompletedSearch(false)
      setSearchError(null)
      return
    }

    setSearching(true)
    setHasCompletedSearch(false)
    setSearchError(null)
    setResults([])

    const executeSearch = async () => {
      try {
        const nextResults = await window.gemmaDesktopBridge.skills.searchCatalog(trimmed)
        if (requestId !== searchRequestRef.current) {
          return
        }
        setResults(nextResults)
      } catch (error) {
        if (requestId !== searchRequestRef.current) {
          return
        }
        setResults([])
        setSearchError(getErrorMessage(error))
      } finally {
        if (requestId === searchRequestRef.current) {
          setSearching(false)
          setHasCompletedSearch(true)
        }
      }
    }

    if (immediate) {
      await executeSearch()
      return
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      void executeSearch()
    }, 250)
  }, [])

  useEffect(() => {
    if (!open) {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
      searchRequestRef.current += 1
      setQuery('')
      setResults([])
      setSearching(false)
      setHasCompletedSearch(false)
      setSearchError(null)
      setInstallingId(null)
      setRemovingId(null)
      setExpandedSkillIds([])
      setFeedback(null)
      return
    }

    void runSearch(query)
  }, [open, query, runSearch])

  useEffect(
    () => () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!open || isMutating) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, isMutating, onClose])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6 py-8">
      <div className="no-drag flex h-[78vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              <Sparkles size={16} className="text-indigo-500" />
              Skills
            </div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Installed skills are discoverable in this session. Preload one only when you want its full instructions injected immediately.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isMutating}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Close skills"
          >
            <X size={16} />
          </button>
        </div>

        {feedback && (
          <div
            className={`border-b px-5 py-3 text-sm ${
              feedback.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300'
            }`}
          >
            {feedback.message}
          </div>
        )}

        <div className="relative grid min-h-0 flex-1 gap-0 md:grid-cols-[1.2fr_0.9fr]">
          <div className="min-h-0 overflow-y-auto border-r border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                Installed Skills
              </div>
              <div className="text-xs text-zinc-400 dark:text-zinc-500">
                {installedSkills.length} total
              </div>
            </div>

            <div className="space-y-2">
              {installedSkills.map((skill) => {
                const selected = selectedIds.has(skill.id)
                const expanded = expandedSkillIds.includes(skill.id)
                const canRemove =
                  skill.rootLabel === 'Gemma Desktop'

                return (
                  <div
                    key={skill.id}
                    className={`rounded-xl border px-3 py-3 transition-colors ${
                      selected
                        ? 'border-indigo-300 bg-indigo-50/70 dark:border-indigo-800 dark:bg-indigo-950/20'
                        : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/70'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {skill.name}
                          </div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {skill.rootLabel}
                          </div>
                          <div className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {formatTokenEstimate(skill.tokenEstimate)}
                          </div>
                        </div>
                        {expanded && (
                          <div className="mt-3 space-y-2">
                            <div className="text-sm text-zinc-600 dark:text-zinc-300">
                              {skill.description}
                            </div>
                            <div className="rounded-lg bg-white/70 px-2.5 py-2 text-[11px] text-zinc-500 dark:bg-zinc-950/70 dark:text-zinc-400">
                              {skill.directory}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        <button
                          onClick={() => onToggleSkill(skill.id, !selected)}
                          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            selected
                              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                              : 'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900'
                          }`}
                          title={
                            selected
                              ? 'Stop preloading this skill for the current session'
                              : 'Preload this skill into the current session context'
                          }
                        >
                          {selected && <Check size={12} />}
                          {selected ? 'Preloaded' : 'Preload'}
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              setFeedback(null)
                              await window.gemmaDesktopBridge.folders.openPath(skill.directory)
                            } catch (error) {
                              setFeedback({
                                tone: 'error',
                                message: getErrorMessage(error),
                              })
                            }
                          }}
                          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title="Open skill folder"
                        >
                          <FolderOpen size={14} />
                        </button>
                        {canRemove && (
                          <button
                            onClick={async () => {
                              setRemovingId(skill.id)
                              setFeedback(null)
                              try {
                                await onRemove(skill.id)
                                setFeedback({
                                  tone: 'success',
                                  message: `${skill.name} was removed.`,
                                })
                              } catch (error) {
                                setFeedback({
                                  tone: 'error',
                                  message: getErrorMessage(error),
                                })
                              } finally {
                                setRemovingId(null)
                              }
                            }}
                            disabled={removingId === skill.id}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-red-600 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900 dark:hover:text-red-400"
                            title="Delete this installed skill from the machine"
                          >
                            <Trash2 size={12} />
                            Delete
                          </button>
                        )}
                        <button
                          onClick={() =>
                            setExpandedSkillIds((current) =>
                              current.includes(skill.id)
                                ? current.filter((id) => id !== skill.id)
                                : [...current, skill.id],
                            )
                          }
                          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title={expanded ? 'Hide details' : 'Show details'}
                        >
                          <ChevronDown
                            size={14}
                            className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
                          />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}

              {installedSkills.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  No installed skills yet. Search the catalog to add one.
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
              Search skills.sh
            </div>

            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <Search size={15} className="text-zinc-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void runSearch(query, true)
                    }
                  }}
                  placeholder="Search for a skill"
                  className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
              </div>
              <button
                onClick={() => void runSearch(query, true)}
                disabled={query.trim().length === 0 || isMutating}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              >
                {searching && <LoaderCircle size={14} className="animate-spin" />}
                {searching ? 'Searching' : 'Search'}
              </button>
            </div>
            <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              Search runs as you type. Press Enter to search immediately.
            </div>

            <div className="mt-4 space-y-2">
              {searching && (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  <LoaderCircle size={16} className="animate-spin" />
                  Searching skills.sh...
                </div>
              )}

              {results.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {entry.skillName}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {entry.repo}
                        {entry.installsText ? ` • ${entry.installsText}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {entry.url && (
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer"
                          className={`rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${
                            isMutating ? 'pointer-events-none opacity-50' : ''
                          }`}
                          title="Open skills.sh listing"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                      <button
                        onClick={async () => {
                          setInstallingId(entry.id)
                          setFeedback(null)
                          try {
                            const skills = await onInstall({
                              repo: entry.repo,
                              skillName: entry.skillName,
                            })
                            const installedSkill = skills.find(
                              (skill) =>
                                skill.slug.toLowerCase() === entry.skillName.toLowerCase(),
                            )
                            if (installedSkill) {
                              setExpandedSkillIds((current) =>
                                current.includes(installedSkill.id)
                                  ? current
                                  : [...current, installedSkill.id],
                              )
                              setFeedback({
                                tone: 'success',
                                message: `${entry.skillName} is installed and discoverable in this session.`,
                              })
                            } else {
                              setFeedback({
                                tone: 'error',
                                message:
                                  `${entry.skillName} finished installing, but it did not appear in the app yet. ` +
                                  'Refresh the skills list or reopen the modal.',
                              })
                            }
                          } catch (error) {
                            setFeedback({
                              tone: 'error',
                              message: getErrorMessage(error),
                            })
                          } finally {
                            setInstallingId(null)
                          }
                        }}
                        disabled={
                          installingId === entry.id
                          || isMutating
                          || installedSkillBySlug.has(entry.skillName.toLowerCase())
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                      >
                        {installingId === entry.id && (
                          <LoaderCircle size={12} className="animate-spin" />
                        )}
                        {installedSkillBySlug.has(entry.skillName.toLowerCase())
                          ? 'Installed'
                          : installingId === entry.id
                            ? 'Installing'
                            : 'Install'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {!searching && results.length === 0 && query.trim().length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  Search the public skills index, then install a skill directly into this machine.
                </div>
              )}

              {!searching && searchError && (
                <div className="rounded-xl border border-red-200 px-4 py-8 text-center text-sm text-red-700 dark:border-red-900 dark:text-red-300">
                  {searchError}
                </div>
              )}

              {!searching
                && !searchError
                && hasCompletedSearch
                && results.length === 0
                && query.trim().length > 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  No results found for “{query.trim()}”.
                </div>
              )}
            </div>
          </div>

          {activeMutationLabel && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/75 backdrop-blur-sm dark:bg-zinc-950/75">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                <LoaderCircle size={16} className="animate-spin" />
                {activeMutationLabel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
