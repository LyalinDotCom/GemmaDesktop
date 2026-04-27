import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { broadcastToWindows } from './windowMessaging'

/**
 * Debounced recursive file-system watcher for workspace panels.
 *
 * Each renderer-side subscription gets a unique id. A single underlying
 * fs.watch handle per directory is shared across subscribers to avoid
 * creating many native watchers for the same root. When the last subscriber
 * for a path goes away the watcher is closed.
 *
 * Events are debounced per-path (default 250 ms) so a burst of writes
 * collapses into one refresh signal. The broadcast channel is
 * `workspace:changed` with payload `{ subscriptionId, rootPath }`.
 *
 * Note: fs.watch with { recursive: true } works natively on macOS and
 * Windows. On Linux it silently walks only the top level; since Gemma Desktop
 * targets macOS primarily this is acceptable.
 */

const IGNORED_BASENAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'out',
  'build',
  'coverage',
  '.DS_Store',
])

const DEBOUNCE_MS = 250
const BROADCAST_CHANNEL = 'workspace:changed'
const BROADCAST_CONTEXT = 'workspace:changed'

interface Subscription {
  id: string
  rootPath: string
}

interface WatchEntry {
  rootPath: string
  watcher: fs.FSWatcher
  subscribers: Set<string>
  debounceTimer: NodeJS.Timeout | null
}

const subscriptions = new Map<string, Subscription>()
const watchEntries = new Map<string, WatchEntry>()

function shouldIgnoreEvent(filename: string | null): boolean {
  if (!filename) return false
  // fs.watch with recursive on macOS reports paths relative to the watched
  // root, e.g. "node_modules/foo/bar.js". Skip anything that starts with an
  // ignored segment or has an ignored segment anywhere along the path.
  for (const segment of filename.split(path.sep)) {
    if (IGNORED_BASENAMES.has(segment)) return true
  }
  return false
}

function scheduleBroadcast(entry: WatchEntry): void {
  if (entry.debounceTimer) {
    return
  }

  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    const subscriberIds = Array.from(entry.subscribers)
    if (subscriberIds.length === 0) {
      return
    }

    const windows = BrowserWindow.getAllWindows()
    for (const subscriptionId of subscriberIds) {
      broadcastToWindows(
        windows,
        BROADCAST_CHANNEL,
        { subscriptionId, rootPath: entry.rootPath },
        BROADCAST_CONTEXT,
      )
    }
  }, DEBOUNCE_MS)
}

function openWatchEntry(rootPath: string): WatchEntry | null {
  const absoluteRoot = path.resolve(rootPath)

  try {
    const watcher = fs.watch(
      absoluteRoot,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (shouldIgnoreEvent(filename)) {
          return
        }
        const entry = watchEntries.get(absoluteRoot)
        if (!entry) return
        scheduleBroadcast(entry)
      },
    )

    watcher.on('error', (error) => {
      console.warn(`[gemma-desktop] Workspace watch error for ${absoluteRoot}:`, error)
      closeWatchEntry(absoluteRoot)
    })

    const entry: WatchEntry = {
      rootPath: absoluteRoot,
      watcher,
      subscribers: new Set(),
      debounceTimer: null,
    }
    watchEntries.set(absoluteRoot, entry)
    return entry
  } catch (error) {
    console.warn(`[gemma-desktop] Failed to watch workspace ${absoluteRoot}:`, error)
    return null
  }
}

function closeWatchEntry(rootPath: string): void {
  const entry = watchEntries.get(rootPath)
  if (!entry) return

  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }

  try {
    entry.watcher.close()
  } catch (error) {
    console.warn(`[gemma-desktop] Failed to close watcher for ${rootPath}:`, error)
  }

  watchEntries.delete(rootPath)
}

export function startWorkspaceWatch(rootPath: string): { subscriptionId: string } | null {
  const trimmed = rootPath?.trim()
  if (!trimmed) {
    return null
  }

  const absoluteRoot = path.resolve(trimmed)

  let entry = watchEntries.get(absoluteRoot)
  if (!entry) {
    const opened = openWatchEntry(absoluteRoot)
    if (!opened) return null
    entry = opened
  }

  const subscriptionId = randomUUID()
  entry.subscribers.add(subscriptionId)
  subscriptions.set(subscriptionId, { id: subscriptionId, rootPath: absoluteRoot })

  return { subscriptionId }
}

export function stopWorkspaceWatch(subscriptionId: string): void {
  const subscription = subscriptions.get(subscriptionId)
  if (!subscription) return

  subscriptions.delete(subscriptionId)

  const entry = watchEntries.get(subscription.rootPath)
  if (!entry) return

  entry.subscribers.delete(subscriptionId)
  if (entry.subscribers.size === 0) {
    closeWatchEntry(subscription.rootPath)
  }
}

export function disposeAllWorkspaceWatchers(): void {
  for (const rootPath of Array.from(watchEntries.keys())) {
    closeWatchEntry(rootPath)
  }
  subscriptions.clear()
}
