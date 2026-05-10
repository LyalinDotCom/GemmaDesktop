import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, MousePointer2, RefreshCw, X } from 'lucide-react'
import { RightDockShell } from '@/components/RightDockShell'
import type { ProjectBrowserPanelBounds, ProjectBrowserState } from '@/types'

interface ProjectBrowserPanelProps {
  state: ProjectBrowserState
  onClose: () => void
  coBrowseActive?: boolean
  resumeError?: string | null
  controlBusy?: boolean
  takeControlDisabledReason?: string | null
  onTakeControl?: () => Promise<void> | void
  onReleaseControl?: () => void
  surfaceVisible?: boolean
}

type ProjectBrowserPanelMeasurable = {
  getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
}

export function measureProjectBrowserPanelBounds(
  element: ProjectBrowserPanelMeasurable,
  surfaceVisible = true,
): ProjectBrowserPanelBounds | null {
  if (!surfaceVisible) {
    return null
  }

  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function buildErrorTooltip(state: ProjectBrowserState): string {
  if (state.consoleErrorCount === 0) {
    return 'No console or page errors captured.'
  }

  const lines = (state.recentConsoleErrors ?? []).filter((entry) => entry.trim().length > 0)
  if (lines.length === 0 && state.lastError) {
    lines.push(state.lastError)
  }

  const hiddenCount = Math.max(0, state.consoleErrorCount - lines.length)
  return [
    `${state.consoleErrorCount} error${state.consoleErrorCount === 1 ? '' : 's'}`,
    ...lines,
    hiddenCount > 0 ? `+${hiddenCount} more` : '',
  ].filter(Boolean).join('\n')
}

function formatNavigationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const browserControlClass = [
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent',
  'text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900',
  'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent',
  'dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
].join(' ')

export function ProjectBrowserPanel({
  state,
  onClose,
  coBrowseActive = false,
  resumeError = null,
  controlBusy = false,
  takeControlDisabledReason = null,
  onTakeControl,
  onReleaseControl,
  surfaceVisible = true,
}: ProjectBrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const surfaceVisibleRef = useRef(surfaceVisible)
  const [draftUrl, setDraftUrl] = useState(state.url ?? '')
  const [urlFocused, setUrlFocused] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const userHasControl = coBrowseActive && state.controlOwner === 'user'
  const browserReadOnly = coBrowseActive && !userHasControl

  useEffect(() => {
    if (!urlFocused) {
      setDraftUrl(state.url ?? '')
    }
  }, [state.url, urlFocused])

  const runBrowserCommand = async (command: () => Promise<ProjectBrowserState>) => {
    setNavigationError(null)
    try {
      await command()
    } catch (error) {
      setNavigationError(formatNavigationError(error))
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const targetUrl = draftUrl.trim()
    if (!targetUrl) {
      return
    }

    if (browserReadOnly) {
      if (takeControlDisabledReason) {
        setNavigationError(takeControlDisabledReason)
        return
      }
      if (!onTakeControl) {
        return
      }
      const confirmed = window.confirm(
        `The agent currently controls this browser. Take control and navigate to ${targetUrl}?`,
      )
      if (!confirmed) {
        return
      }
      try {
        await onTakeControl()
      } catch {
        return
      }
    }

    void runBrowserCommand(() =>
      window.gemmaDesktopBridge.browser.navigate(targetUrl, {
        sessionId: state.sessionId,
        coBrowseActive,
      }),
    )
  }

  const handleReloadOrStop = () => {
    if (browserReadOnly) {
      return
    }
    void runBrowserCommand(() =>
      state.loading
        ? window.gemmaDesktopBridge.browser.stopLoading()
        : window.gemmaDesktopBridge.browser.reload(),
    )
  }
  const controlLabel = userHasControl ? 'Release control' : 'Take over'
  const controlTitle = userHasControl
    ? 'Release browser control back to the agent for your next request.'
    : takeControlDisabledReason ?? 'Take over browser control for a human-only action.'
  const controlDisabled = controlBusy
    || (userHasControl ? !onReleaseControl : !onTakeControl || Boolean(takeControlDisabledReason))
  const controlSummary = userHasControl
    ? 'User has browser control'
    : 'Agent owns browser control'
  const controlDetail = userHasControl
    ? (state.controlReason ?? 'Finish the browser-side action, then release control.')
    : takeControlDisabledReason ?? 'The page is read-only for you until you take over or the agent asks for help.'

  useEffect(() => {
    if (surfaceVisibleRef.current === surfaceVisible) {
      return
    }

    surfaceVisibleRef.current = surfaceVisible
    const element = viewportRef.current
    if (!element) {
      return
    }

    void window.gemmaDesktopBridge.browser.setPanelBounds(
      measureProjectBrowserPanelBounds(element, surfaceVisible),
    ).catch((error) => {
      console.error('Failed to update project browser visibility:', error)
    })
  }, [surfaceVisible])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) {
      return
    }

    const pushBounds = () => {
      void window.gemmaDesktopBridge.browser.setPanelBounds(
        measureProjectBrowserPanelBounds(element, surfaceVisibleRef.current),
      ).catch((error) => {
        console.error('Failed to update project browser bounds:', error)
      })
    }

    pushBounds()

    const resizeObserver = new ResizeObserver(() => {
      pushBounds()
    })
    resizeObserver.observe(element)
    window.addEventListener('resize', pushBounds)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', pushBounds)
      void window.gemmaDesktopBridge.browser.setPanelBounds(null).catch((error) => {
        console.error('Failed to clear project browser bounds:', error)
      })
    }
  }, [])

  const headerTitle = state.title?.trim() || (coBrowseActive ? 'CoBrowse' : 'Browser')
  const errorChip = (
    <div
      className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
      title={buildErrorTooltip(state)}
    >
      {state.consoleErrorCount} error{state.consoleErrorCount === 1 ? '' : 's'}
    </div>
  )

  return (
    <RightDockShell
      title={headerTitle}
      scrollBody={false}
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="rounded-xl border border-zinc-200/80 bg-white/90 px-2.5 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70">
          <form
            className={`flex items-center gap-1.5 rounded-lg border bg-zinc-50/90 px-1.5 py-1.5 shadow-inner transition-colors dark:bg-zinc-900/90 ${
              navigationError
                ? 'border-rose-300 dark:border-rose-800'
                : 'border-zinc-200 dark:border-zinc-800'
            }`}
            onSubmit={handleSubmit}
          >
            <button
              type="button"
              aria-label="Back"
              title={browserReadOnly ? 'Take over to use browser controls.' : 'Back'}
              className={browserControlClass}
              disabled={browserReadOnly || !state.canGoBack}
              onClick={() => {
                void runBrowserCommand(() => window.gemmaDesktopBridge.browser.goBack())
              }}
            >
              <ArrowLeft aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              aria-label="Forward"
              title={browserReadOnly ? 'Take over to use browser controls.' : 'Forward'}
              className={browserControlClass}
              disabled={browserReadOnly || !state.canGoForward}
              onClick={() => {
                void runBrowserCommand(() => window.gemmaDesktopBridge.browser.goForward())
              }}
            >
              <ArrowRight aria-hidden="true" size={14} />
            </button>
            <input
              aria-label="Project Browser URL"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400 dark:text-zinc-200 dark:placeholder:text-zinc-600"
              placeholder="Address"
              spellCheck={false}
              title={
                browserReadOnly
                  ? 'Press Enter to take control and navigate to this URL.'
                  : navigationError ?? state.lastError ?? state.url ?? undefined
              }
              value={draftUrl}
              onBlur={() => setUrlFocused(false)}
              onChange={(event) => {
                setDraftUrl(event.currentTarget.value)
                if (navigationError) {
                  setNavigationError(null)
                }
              }}
              onFocus={() => setUrlFocused(true)}
            />
            <button
              type="button"
              aria-label={state.loading ? 'Stop loading' : 'Reload'}
              title={
                browserReadOnly
                  ? 'Take over to use browser controls.'
                  : state.loading ? 'Stop loading' : 'Reload'
              }
              className={browserControlClass}
              disabled={browserReadOnly || (!state.loading && !state.url)}
              onClick={handleReloadOrStop}
            >
              {state.loading ? (
                <X aria-hidden="true" size={14} />
              ) : (
                <RefreshCw aria-hidden="true" size={13} />
              )}
            </button>
          </form>
          {navigationError ? (
            <p className="mt-1 px-1 text-[11px] text-rose-500 dark:text-rose-400">
              {navigationError}
            </p>
          ) : null}
        </div>

        <div
          ref={viewportRef}
          className="relative min-h-[280px] flex-1 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)] dark:border-zinc-800 dark:bg-white"
        >
          {!state.mounted && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-zinc-400">
              No page loaded.
            </div>
          )}
          {state.mounted && !state.url && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-zinc-400">
              No page loaded.
            </div>
          )}
        </div>

        {coBrowseActive ? (
          <div className={`rounded-xl border px-2.5 py-1.5 shadow-sm ${
            userHasControl
              ? 'border-amber-200/80 bg-amber-50/80 dark:border-amber-400/25 dark:bg-amber-400/10'
              : 'border-sky-200/70 bg-sky-50/80 dark:border-sky-500/20 dark:bg-sky-500/10'
          }`}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className={`text-[11px] font-medium ${
                  userHasControl
                    ? 'text-amber-950 dark:text-amber-100'
                    : 'text-sky-900 dark:text-sky-100'
                }`}>
                  <span className="mr-1.5 align-baseline text-[10px] font-semibold uppercase tracking-wide opacity-70">
                    {userHasControl ? 'user control' : 'agent control'}
                  </span>
                  {controlSummary}
                </p>
                <p className={`mt-0.5 truncate text-[10px] ${
                  userHasControl
                    ? 'text-amber-800/75 dark:text-amber-100/70'
                    : 'text-sky-700/75 dark:text-sky-200/70'
                }`}>
                  {controlDetail}
                </p>
              </div>
              {errorChip}
              <button
                type="button"
                aria-label={controlLabel}
                title={controlTitle}
                disabled={controlDisabled}
                onClick={userHasControl ? onReleaseControl : onTakeControl}
                className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-white px-2.5 text-[11px] font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-white dark:bg-zinc-950/60 ${
                  userHasControl
                    ? 'border-amber-300/80 text-amber-800 hover:bg-amber-100 dark:border-amber-300/30 dark:text-amber-100 dark:hover:bg-amber-300/15'
                    : 'border-sky-300/70 text-sky-700 hover:bg-sky-100 dark:border-sky-300/30 dark:text-sky-100 dark:hover:bg-sky-300/15'
                }`}
              >
                <MousePointer2 size={12} />
                <span>{controlLabel}</span>
              </button>
            </div>
            {resumeError ? (
              <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-300">
                {resumeError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-end px-1">
            {errorChip}
          </div>
        )}
      </div>
    </RightDockShell>
  )
}
