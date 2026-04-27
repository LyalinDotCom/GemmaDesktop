import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { SessionTag } from '@/types'
import {
  MAX_SESSION_TAG_EMOJI_LENGTH,
  MAX_SESSION_TAG_NAME_LENGTH,
} from '@shared/sessionTags'

const DEFAULT_EMOJI = '⭐'

const DEFAULT_EMOJI_CHOICES: readonly string[] = [
  DEFAULT_EMOJI,
  '🔥',
  '💡',
  '📝',
  '🐛',
  '✅',
  '❓',
  '⚠️',
  '🚀',
  '📌',
  '🎯',
  '🔖',
  '📅',
  '💬',
  '🧠',
  '🔧',
  '🧪',
  '📦',
  '🔒',
  '💸',
  '🎨',
  '🏁',
  '🌱',
  '🧹',
  '♻️',
  '📣',
  '🕒',
  '🩹',
  '🛠️',
  '🗂️',
  '🧭',
  '✨',
]

const SUGGEST_DEBOUNCE_MS = 650
const SUGGEST_MIN_NAME_CHARS = 3

interface SessionTagPickerProps {
  existingTags: readonly SessionTag[]
  anchorX: number
  anchorY: number
  onClose: () => void
  onSave: (tag: SessionTag) => void
}

function clampEmoji(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  return Array.from(trimmed).slice(0, MAX_SESSION_TAG_EMOJI_LENGTH).join('')
}

function clampName(value: string): string {
  if (value.length <= MAX_SESSION_TAG_NAME_LENGTH) {
    return value
  }
  return value.slice(0, MAX_SESSION_TAG_NAME_LENGTH)
}

function buildTagId(): string {
  const randomSegment = Math.random().toString(36).slice(2, 10)
  const timeSegment = Date.now().toString(36)
  return `tag-${timeSegment}-${randomSegment}`
}

type SuggestionStatus = 'idle' | 'waiting' | 'loading' | 'ready' | 'empty'

export function SessionTagPicker({
  existingTags,
  anchorX,
  anchorY,
  onClose,
  onSave,
}: SessionTagPickerProps) {
  const existingEmojis = useMemo(
    () => new Set(existingTags.map((tag) => tag.emoji)),
    [existingTags],
  )
  const initialEmoji = useMemo(() => {
    const firstFree = DEFAULT_EMOJI_CHOICES.find(
      (choice) => !existingEmojis.has(choice),
    )
    return firstFree ?? DEFAULT_EMOJI
  }, [existingEmojis])
  const [emoji, setEmoji] = useState(initialEmoji)
  const [name, setName] = useState('')
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [suggestionStatus, setSuggestionStatus] = useState<SuggestionStatus>('idle')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const suggestTimeoutRef = useRef<number | null>(null)
  const suggestRequestRef = useRef(0)

  const emojiIsDuplicate = existingEmojis.has(emoji)

  useEffect(() => {
    window.setTimeout(() => {
      nameInputRef.current?.focus()
    }, 20)
  }, [])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  useEffect(() => {
    const trimmed = name.trim()
    if (suggestTimeoutRef.current !== null) {
      window.clearTimeout(suggestTimeoutRef.current)
      suggestTimeoutRef.current = null
    }

    if (trimmed.length < SUGGEST_MIN_NAME_CHARS) {
      suggestRequestRef.current += 1
      setSuggestion(null)
      setSuggestionStatus('idle')
      return
    }

    setSuggestionStatus('waiting')
    setSuggestion(null)
    const requestId = suggestRequestRef.current + 1
    suggestRequestRef.current = requestId

    suggestTimeoutRef.current = window.setTimeout(() => {
      setSuggestionStatus('loading')
      const excludeEmojis = Array.from(existingEmojis)
      window.gemmaDesktopBridge.sessions
        .suggestTagEmoji(trimmed, excludeEmojis)
        .then((result) => {
          if (requestId !== suggestRequestRef.current) {
            return
          }
          const candidate = clampEmoji(result.emoji ?? '')
          if (!candidate || existingEmojis.has(candidate)) {
            setSuggestion(null)
            setSuggestionStatus('empty')
            return
          }
          setSuggestion(candidate)
          setSuggestionStatus('ready')
        })
        .catch(() => {
          if (requestId !== suggestRequestRef.current) {
            return
          }
          setSuggestion(null)
          setSuggestionStatus('empty')
        })
    }, SUGGEST_DEBOUNCE_MS)

    return () => {
      if (suggestTimeoutRef.current !== null) {
        window.clearTimeout(suggestTimeoutRef.current)
        suggestTimeoutRef.current = null
      }
    }
  }, [name, existingEmojis])

  useEffect(
    () => () => {
      suggestRequestRef.current += 1
      if (suggestTimeoutRef.current !== null) {
        window.clearTimeout(suggestTimeoutRef.current)
      }
    },
    [],
  )

  const handleSave = () => {
    const resolvedEmojiRaw = clampEmoji(emoji) || DEFAULT_EMOJI
    if (existingEmojis.has(resolvedEmojiRaw)) {
      return
    }
    const trimmedName = name.trim()
    const nextTag: SessionTag = {
      id: buildTagId(),
      emoji: resolvedEmojiRaw,
      name: clampName(trimmedName.length > 0 ? trimmedName : resolvedEmojiRaw),
    }
    onSave(nextTag)
  }

  const acceptSuggestion = () => {
    if (!suggestion || existingEmojis.has(suggestion)) {
      return
    }
    setEmoji(suggestion)
  }

  const pickerWidth = 260
  const pickerHeight = 320
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const left = Math.max(8, Math.min(anchorX, viewportWidth - pickerWidth - 8))
  const top = Math.max(8, Math.min(anchorY, viewportHeight - pickerHeight - 8))

  const saveDisabled = emojiIsDuplicate

  return (
    <div
      ref={pickerRef}
      className="fixed z-[60] w-[260px] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      style={{ left, top }}
      role="dialog"
      aria-label="Add tag to conversation"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
        Add tag
      </div>

      <div className="mb-2 grid grid-cols-8 gap-1">
        {DEFAULT_EMOJI_CHOICES.map((choice) => {
          const isSelected = emoji === choice
          const alreadyUsed = existingEmojis.has(choice)
          return (
            <button
              key={choice}
              type="button"
              onClick={() => {
                if (!alreadyUsed) {
                  setEmoji(choice)
                }
              }}
              disabled={alreadyUsed}
              title={
                alreadyUsed
                  ? `${choice} is already on this conversation`
                  : choice
              }
              aria-pressed={isSelected}
              aria-disabled={alreadyUsed}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors ${
                isSelected
                  ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-300 dark:bg-sky-500/20 dark:text-sky-300 dark:ring-sky-500/40'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              } ${alreadyUsed ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              {choice}
            </button>
          )
        })}
      </div>

      <div className="mb-2">
        <label
          htmlFor="session-tag-emoji"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400"
        >
          Emoji
        </label>
        <input
          id="session-tag-emoji"
          type="text"
          value={emoji}
          onChange={(event) => setEmoji(clampEmoji(event.target.value))}
          className={`w-full rounded-md border bg-white px-2 py-1 text-sm outline-none dark:bg-zinc-950 ${
            emojiIsDuplicate
              ? 'border-red-300 text-red-700 focus:border-red-400 dark:border-red-500/40 dark:text-red-300 dark:focus:border-red-400'
              : 'border-zinc-200 text-zinc-900 focus:border-zinc-400 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500'
          }`}
          aria-label="Emoji for this tag"
          aria-invalid={emojiIsDuplicate}
        />
        {emojiIsDuplicate && (
          <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {emoji} is already on this conversation.
          </div>
        )}
      </div>

      <div className="mb-1">
        <label
          htmlFor="session-tag-name"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400"
        >
          Name
        </label>
        <input
          id="session-tag-name"
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(event) => setName(clampName(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (!saveDisabled) {
                handleSave()
              }
            }
          }}
          placeholder="Tag name"
          maxLength={MAX_SESSION_TAG_NAME_LENGTH}
          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
          aria-label="Tag name"
        />
      </div>

      <div className="mb-3 min-h-[22px] text-[11px] text-zinc-500 dark:text-zinc-400">
        {suggestionStatus === 'waiting' && (
          <span className="inline-flex items-center gap-1.5">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60 dark:bg-sky-300/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-300" />
            </span>
            <span>Thinking of an emoji...</span>
          </span>
        )}
        {suggestionStatus === 'loading' && (
          <span className="inline-flex items-center gap-1.5">
            <Loader2
              size={11}
              className="animate-spin text-sky-500 dark:text-sky-300"
            />
            <span>Asking helper model...</span>
          </span>
        )}
        {suggestionStatus === 'ready' && suggestion && (
          <button
            type="button"
            onClick={acceptSuggestion}
            className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[12px] text-sky-800 shadow-sm transition-colors hover:border-sky-300 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:border-sky-400/50 dark:hover:bg-sky-500/20"
            title={`Use ${suggestion} as the emoji`}
          >
            <Sparkles size={11} />
            <span className="leading-none">Suggested:</span>
            <span className="text-[14px] leading-none">{suggestion}</span>
          </button>
        )}
        {suggestionStatus === 'empty' && (
          <span className="italic text-zinc-400 dark:text-zinc-500">
            No suggestion. Pick one above.
          </span>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          title={
            saveDisabled
              ? 'Pick an emoji not already in use'
              : 'Save this tag'
          }
          className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
        >
          Save
        </button>
      </div>
    </div>
  )
}
