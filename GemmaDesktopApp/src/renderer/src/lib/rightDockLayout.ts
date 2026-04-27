export interface RightDockLayoutClasses {
  splitContainer: string
  mainPane: string
  rightPanel: string
  rightPanelInner: string
  statusBar: string
  statusBarSurface: string
  statusBarMain: string
  statusBarSpacer: string
}

export type ChatContentLayout = 'centered' | 'expanded'

const BASE_SPLIT_CONTAINER_CLASS = 'flex min-h-0 flex-1 overflow-hidden'
const BASE_MAIN_PANE_CLASS = 'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
const BASE_RIGHT_PANEL_CLASS = 'relative flex min-h-0 flex-col'
const BASE_RIGHT_PANEL_INNER_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col'
// statusBar is now a canvas-colored shell that hosts the lifted statusbar
// surface. The shell creates the small left gutter against the sidebar
// and, via gap-2.5, the matching right gutter that floats the surface
// away from any pinned right-dock panel.
const BASE_STATUS_BAR_CLASS = 'statusbar-shell flex shrink-0 gap-2.5'
const BASE_STATUS_BAR_SURFACE_CLASS = 'surface-statusbar flex min-w-0 flex-1'
const BASE_STATUS_BAR_MAIN_CLASS = 'min-w-0 flex-1 py-2'
const BASE_STATUS_BAR_SPACER_CLASS = 'shrink-0 py-2'

const RIGHT_DOCK_PANEL_SHELL_PADDING_CLASS = 'px-4'
const RIGHT_DOCK_PANEL_CONTENT_PADDING_CLASS = 'px-4'
const RIGHT_DOCK_DEFAULT_CONTENT_PADDING_CLASS = 'px-6'
const RIGHT_DOCK_PANEL_RAIL_GUTTER_CLASS = 'pr-6'
const RIGHT_DOCK_RAIL_ONLY_GUTTER_CLASS = 'pr-14'

export function getRightDockLayoutClasses(rightDockVisible: boolean): RightDockLayoutClasses {
  return {
    splitContainer: [
      BASE_SPLIT_CONTAINER_CLASS,
      rightDockVisible
        ? RIGHT_DOCK_PANEL_SHELL_PADDING_CLASS
        : RIGHT_DOCK_RAIL_ONLY_GUTTER_CLASS,
    ].join(' '),
    mainPane: BASE_MAIN_PANE_CLASS,
    rightPanel: [
      BASE_RIGHT_PANEL_CLASS,
      RIGHT_DOCK_PANEL_RAIL_GUTTER_CLASS,
    ].join(' '),
    rightPanelInner: BASE_RIGHT_PANEL_INNER_CLASS,
    statusBar: [
      BASE_STATUS_BAR_CLASS,
      rightDockVisible
        ? RIGHT_DOCK_PANEL_SHELL_PADDING_CLASS
        : RIGHT_DOCK_RAIL_ONLY_GUTTER_CLASS,
    ].join(' '),
    statusBarSurface: BASE_STATUS_BAR_SURFACE_CLASS,
    statusBarMain: [
      BASE_STATUS_BAR_MAIN_CLASS,
      rightDockVisible
        ? RIGHT_DOCK_PANEL_CONTENT_PADDING_CLASS
        : RIGHT_DOCK_DEFAULT_CONTENT_PADDING_CLASS,
    ].join(' '),
    statusBarSpacer: [
      BASE_STATUS_BAR_SPACER_CLASS,
      RIGHT_DOCK_PANEL_RAIL_GUTTER_CLASS,
    ].join(' '),
  }
}
