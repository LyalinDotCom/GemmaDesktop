import { useMemo, type ReactElement } from 'react'
import { Bug, Globe, Sparkles } from 'lucide-react'
import type { SessionToolDefinition, SessionToolIcon } from '@/types'

interface ToolSelectorProps {
  tools: SessionToolDefinition[]
  selectedToolIds: string[]
  disabled?: boolean
  onToggleTool: (toolId: string, nextSelected: boolean) => void | Promise<void>
}

function renderToolIcon(icon: SessionToolIcon, size = 14) {
  switch (icon) {
    case 'bug':
      return <Bug size={size} />
    case 'globe':
      return <Globe size={size} />
    case 'sparkles':
      return <Sparkles size={size} />
  }
}

function SessionToolToggleButton(input: {
  tool: SessionToolDefinition
  selected: boolean
  disabled: boolean
  onToggleTool: (toolId: string, nextSelected: boolean) => void | Promise<void>
}): ReactElement {
  const {
    tool,
    selected,
    disabled,
    onToggleTool,
  } = input

  return (
    <div className="group relative">
      <div
        role="group"
        aria-label={tool.name}
        className={`inline-flex items-center rounded-full border p-0.5 shadow-[0_10px_24px_-20px_rgba(24,24,27,0.8)] backdrop-blur ${
          selected
            ? 'border-cyan-200/80 bg-cyan-50/90 dark:border-cyan-800/70 dark:bg-cyan-950/25'
            : 'border-zinc-200/80 bg-white/90 dark:border-zinc-800 dark:bg-zinc-950/90'
        }`}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void onToggleTool(tool.id, !selected)
          }}
          className={`relative inline-flex items-center justify-center rounded-full p-1.5 transition-colors ${
            selected
              ? 'bg-cyan-600 text-white hover:bg-cyan-700 dark:bg-cyan-500 dark:text-cyan-950 dark:hover:bg-cyan-400'
              : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-zinc-300'
          } disabled:cursor-not-allowed disabled:opacity-50`}
          title={`${selected ? 'Disable' : 'Enable'} ${tool.name}`}
          aria-label={`${selected ? 'Disable' : 'Enable'} ${tool.name}`}
          aria-pressed={selected}
        >
          {renderToolIcon(tool.icon, 16)}
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-[280px] translate-y-1 opacity-0 transition-all duration-150 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <div className="rounded-xl border border-zinc-200 bg-white/95 p-3 shadow-[0_18px_38px_-28px_rgba(24,24,27,0.55)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-[0_20px_44px_-32px_rgba(0,0,0,0.82)]">
          <div className="flex items-start gap-3">
            <div
              className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
                selected
                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {renderToolIcon(tool.icon, 16)}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {tool.name}
              </div>
              <div className="mt-1 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
                {tool.description}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-200 pt-2 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            <span>
              {selected ? 'Enabled for this conversation' : 'Disabled for this conversation'}
            </span>
            <span>{selected ? 'Click to turn off' : 'Click to turn on'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ToolSelector({
  tools,
  selectedToolIds,
  disabled = false,
  onToggleTool,
}: ToolSelectorProps) {
  const selectedIds = useMemo(() => new Set(selectedToolIds), [selectedToolIds])

  if (tools.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-1">
      {tools.map((tool) => (
        <SessionToolToggleButton
          key={tool.id}
          tool={tool}
          selected={selectedIds.has(tool.id)}
          disabled={disabled}
          onToggleTool={onToggleTool}
        />
      ))}
    </div>
  )
}
