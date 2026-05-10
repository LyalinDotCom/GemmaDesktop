export interface TerminalAppInfo {
  id: string
  label: string
  bundleId: string
}

export const TERMINAL_APP_CANDIDATES: readonly TerminalAppInfo[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    bundleId: 'com.apple.Terminal',
  },
  {
    id: 'iterm',
    label: 'iTerm',
    bundleId: 'com.googlecode.iterm2',
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    bundleId: 'com.mitchellh.ghostty',
  },
  {
    id: 'warp',
    label: 'Warp',
    bundleId: 'dev.warp.Warp-Stable',
  },
  {
    id: 'wezterm',
    label: 'WezTerm',
    bundleId: 'com.github.wez.wezterm',
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    bundleId: 'org.alacritty',
  },
  {
    id: 'kitty',
    label: 'kitty',
    bundleId: 'net.kovidgoyal.kitty',
  },
  {
    id: 'hyper',
    label: 'Hyper',
    bundleId: 'co.zeit.hyper',
  },
] as const
