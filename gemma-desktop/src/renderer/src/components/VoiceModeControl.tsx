import { useState } from 'react'
import { AudioWaveform, Loader2, Settings2, X } from 'lucide-react'
import type { VoiceModeStatus } from '@/hooks/useVoiceMode'

export interface VoiceModeControlProps {
  status: VoiceModeStatus
  hasApiKey: boolean
  chatPending: boolean
  errorMessage: string | null
  onToggle: () => void
  onDismissError: () => void
  onOpenSettings: () => void
}

const MISSING_KEY_TITLE =
  'Voice mode needs a Gemini API key. Add one in Settings → Gemini Hosted API to enable it.'

function buttonTitle(props: VoiceModeControlProps): string {
  if (!props.hasApiKey) {
    return MISSING_KEY_TITLE
  }
  switch (props.status) {
    case 'connecting':
      return 'Voice mode is connecting…'
    case 'listening':
      return props.chatPending
        ? 'Voice mode is on — the chat model is working. Click to turn off.'
        : 'Voice mode is on and listening. Click to turn off.'
    case 'speaking':
      return 'Voice mode is speaking. Click to turn off.'
    case 'error':
      return props.errorMessage ?? 'Voice mode hit an error.'
    case 'off':
      return 'Start voice mode (Gemini Live)'
  }
}

export function VoiceModeControl(props: VoiceModeControlProps) {
  const [keyPopoverOpen, setKeyPopoverOpen] = useState(false)
  const title = buttonTitle(props)
  const showErrorPopover = props.status === 'error' && Boolean(props.errorMessage)

  const handleClick = () => {
    if (!props.hasApiKey) {
      setKeyPopoverOpen((current) => !current)
      return
    }
    setKeyPopoverOpen(false)
    props.onToggle()
  }

  const icon = props.status === 'connecting'
    ? <Loader2 size={16} className="animate-spin" />
    : (
        <AudioWaveform
          size={16}
          className={
            props.status === 'speaking' || props.chatPending ? 'animate-pulse' : undefined
          }
        />
      )

  const buttonClass = !props.hasApiKey
    ? 'text-zinc-400 opacity-50 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
    : props.status === 'listening'
      ? 'bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25 dark:text-emerald-300'
      : props.status === 'speaking'
        ? 'bg-sky-500/15 text-sky-600 ring-1 ring-sky-400/30 hover:bg-sky-500/25 dark:text-sky-300'
        : props.status === 'connecting'
          ? 'text-amber-500 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/40 dark:hover:text-amber-300'
          : props.status === 'error'
            ? 'text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300'
            : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        className={`rounded-md p-1.5 transition-colors ${buttonClass}`}
        title={title}
        aria-label={title}
      >
        {icon}
      </button>

      {keyPopoverOpen && !props.hasApiKey ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Voice mode
          </p>
          <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {MISSING_KEY_TITLE}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setKeyPopoverOpen(false)
                props.onOpenSettings()
              }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <Settings2 size={12} />
              Open Settings
            </button>
          </div>
        </div>
      ) : null}

      {showErrorPopover ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-red-200 bg-white p-3 shadow-lg dark:border-red-900/60 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              Voice mode error
            </p>
            <button
              type="button"
              onClick={props.onDismissError}
              title="Dismiss voice mode error"
              aria-label="Dismiss voice mode error"
              className="rounded-md p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-zinc-300"
            >
              <X size={14} />
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
            {props.errorMessage}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                props.onDismissError()
                props.onToggle()
              }}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                props.onDismissError()
                props.onOpenSettings()
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
