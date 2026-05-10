import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'

interface SessionFolderSelectorProps {
  workingDirectory: string
  disabled?: boolean
  onSelect?: (workingDirectory: string) => void
}

export function SessionFolderSelector({
  workingDirectory,
  disabled,
  onSelect,
}: SessionFolderSelectorProps) {
  const [picking, setPicking] = useState(false)

  const handlePick = async () => {
    if (disabled || picking) {
      return
    }

    setPicking(true)
    try {
      const selected = await window.gemmaDesktopBridge.folders.pickDirectory(
        workingDirectory,
      )
      if (selected && selected !== workingDirectory) {
        onSelect?.(selected)
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-zinc-500 dark:text-zinc-400">
      <button
        onClick={handlePick}
        disabled={disabled || picking}
        className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        title="Choose project folder"
        aria-label="Choose project folder"
      >
        {picking ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <FolderOpen size={13} />
        )}
      </button>
      <div
        title={workingDirectory || 'No folder selected'}
        className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5 text-zinc-500 dark:text-zinc-400"
      >
        {workingDirectory || 'No folder selected'}
      </div>
    </div>
  )
}
