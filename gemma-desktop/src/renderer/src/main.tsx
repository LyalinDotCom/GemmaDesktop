import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import { App } from './App'
import { MenuBarPopupApp } from './MenuBarPopupApp'
import './index.css'
import { MENU_BAR_POPUP_SURFACE } from '../../shared/menuBarPopup'

const surface = new URLSearchParams(window.location.search).get('surface')
const RootComponent = surface === MENU_BAR_POPUP_SURFACE ? MenuBarPopupApp : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootComponent />
  </StrictMode>,
)
