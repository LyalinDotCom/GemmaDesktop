export const MENU_BAR_POPUP_SURFACE = 'menu-bar-popup' as const

export type MenuBarPopupSurface = typeof MENU_BAR_POPUP_SURFACE

export type MenuBarScreenshotTarget = 'full_screen' | 'window'

export interface MenuBarPopupState {
  captureBusy: boolean
}
