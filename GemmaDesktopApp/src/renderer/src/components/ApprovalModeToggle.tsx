import { ShieldCheck, Zap } from 'lucide-react'
import {
  normalizeConversationApprovalMode,
  type ConversationApprovalMode,
} from '@gemma-desktop/sdk-core/approvalMode'

interface ApprovalModeToggleProps {
  mode?: ConversationApprovalMode
  disabled?: boolean
  onChange?: (mode: ConversationApprovalMode) => void
}

export function ApprovalModeToggle({
  mode,
  disabled = false,
  onChange,
}: ApprovalModeToggleProps) {
  const normalizedMode = normalizeConversationApprovalMode(mode)
  const yolo = normalizedMode === 'yolo'
  const nextMode: ConversationApprovalMode = yolo ? 'require_approval' : 'yolo'
  const title = yolo
    ? 'YOLO approval mode: commands that normally ask for approval run immediately. Click to require approval.'
    : 'Require approval mode: risky commands ask before running. Click to switch to YOLO.'
  const Icon = yolo ? Zap : ShieldCheck

  return (
    <button
      type="button"
      disabled={disabled || !onChange}
      onClick={() => onChange?.(nextMode)}
      aria-pressed={yolo}
      aria-label={yolo ? 'Switch to require approval mode' : 'Switch to YOLO approval mode'}
      title={title}
      className={`no-drag inline-flex h-[26px] min-w-[58px] items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-semibold uppercase tracking-[0.12em] shadow-[0_10px_24px_-22px_rgba(24,24,27,0.7)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        yolo
          ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800/80 dark:bg-amber-950/35 dark:text-amber-200 dark:hover:bg-amber-950/60'
          : 'border-zinc-200/80 bg-white/90 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950/90 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
      }`}
    >
      <Icon size={12} />
      <span>{yolo ? 'YOLO' : 'Ask'}</span>
    </button>
  )
}
