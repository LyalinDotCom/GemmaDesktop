import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  Tray,
} from 'electron'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { installMainConsoleFormatting } from './consoleLogging'
import {
  captureAndQueueMacOSScreenshotToActiveSession,
  initializeGemmaDesktop,
  registerIpcHandlers,
} from './ipc'
import { globalChatController } from './globalChat'
import { buildGemmaDesktopMenuBarTemplate } from './menuBar'
import { isTrustedGemmaDesktopNotificationOrigin } from './notifications'
import {
  openLinkTarget,
  shouldOpenNavigationExternally,
} from './links'
import { installNativeTextContextMenu } from './nativeTextContextMenu'
import { broadcastToWindows } from './windowMessaging'
import {
  GLOBAL_CHAT_OPEN_IN_APP_REQUESTED_CHANNEL,
  type GlobalChatOpenInAppRequest,
} from '../shared/globalChat'
import {
  MENU_BAR_POPUP_SURFACE,
  type MenuBarPopupState,
  type MenuBarScreenshotTarget,
} from '../shared/menuBarPopup'

installMainConsoleFormatting()

const isDev = !app.isPackaged
app.setName('Gemma')

function getInitialMainWindowSize(): { width: number; height: number } {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const maxWidth = Math.max(860, Math.min(1480, workAreaSize.width))
  const maxHeight = Math.max(600, Math.min(980, workAreaSize.height))

  return {
    width: Math.min(maxWidth, Math.max(1280, Math.floor(workAreaSize.width * 0.96))),
    height: Math.min(maxHeight, Math.max(860, Math.floor(workAreaSize.height * 0.96))),
  }
}

function listResourceCandidatePaths(...relativePathSegments: string[]): string[] {
  const bundledResourcePath = join(__dirname, '../../resources', ...relativePathSegments)
  const externalResourcePath =
    typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? join(process.resourcesPath, 'resources', ...relativePathSegments)
      : null

  return Array.from(
    new Set(
      [externalResourcePath, bundledResourcePath]
        .filter((value): value is string => Boolean(value && value.trim().length > 0)),
    ),
  )
}

function resolveResourcePath(...relativePathSegments: string[]): string {
  const candidates = listResourceCandidatePaths(...relativePathSegments)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0] ?? join(__dirname, '../../resources', ...relativePathSegments)
}

function loadNativeImageFromResource(...relativePathSegments: string[]): Electron.NativeImage {
  const candidates = listResourceCandidatePaths(...relativePathSegments)

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }

    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) {
      return image
    }
  }

  return nativeImage.createEmpty()
}

let appDockIcon: Electron.NativeImage | null = null

function applyMacOSDockIcon(): void {
  if (process.platform !== 'darwin') {
    return
  }

  appDockIcon = loadNativeImageFromResource('icon.png')
  if (!appDockIcon.isEmpty()) {
    app.dock?.setIcon(appDockIcon)
  }
}

let mainWindow: BrowserWindow | null = null
let menuBarTray: Tray | null = null
let menuBarPopupWindow: BrowserWindow | null = null
let menuBarCaptureBusy = false
let appIsQuitting = false

const MENU_BAR_POPUP_WIDTH = 448
const MENU_BAR_POPUP_HEIGHT = 676

function destroyMenuBarChrome(): void {
  if (menuBarPopupWindow && !menuBarPopupWindow.isDestroyed()) {
    menuBarPopupWindow.destroy()
  }
  menuBarPopupWindow = null

  if (menuBarTray) {
    menuBarTray.destroy()
    menuBarTray = null
  }
}

function getMenuBarPopupState(): MenuBarPopupState {
  return {
    captureBusy: menuBarCaptureBusy,
  }
}

function broadcastMenuBarPopupState(): void {
  const state = getMenuBarPopupState()
  if (menuBarPopupWindow && !menuBarPopupWindow.isDestroyed()) {
    menuBarPopupWindow.webContents.send('menu-bar-popup:state-changed', state)
  }
}

function installApplicationMenu(): void {
  const appName = 'Gemma'
  const template: Electron.MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: appName,
          submenu: [
            { role: 'about', label: `About ${appName}` },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: `Hide ${appName}` },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: `Quit ${appName}` },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
            { role: 'window' },
          ],
        },
      ]
    : [
        {
          label: 'File',
          submenu: [
            { role: 'quit', label: `Quit ${appName}` },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'close' },
          ],
        },
      ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const initialSize = getInitialMainWindowSize()

  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: 860,
    minHeight: 600,
    title: 'Gemma',
    icon: resolveResourcePath(process.platform === 'darwin'
      ? 'icon.icns'
      : 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  installNativeTextContextMenu(mainWindow.webContents)

  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      permission === 'media'
      || (
        permission === 'notifications'
        && (
          isTrustedGemmaDesktopNotificationOrigin(details.requestingUrl)
          || isTrustedGemmaDesktopNotificationOrigin(webContents?.getURL())
          || isTrustedGemmaDesktopNotificationOrigin(requestingOrigin)
        )
      ),
  )
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        permission === 'media'
        || (
          permission === 'notifications'
          && (
            isTrustedGemmaDesktopNotificationOrigin(details.requestingUrl)
            || isTrustedGemmaDesktopNotificationOrigin(webContents.getURL())
          )
        ),
      )
    },
  )

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openLinkTarget(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (!url || url === currentUrl) {
      return
    }

    event.preventDefault()

    if (shouldOpenNavigationExternally(url, currentUrl)) {
      void openLinkTarget(url)
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[gemma-desktop] Renderer process gone:', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error('[gemma-desktop] Renderer failed to load:', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      })
    },
  )

  mainWindow.on('unresponsive', () => {
    console.error('[gemma-desktop] Renderer became unresponsive.')
  })

  mainWindow.on('closed', () => {
    mainWindow = null

    if (!appIsQuitting) {
      app.quit()
    }
  })

  void loadRendererSurface(mainWindow)
}

async function loadRendererSurface(
  targetWindow: BrowserWindow,
  surface?: string,
): Promise<void> {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (surface) {
      rendererUrl.searchParams.set('surface', surface)
    }
    await targetWindow.loadURL(rendererUrl.toString())
    return
  }

  await targetWindow.loadFile(join(__dirname, '../renderer/index.html'), surface
    ? {
        query: {
          surface,
        },
      }
    : undefined)
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  const target = mainWindow

  if (target.isMinimized()) {
    target.restore()
  }

  if (!target.isVisible()) {
    target.show()
  }

  target.focus()
}

function buildMenuBarTrayIcon(): Electron.NativeImage {
  const icon = loadNativeImageFromResource('GemmaDesktopMenuBarTemplate.png')

  if (!icon.isEmpty()) {
    icon.setTemplateImage(true)
    return icon
  }

  const fallbackIcon = loadNativeImageFromResource('icon.png')
    .resize({ height: 18 })

  if (!fallbackIcon.isEmpty()) {
    return fallbackIcon
  }

  return nativeImage.createEmpty()
}

function buildMenuBarContextMenu(): Electron.Menu {
  return Menu.buildFromTemplate(
    buildGemmaDesktopMenuBarTemplate({
      onShowApp: () => {
        focusMainWindow()
      },
    }),
  )
}

async function ensureMenuBarPopupWindow(): Promise<BrowserWindow> {
  if (menuBarPopupWindow && !menuBarPopupWindow.isDestroyed()) {
    return menuBarPopupWindow
  }

  const popupWindow = new BrowserWindow({
    width: MENU_BAR_POPUP_WIDTH,
    height: MENU_BAR_POPUP_HEIGHT,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    backgroundColor: '#00000000',
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    movable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: true,
    },
  })

  popupWindow.on('close', (event) => {
    if (appIsQuitting) {
      return
    }

    event.preventDefault()
    popupWindow.hide()
  })

  popupWindow.on('blur', () => {
    if (appIsQuitting) {
      return
    }

    popupWindow.hide()
  })

  popupWindow.on('closed', () => {
    if (menuBarPopupWindow === popupWindow) {
      menuBarPopupWindow = null
    }
  })
  installNativeTextContextMenu(popupWindow.webContents)

  popupWindow.webContents.setWindowOpenHandler((details) => {
    void openLinkTarget(details.url)
    return { action: 'deny' }
  })

  popupWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = popupWindow.webContents.getURL()
    if (!url || url === currentUrl) {
      return
    }

    event.preventDefault()

    if (shouldOpenNavigationExternally(url, currentUrl)) {
      void openLinkTarget(url)
    }
  })

  menuBarPopupWindow = popupWindow
  await loadRendererSurface(popupWindow, MENU_BAR_POPUP_SURFACE)
  return popupWindow
}

function positionMenuBarPopupWindow(targetWindow: BrowserWindow): void {
  const trayBounds = menuBarTray?.getBounds()
  if (!trayBounds) {
    return
  }

  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + Math.round(trayBounds.width / 2),
    y: trayBounds.y + Math.round(trayBounds.height / 2),
  })
  const workArea = display.workArea
  const desiredX = Math.round(
    trayBounds.x + (trayBounds.width / 2) - (MENU_BAR_POPUP_WIDTH / 2),
  )
  const minX = workArea.x + 8
  const maxX = workArea.x + workArea.width - MENU_BAR_POPUP_WIDTH - 8
  const x = Math.max(minX, Math.min(desiredX, maxX))
  const y = Math.max(
    workArea.y + 8,
    Math.min(
      trayBounds.y + trayBounds.height + 10,
      workArea.y + workArea.height - MENU_BAR_POPUP_HEIGHT - 8,
    ),
  )

  targetWindow.setBounds({
    x,
    y,
    width: MENU_BAR_POPUP_WIDTH,
    height: MENU_BAR_POPUP_HEIGHT,
  })
}

async function showMenuBarPopup(): Promise<void> {
  const popupWindow = await ensureMenuBarPopupWindow()
  positionMenuBarPopupWindow(popupWindow)
  if (!popupWindow.isVisible()) {
    popupWindow.show()
  }
  popupWindow.focus()
  broadcastMenuBarPopupState()
}

function hideMenuBarPopup(): void {
  if (!menuBarPopupWindow || menuBarPopupWindow.isDestroyed()) {
    return
  }

  menuBarPopupWindow.hide()
}

async function toggleMenuBarPopup(): Promise<void> {
  if (menuBarPopupWindow && !menuBarPopupWindow.isDestroyed() && menuBarPopupWindow.isVisible()) {
    hideMenuBarPopup()
    return
  }

  await showMenuBarPopup()
}

async function runMenuBarScreenshotCapture(
  target: MenuBarScreenshotTarget,
): Promise<void> {
  if (menuBarCaptureBusy) {
    return
  }

  menuBarCaptureBusy = true
  hideMenuBarPopup()
  broadcastMenuBarPopupState()

  try {
    await captureAndQueueMacOSScreenshotToActiveSession(target)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Screenshot failed', message)
  } finally {
    menuBarCaptureBusy = false
    broadcastMenuBarPopupState()
  }
}

function installMenuBarTray(): void {
  if (process.platform !== 'darwin') {
    return
  }

  if (menuBarTray) {
    return
  }

  const icon = buildMenuBarTrayIcon()
  menuBarTray = new Tray(icon)
  menuBarTray.setToolTip('Gemma')
  menuBarTray.setTitle('Gemma')
  menuBarTray.setIgnoreDoubleClickEvents(true)
  menuBarTray.on('click', () => {
    void toggleMenuBarPopup()
  })
  menuBarTray.on('right-click', () => {
    hideMenuBarPopup()
    menuBarTray?.popUpContextMenu(buildMenuBarContextMenu())
  })

  ipcMain.handle('menu-bar-popup:get-state', () => getMenuBarPopupState())
  ipcMain.handle('menu-bar-popup:close', () => {
    hideMenuBarPopup()
    return { ok: true as const }
  })
  ipcMain.handle('menu-bar-popup:open-app', () => {
    hideMenuBarPopup()
    focusMainWindow()
    const request: GlobalChatOpenInAppRequest = {
      target: globalChatController.getState().target,
    }
    broadcastToWindows(
      BrowserWindow.getAllWindows(),
      GLOBAL_CHAT_OPEN_IN_APP_REQUESTED_CHANNEL,
      request,
      GLOBAL_CHAT_OPEN_IN_APP_REQUESTED_CHANNEL,
    )
    return { ok: true as const }
  })
  ipcMain.handle(
    'menu-bar-popup:capture-screenshot',
    async (_event, target: MenuBarScreenshotTarget) => {
      await runMenuBarScreenshotCapture(target)
      return { ok: true as const }
    },
  )
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gemma-desktop-file',
    privileges: {
      standard: false,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

void app.whenReady().then(async () => {
  protocol.handle('gemma-desktop-file', (request) => {
    const filePath = decodeURIComponent(
      request.url.replace('gemma-desktop-file://', ''),
    )
    return net.fetch(pathToFileURL(filePath).toString())
  })

  app.setName('Gemma')
  app.setAboutPanelOptions({
    applicationName: 'Gemma Desktop',
  })
  applyMacOSDockIcon()
  installApplicationMenu()
  await initializeGemmaDesktop()
  registerIpcHandlers()
  installMenuBarTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((error) => {
  console.error('Failed to initialize Gemma Desktop:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  appIsQuitting = true
  destroyMenuBarChrome()
})
