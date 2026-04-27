import type { ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  TriangleAlert,
  Volume2,
  X,
} from 'lucide-react'
import type { ReadAloudInspection } from '@shared/readAloud'
import type { BootstrapState } from '@/types'

type TaskStatus = 'in-progress' | 'ready' | 'warning' | 'error'

interface StartupTask {
  id: string
  icon: ReactNode
  title: string
  detail: string
  status: TaskStatus
  error?: string | null
}

interface StartupLoadingOverlayProps {
  bootstrap: BootstrapState
  readAloudEnabled: boolean
  readAloudStatus: ReadAloudInspection | null
  dismissed: boolean
  onDismiss: () => void
  onRetryBootstrap: () => void
}

function resolveBootstrapTask(bootstrap: BootstrapState): StartupTask {
  const status: TaskStatus =
    bootstrap.status === 'error'
      ? 'error'
      : bootstrap.status === 'warning'
        ? 'warning'
      : bootstrap.ready
        ? 'ready'
        : 'in-progress'
  const detail =
    status === 'ready'
      ? `Helper model ${bootstrap.helperModelId} is ready.`
      : bootstrap.message
  return {
    id: 'bootstrap',
    icon: <Cpu size={13} />,
    title: 'Local models',
    detail,
    status,
    error: bootstrap.error,
  }
}

function resolveReadAloudTask(
  readAloud: ReadAloudInspection,
): StartupTask | null {
  if (readAloud.state === 'unsupported') {
    return null
  }
  const status: TaskStatus =
    readAloud.state === 'error'
      ? 'error'
      : readAloud.state === 'ready'
        ? 'ready'
        : 'in-progress'
  const title =
    readAloud.state === 'installing'
      ? 'Read aloud voices'
      : readAloud.state === 'loading'
        ? 'Read aloud engine'
        : 'Read aloud'
  const detail =
    status === 'ready'
      ? `${readAloud.modelLabel} ready.`
      : (readAloud.detail
        ?? 'Preparing Kokoro so read aloud is ready before you need it.')
  return {
    id: 'read-aloud',
    icon: <Volume2 size={13} />,
    title,
    detail,
    status,
    error: readAloud.lastError,
  }
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'in-progress') {
    return <Loader2 size={14} className="animate-spin text-indigo-500" />
  }
  if (status === 'ready') {
    return <CheckCircle2 size={14} className="text-emerald-500" />
  }
  if (status === 'warning') {
    return <TriangleAlert size={14} className="text-amber-500" />
  }
  return <AlertTriangle size={14} className="text-red-500" />
}

export function resolveStartupTasks({
  bootstrap,
  readAloudEnabled,
  readAloudStatus,
}: {
  bootstrap: BootstrapState
  readAloudEnabled: boolean
  readAloudStatus: ReadAloudInspection | null
}): StartupTask[] {
  const tasks: StartupTask[] = [resolveBootstrapTask(bootstrap)]
  if (readAloudEnabled && readAloudStatus) {
    const task = resolveReadAloudTask(readAloudStatus)
    if (task) {
      tasks.push(task)
    }
  }
  return tasks
}

export function shouldShowStartupOverlay(tasks: StartupTask[]): boolean {
  return tasks.some(
    (task) =>
      task.status === 'in-progress'
      || task.status === 'warning'
      || task.status === 'error',
  )
}

export function StartupLoadingOverlay({
  bootstrap,
  readAloudEnabled,
  readAloudStatus,
  dismissed,
  onDismiss,
  onRetryBootstrap,
}: StartupLoadingOverlayProps) {
  const tasks = resolveStartupTasks({
    bootstrap,
    readAloudEnabled,
    readAloudStatus,
  })
  const visible = shouldShowStartupOverlay(tasks) && !dismissed
  if (!visible) {
    return null
  }

  const readyCount = tasks.filter((task) =>
    task.status === 'ready' || task.status === 'warning',
  ).length
  const totalCount = tasks.length
  const progressPercent = totalCount === 0 ? 0 : (readyCount / totalCount) * 100
  const anyError = tasks.some((task) => task.status === 'error')
  const anyWarning = !anyError && tasks.some((task) => task.status === 'warning')

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[150] flex items-center justify-center p-4"
      data-testid="startup-loading-overlay"
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="startup-loading-title"
        aria-describedby="startup-loading-description"
        className="no-drag pointer-events-auto w-full max-w-sm overflow-hidden rounded-xl border border-zinc-200 bg-white/95 shadow-md backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/70">
          <div className="flex min-w-0 items-center gap-2">
            {anyError ? (
              <AlertTriangle size={13} className="text-red-500" />
            ) : anyWarning ? (
              <TriangleAlert size={13} className="text-amber-500" />
            ) : (
              <Loader2 size={13} className="animate-spin text-indigo-500" />
            )}
            <h2
              id="startup-loading-title"
              className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100"
            >
              {anyError
                ? 'Gemma Desktop ran into an issue'
                : anyWarning
                  ? 'Gemma Desktop needs attention'
                  : 'Getting Gemma Desktop ready'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>

        <div
          id="startup-loading-description"
          className="space-y-3 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
            <span data-testid="startup-loading-counter">
              {readyCount} of {totalCount} ready
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/80">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  anyError ? 'bg-red-400' : anyWarning ? 'bg-amber-400' : 'bg-indigo-500'
                }`}
                style={{ width: `${progressPercent}%` }}
                data-testid="startup-loading-progress"
              />
            </div>
          </div>

          <ul className="space-y-1">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-start gap-2.5 rounded-md px-1 py-1.5"
                data-testid={`startup-task-${task.id}`}
                data-task-status={task.status}
              >
                <div className="mt-0.5">
                  <TaskStatusIcon status={task.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                    <span className="text-zinc-400 dark:text-zinc-500">
                      {task.icon}
                    </span>
                    {task.title}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {task.detail}
                  </p>
                  {task.status === 'error'
                    && task.error
                    && task.error !== task.detail && (
                      <p className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400">
                        {task.error}
                      </p>
                    )}
                </div>
              </li>
            ))}
          </ul>

          {bootstrap.status === 'error' && (
            <div className="flex justify-end pt-0.5">
              <button
                type="button"
                onClick={onRetryBootstrap}
                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
