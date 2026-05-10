import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PendingToolApproval } from '@/types'

interface ToolApprovalCardProps {
  approval: PendingToolApproval
  onResolve: (approved: boolean) => Promise<void>
}

export function ToolApprovalCard({
  approval,
  onResolve,
}: ToolApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false)
  const isShellCommand = approval.toolName === 'Shell command'
  const heading = isShellCommand
    ? 'Shell command requires approval'
    : 'Tool action requires approval'
  const inputLabel = isShellCommand ? 'Command' : 'Tool arguments'

  const handleResolve = async (approved: boolean) => {
    if (submitting) {
      return
    }

    setSubmitting(true)
    try {
      await onResolve(approved)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-zinc-200 bg-sky-50/70 px-6 py-3 dark:border-zinc-800 dark:bg-sky-950/20">
      <div className="flex items-start gap-2">
        <ShieldAlert
          size={15}
          className="mt-0.5 text-sky-600 dark:text-sky-400"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {heading}
          </div>
          <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            {isShellCommand ? (
              <>
                The agent wants to <span className="font-medium">{approval.reason}</span>.
              </>
            ) : (
              <>
                The agent wants to <span className="font-medium">{approval.reason}</span>{' '}
                using <span className="font-mono text-[12px]">{approval.toolName}</span>.
              </>
            )}
          </div>
          <div className="mt-2 rounded-lg border border-zinc-200/80 bg-white/80 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-300">
            <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">
              {inputLabel}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5">
              {approval.argumentsSummary}
            </pre>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            void handleResolve(false)
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            void handleResolve(true)
          }}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Allow
        </button>
      </div>
    </div>
  )
}
