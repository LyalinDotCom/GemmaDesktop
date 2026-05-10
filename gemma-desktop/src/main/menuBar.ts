export interface GemmaDesktopMenuBarHandlers {
  onShowApp: () => void
}

export function buildGemmaDesktopMenuBarTemplate(
  handlers: GemmaDesktopMenuBarHandlers,
): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Show Gemma',
      click: () => {
        handlers.onShowApp()
      },
    },
    { type: 'separator' },
    { role: 'quit', label: 'Quit Gemma' },
  ]
}
