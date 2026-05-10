export interface ShellSpawnTarget {
  file: string
  args: string[]
}

export function normalizeTerminalDimension(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value == null) {
    return fallback
  }

  return Math.max(20, Math.floor(value))
}

export function buildShellEnvironment(): Record<string, string | undefined> {
  return {
    ...process.env,
    TERM: process.env['TERM'] || 'xterm-256color',
    COLORTERM: process.env['COLORTERM'] || 'truecolor',
  }
}

export function buildCommandShellSpawnTarget(command: string): ShellSpawnTarget {
  if (process.platform === 'win32') {
    return {
      file: process.env['ComSpec'] || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    }
  }

  return {
    file: process.env['SHELL'] || '/bin/zsh',
    args: ['-lc', command],
  }
}

export function buildInteractiveShellSpawnTarget(): ShellSpawnTarget {
  if (process.platform === 'win32') {
    return {
      file: process.env['ComSpec'] || 'cmd.exe',
      args: [],
    }
  }

  return {
    file: process.env['SHELL'] || '/bin/zsh',
    args: ['-l'],
  }
}
