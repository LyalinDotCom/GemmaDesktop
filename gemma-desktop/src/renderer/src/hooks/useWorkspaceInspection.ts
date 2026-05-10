import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceInspection } from '@/types'

export function useWorkspaceInspection(
  workingDirectory: string | null,
  enabled = true,
) {
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const refreshTimer = useRef<number | null>(null)

  const refresh = useCallback(() => {
    setRefreshToken((current) => current + 1)
  }, [])

  // Debounced auto-refresh on filesystem changes so a burst of writes doesn't
  // trigger a storm of inspection requests.
  const scheduleAutoRefresh = useCallback(() => {
    if (refreshTimer.current !== null) {
      return
    }
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      setRefreshToken((current) => current + 1)
    }, 150)
  }, [])

  // Fetch + refetch the inspection snapshot.
  useEffect(() => {
    if (!enabled) {
      return
    }

    const normalizedDirectory = workingDirectory?.trim() ?? ''
    if (normalizedDirectory.length === 0) {
      setInspection(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    void window.gemmaDesktopBridge.workspace.inspect(normalizedDirectory)
      .then((nextInspection) => {
        if (cancelled) {
          return
        }
        setInspection(nextInspection)
        setError(null)
      })
      .catch((nextError) => {
        if (cancelled) {
          return
        }
        setError(nextError instanceof Error ? nextError.message : 'Workspace inspection failed.')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [enabled, refreshToken, workingDirectory])

  // Subscribe to real-time filesystem changes for the workspace root.
  // Triggers a debounced refetch whenever files are added/modified/deleted.
  useEffect(() => {
    if (!enabled) return

    const normalizedDirectory = workingDirectory?.trim() ?? ''
    if (normalizedDirectory.length === 0) return

    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void window.gemmaDesktopBridge.workspace
      .subscribe(normalizedDirectory, () => {
        if (cancelled) return
        scheduleAutoRefresh()
      })
      .then((next) => {
        if (cancelled) {
          next()
          return
        }
        unsubscribe = next
      })
      .catch((subscribeError) => {
        console.warn('[gemma-desktop] Workspace watch subscription failed:', subscribeError)
      })

    return () => {
      cancelled = true
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [enabled, workingDirectory, scheduleAutoRefresh])

  return {
    inspection,
    loading,
    error,
    refresh,
  }
}
