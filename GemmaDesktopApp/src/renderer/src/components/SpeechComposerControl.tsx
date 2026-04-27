import { useMemo, useState } from 'react'
import { Loader2, Mic, MicOff, Settings2 } from 'lucide-react'
import type { SpeechInspection } from '@shared/speech'

export type SpeechComposerVisualState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'stopping'
  | 'error'

interface SpeechComposerControlProps {
  speech: SpeechInspection | null
  state: SpeechComposerVisualState
  disabled: boolean
  onToggle: () => void
  onInstall: () => void | Promise<unknown>
  onRepair: () => void | Promise<unknown>
  onOpenSettings: () => void
}

function canToggle(speech: SpeechInspection | null): boolean {
  return Boolean(
    speech
    && speech.supported
    && speech.enabled
    && speech.installState === 'installed'
    && speech.healthy,
  )
}

export function SpeechComposerControl({
  speech,
  state,
  disabled,
  onToggle,
  onInstall,
  onRepair,
  onOpenSettings,
}: SpeechComposerControlProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)

  const ready = canToggle(speech)
  const busy = speech?.busy ?? false
  const showInstallAction = speech?.supported && speech.installState !== 'installed' && !busy
  const showRepairAction = Boolean(
    speech
    && speech.supported
    && !busy
    && (speech.installState === 'error' || (speech.installed && !speech.healthy)),
  )
  const buttonTitle = useMemo(() => {
    if (!speech) {
      return 'Checking speech input…'
    }
    if (!speech.supported) {
      return 'Speech input is available on macOS only right now.'
    }
    if (!speech.enabled) {
      return 'Speech input is disabled in Settings.'
    }
    if (!ready) {
      return speech.detail
    }
    if (state === 'listening') {
      return 'Stop speech input'
    }
    if (state === 'stopping') {
      return 'Speech input is cancelling queued audio'
    }
    if (state === 'processing') {
      return 'Speech input is transcribing recent audio'
    }
    return 'Start speech input'
  }, [ready, speech, state])

  const handleClick = () => {
    if (disabled) {
      return
    }
    if (ready) {
      setPopoverOpen(false)
      onToggle()
      return
    }
    setPopoverOpen((current) => !current)
  }

  const icon = state === 'listening'
    ? <Mic size={16} />
    : state === 'processing' || state === 'stopping' || busy
      ? <Loader2 size={16} className="animate-spin" />
      : speech?.supported === false || speech?.enabled === false
        ? <MicOff size={16} />
        : <Mic size={16} />

  const buttonClass = state === 'listening'
    ? 'text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300'
    : state === 'processing' || state === 'stopping'
      ? 'text-amber-500 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/40 dark:hover:text-amber-300'
      : ready
        ? 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
        : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`rounded-md p-1.5 transition-colors disabled:opacity-50 ${buttonClass}`}
        title={buttonTitle}
        aria-label={buttonTitle}
      >
        {icon}
      </button>

      {popoverOpen && !ready && speech ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Speech input
          </p>
          <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {speech.detail}
          </p>
          {speech.lastError ? (
            <p className="mt-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
              {speech.lastError}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {showInstallAction && !showRepairAction ? (
              <button
                type="button"
                onClick={() => {
                  setPopoverOpen(false)
                  void Promise.resolve(onInstall())
                }}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
              >
                Install
              </button>
            ) : null}
            {showRepairAction ? (
              <button
                type="button"
                onClick={() => {
                  setPopoverOpen(false)
                  void Promise.resolve(onRepair())
                }}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
              >
                Repair
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false)
                onOpenSettings()
              }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <Settings2 size={12} />
              Settings
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
