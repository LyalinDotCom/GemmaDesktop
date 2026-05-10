export async function copyText(text: string): Promise<void> {
  if (window.gemmaDesktopBridge?.clipboard?.writeText) {
    await window.gemmaDesktopBridge.clipboard.writeText(text)
    return
  }

  await navigator.clipboard.writeText(text)
}
