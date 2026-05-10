import type { ReactNode } from 'react'
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { RightDockFrame } from '@/components/RightDockFrame'
import { RightDockHeader } from '@/components/RightDockHeader'

interface RightDockShellProps {
  title: string
  description?: string
  meta?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  bodyClassName?: string
  onRefresh?: () => void
  onClose?: () => void
  refreshing?: boolean
  rootPath?: string | null
  scrollBody?: boolean
}

export function RightDockShell({
  title,
  description,
  meta,
  toolbar,
  children,
  bodyClassName = '',
  onRefresh,
  onClose,
  refreshing = false,
  rootPath,
  scrollBody = true,
}: RightDockShellProps) {
  const actions = (
    <>
      {rootPath ? (
        <button
          type="button"
          onClick={() => {
            void window.gemmaDesktopBridge.folders.openPath(rootPath)
          }}
          className="rounded p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
          title="Open folder in Finder"
          aria-label="Open folder in Finder"
        >
          <FolderOpen size={13} />
        </button>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          className="rounded p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
          title="Refresh"
          aria-label="Refresh"
        >
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      ) : null}
    </>
  )

  return (
    <RightDockFrame>
      <RightDockHeader
        title={title}
        description={description}
        meta={meta}
        actions={actions}
        onClose={onClose}
      />
      {toolbar ? <div className="no-drag relative z-[60] px-3 pb-2">{toolbar}</div> : null}

      <div
        className={[
          'min-h-0 flex-1 px-1 pb-2',
          scrollBody ? 'overflow-y-auto scrollbar-thin' : 'flex flex-col overflow-hidden',
          bodyClassName,
        ].filter(Boolean).join(' ')}
      >
        {children}
      </div>
    </RightDockFrame>
  )
}
