import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Monitor, ScanSearch } from 'lucide-react'
import { TalkPanel } from '@/components/TalkPanel'
import { ToolApprovalCard } from '@/components/ToolApprovalCard'
import { useGlobalChatSession } from '@/hooks/useGlobalChatSession'
import type { MenuBarPopupState, MenuBarScreenshotTarget } from '../../shared/menuBarPopup'

const INITIAL_POPUP_STATE: MenuBarPopupState = {
  captureBusy: false,
}

export function MenuBarPopupApp() {
  const globalChat = useGlobalChatSession()
  const [popupState, setPopupState] = useState<MenuBarPopupState>(INITIAL_POPUP_STATE)

  const handleClose = useCallback(async () => {
    await window.gemmaDesktopBridge.menuBarPopup.close()
  }, [])

  const handleOpenApp = useCallback(async () => {
    await window.gemmaDesktopBridge.menuBarPopup.openApp()
  }, [])

  useEffect(() => {
    let cancelled = false

    void window.gemmaDesktopBridge.menuBarPopup.getState().then((state) => {
      if (!cancelled) {
        setPopupState(state)
      }
    })

    const unsubscribe = window.gemmaDesktopBridge.menuBarPopup.onStateChanged((state) => {
      setPopupState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      void handleClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  const handleCapture = useCallback(async (target: MenuBarScreenshotTarget) => {
    await window.gemmaDesktopBridge.menuBarPopup.close()
    await window.gemmaDesktopBridge.menuBarPopup.captureScreenshot(target)
  }, [])

  const iconButtonClass = 'flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
  return (
    <div className="surface-canvas flex h-screen min-h-0 flex-col text-slate-900 dark:text-slate-100">
      <div className="drag-region flex items-center justify-end gap-0.5 px-1.5 py-1">
        <div className="no-drag flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              void handleCapture('full_screen')
            }}
            disabled={popupState.captureBusy}
            className={iconButtonClass}
            title="Capture full screen"
            aria-label="Capture full screen"
          >
            <Monitor size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCapture('window')
            }}
            disabled={popupState.captureBusy}
            className={iconButtonClass}
            title="Capture window"
            aria-label="Capture window"
          >
            <ScanSearch size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleOpenApp()
            }}
            className={iconButtonClass}
            title="Open the full Gemma Desktop app"
            aria-label="Open the full Gemma Desktop app"
          >
            <ArrowUpRight size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <TalkPanel
          variant="tray"
          title={globalChat.title}
          targetKind={globalChat.targetKind}
          sessionId={globalChat.sessionId}
          messages={globalChat.messages}
          draftText={globalChat.draftText}
          streamingContent={globalChat.streamingContent}
          isGenerating={globalChat.isGenerating}
          isCompacting={globalChat.isCompacting}
          pendingCompaction={globalChat.pendingCompaction}
          pendingToolApproval={globalChat.pendingToolApproval}
          liveActivity={globalChat.liveActivity}
          loading={globalChat.loading}
          error={globalChat.error}
          enterToSend={true}
          onRetry={globalChat.retry}
          onSend={globalChat.sendMessage}
          onCancel={globalChat.cancelGeneration}
          onCompact={globalChat.compactSession}
          onSaveDraft={globalChat.saveDraft}
          onClearSession={globalChat.clearSession}
        />
        {globalChat.pendingToolApproval && (
          <ToolApprovalCard
            approval={globalChat.pendingToolApproval}
            onResolve={async (approved) => {
              await globalChat.resolveToolApproval(
                globalChat.pendingToolApproval!.id,
                approved,
              )
            }}
          />
        )}
      </div>
    </div>
  )
}
