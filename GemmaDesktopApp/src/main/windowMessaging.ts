interface WebFrameLike {
  isDestroyed(): boolean
}

interface WebContentsLike {
  isDestroyed(): boolean
  isCrashed?(): boolean
  mainFrame?: WebFrameLike | null
  send(channel: string, payload: unknown): void
}

interface WindowLike {
  isDestroyed(): boolean
  webContents: WebContentsLike
}

export function isRendererUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Render frame was disposed before WebFrameMain could be accessed')
    || message.includes('Object has been destroyed')
    || message.includes('WebContents was destroyed')
  )
}

export function sendToWindow(
  win: WindowLike,
  channel: string,
  payload: unknown,
  context: string,
): boolean {
  if (win.isDestroyed()) {
    return false
  }

  const contents = win.webContents
  if (
    contents.isDestroyed()
    || contents.isCrashed?.()
    || contents.mainFrame?.isDestroyed()
  ) {
    return false
  }

  try {
    contents.send(channel, payload)
    return true
  } catch (error) {
    if (!isRendererUnavailableError(error)) {
      console.warn(`[gemma-desktop] Failed to send ${context}:`, error)
    }
    return false
  }
}

export function broadcastToWindows(
  windows: WindowLike[],
  channel: string,
  payload: unknown,
  context: string,
): number {
  let delivered = 0
  for (const win of windows) {
    if (sendToWindow(win, channel, payload, context)) {
      delivered += 1
    }
  }
  return delivered
}
