import { Cpu, Server } from 'lucide-react'
import type { RuntimeSummary, ModelSummary } from '@/types'

interface WelcomeScreenProps {
  runtimes: RuntimeSummary[]
  models: ModelSummary[]
  hasSession: boolean
}

const runtimeStatusColor = {
  running: 'text-emerald-500',
  stopped: 'text-zinc-400',
  not_installed: 'text-zinc-400',
}

const runtimeStatusLabel = {
  running: 'Running',
  stopped: 'Stopped',
  not_installed: 'Not detected',
}

export function WelcomeScreen({
  runtimes,
  models,
  hasSession,
}: WelcomeScreenProps) {
  const loadedModels = models.filter((m) => m.status === 'loaded')
  const runningRuntimes = runtimes.filter((r) => r.status === 'running')

  return (
    <div className="flex flex-1 items-center justify-center pt-14">
      <div className="w-full max-w-lg px-6">
        {/* Header */}
        <div className="mb-8 text-center">
          <h2 className="text-xl font-semibold text-zinc-800 dark:text-zinc-200">
            {hasSession ? 'Start a conversation' : 'Welcome to Gemma Desktop'}
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            {hasSession
              ? 'Type a message below or try one of these suggestions.'
              : 'Your local AI workspace. Here\u2019s what\u2019s available on your machine.'}
          </p>
        </div>

        {/* Environment cards */}
        {!hasSession && (
          <div className="mb-8 grid grid-cols-2 gap-3">
            {/* Runtimes card */}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center gap-2">
                <Server size={16} className="text-zinc-500" />
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Runtimes
                </span>
              </div>
              <div className="space-y-2">
                {runtimes.map((rt) => (
                  <div key={rt.id} className="flex items-center justify-between">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      {rt.name}
                    </span>
                    <span
                      className={`text-xs ${runtimeStatusColor[rt.status]}`}
                    >
                      {runtimeStatusLabel[rt.status]}
                      {rt.version && ` v${rt.version}`}
                    </span>
                  </div>
                ))}
                {runtimes.length === 0 && (
                  <p className="text-xs text-zinc-400">
                    No runtimes detected.
                  </p>
                )}
              </div>
            </div>

            {/* Models card */}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center gap-2">
                <Cpu size={16} className="text-zinc-500" />
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Models
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    Available
                  </span>
                  <span className="text-xs text-zinc-500">
                    {models.length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    Loaded
                  </span>
                  <span className="text-xs text-emerald-500">
                    {loadedModels.length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    Runtimes active
                  </span>
                  <span className="text-xs text-emerald-500">
                    {runningRuntimes.length}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
