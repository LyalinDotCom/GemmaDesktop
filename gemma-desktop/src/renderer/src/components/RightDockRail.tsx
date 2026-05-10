import { Fragment } from 'react'
import {
  Brain,
  Clock3,
  Files,
  GitBranch,
  Globe,
  SquareTerminal,
  Telescope,
} from 'lucide-react'

export type RightDockView =
  | 'research'
  | 'automations'
  | 'git'
  | 'files'
  | 'browser'
  | 'memory'
  | 'assistant'
  | 'debug'

interface RightDockRailProps {
  activeView: RightDockView | null
  terminalActive?: boolean
  terminalBusy?: boolean
  browserAvailable?: boolean
  badges?: Partial<Record<RightDockView, number>>
  disabledViews?: Partial<Record<RightDockView, boolean>>
  onSelect: (view: RightDockView) => void
  onToggleTerminal?: () => void
}

interface RailItem {
  id: RightDockView
  label: string
  activeBg: string
  activeBorder: string
  icon: typeof Telescope
}

const ITEM_GROUPS: RailItem[][] = [
  [
    {
      id: 'research',
      label: 'Research',
      activeBg: 'bg-rose-500 dark:bg-rose-500',
      activeBorder: 'border-rose-600 dark:border-rose-400',
      icon: Telescope,
    },
    {
      id: 'automations',
      label: 'Automations',
      activeBg: 'bg-amber-500 dark:bg-amber-500',
      activeBorder: 'border-amber-600 dark:border-amber-400',
      icon: Clock3,
    },
  ],
  [
    {
      id: 'git',
      label: 'Git',
      activeBg: 'bg-emerald-500 dark:bg-emerald-500',
      activeBorder: 'border-emerald-600 dark:border-emerald-400',
      icon: GitBranch,
    },
    {
      id: 'files',
      label: 'Files',
      activeBg: 'bg-amber-500 dark:bg-amber-500',
      activeBorder: 'border-amber-600 dark:border-amber-400',
      icon: Files,
    },
    {
      id: 'browser',
      label: 'Browser',
      activeBg: 'bg-sky-500 dark:bg-sky-500',
      activeBorder: 'border-sky-600 dark:border-sky-400',
      icon: Globe,
    },
  ],
  [
    {
      id: 'memory',
      label: 'Memory',
      activeBg: 'bg-indigo-500 dark:bg-indigo-500',
      activeBorder: 'border-indigo-600 dark:border-indigo-400',
      icon: Brain,
    },
  ],
]

export function RightDockRail({
  activeView,
  terminalActive = false,
  terminalBusy = false,
  browserAvailable = false,
  badges = {},
  disabledViews = {},
  onSelect,
  onToggleTerminal,
}: RightDockRailProps) {
  const renderItem = (item: RailItem) => {
    const Icon = item.icon
    const active = activeView === item.id
    const disabled = disabledViews[item.id] === true
    const badgeCount = Math.max(0, badges[item.id] ?? 0)
    const badgeLabel = badgeCount > 99 ? '99+' : String(badgeCount)

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onSelect(item.id)}
        title={
          disabled && item.id === 'git' ? 'Git (not a repository)' : item.label
        }
        aria-label={item.label}
        aria-pressed={active}
        disabled={disabled}
        className={`relative flex h-[33px] w-[33px] items-center justify-center rounded-full border transition-all duration-150 ${
          active
            ? `${item.activeBg} ${item.activeBorder} text-white shadow-sm`
            : disabled
              ? 'cursor-not-allowed border-slate-200 bg-white text-slate-300 opacity-60 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-700'
              : 'border-slate-200 bg-white text-slate-500 shadow-sm hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-100'
        }`}
      >
        {badgeCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -left-2 top-1/2 inline-flex h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded-full border border-white bg-rose-500 px-1 text-[9px] font-semibold leading-none text-white shadow-sm dark:border-slate-950"
          >
            {badgeLabel}
          </span>
        ) : null}
        <Icon size={14} />
      </button>
    )
  }

  return (
    <div className="no-drag">
      <div className="flex flex-col items-center gap-2">
        {ITEM_GROUPS.map((group, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <div className="my-0.5 h-px w-5 bg-slate-200 dark:bg-slate-700" />
            ) : null}
            {group
              .filter((item) => item.id !== 'browser' || browserAvailable)
              .map(renderItem)}
            {index === ITEM_GROUPS.length - 1 && onToggleTerminal ? (
              <button
                type="button"
                onClick={onToggleTerminal}
                title="Terminal"
                aria-label="Terminal"
                aria-pressed={terminalActive}
                className={`relative flex h-[33px] w-[33px] items-center justify-center rounded-full border transition-all duration-150 ${
                  terminalActive
                    ? 'border-amber-600 bg-amber-500 text-white shadow-sm dark:border-amber-400 dark:bg-amber-500'
                    : 'border-slate-200 bg-white text-slate-500 shadow-sm hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-100'
                }`}
              >
                <SquareTerminal size={14} />
                {terminalBusy ? (
                  <span
                    aria-hidden="true"
                    className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-[1.5px] ${
                      terminalActive
                        ? 'border-amber-500 bg-white dark:border-amber-400 dark:bg-slate-900'
                        : 'animate-pulse border-white bg-emerald-500 dark:border-slate-900'
                    }`}
                  />
                ) : null}
              </button>
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
