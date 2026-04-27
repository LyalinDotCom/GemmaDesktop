import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  TERMINAL_APP_CANDIDATES,
  type TerminalAppInfo,
} from '../shared/terminal'

const execFileAsync = promisify(execFile)

interface InstalledTerminalApp extends TerminalAppInfo {
  appPath: string
}

const MAC_APP_PATHS: Record<string, string[]> = {
  terminal: [
    '/System/Applications/Utilities/Terminal.app',
    '/Applications/Utilities/Terminal.app',
    '/Applications/Terminal.app',
  ],
  iterm: [
    '/Applications/iTerm.app',
    '/Applications/iTerm2.app',
  ],
  ghostty: [
    '/Applications/Ghostty.app',
  ],
  warp: [
    '/Applications/Warp.app',
  ],
  wezterm: [
    '/Applications/WezTerm.app',
  ],
  alacritty: [
    '/Applications/Alacritty.app',
  ],
  kitty: [
    '/Applications/kitty.app',
  ],
  hyper: [
    '/Applications/Hyper.app',
  ],
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function findInstalledMacTerminalApps(): Promise<InstalledTerminalApp[]> {
  const homeApplications = path.join(os.homedir(), 'Applications')
  const installed: InstalledTerminalApp[] = []

  for (const candidate of TERMINAL_APP_CANDIDATES) {
    const candidatePaths = [
      ...(MAC_APP_PATHS[candidate.id] ?? []),
      path.join(homeApplications, `${candidate.label}.app`),
    ]

    for (const appPath of candidatePaths) {
      if (!(await pathExists(appPath))) {
        continue
      }

      installed.push({
        ...candidate,
        appPath,
      })
      break
    }
  }

  return installed
}

export async function listInstalledTerminalApps(): Promise<TerminalAppInfo[]> {
  if (process.platform !== 'darwin') {
    return []
  }

  return await findInstalledMacTerminalApps()
}

async function openDirectoryInMacTerminalApp(
  app: InstalledTerminalApp,
  directoryPath: string,
): Promise<void> {
  const normalizedDirectory = path.resolve(directoryPath)

  if (app.id === 'terminal') {
    await execFileAsync('/usr/bin/open', ['-a', app.appPath, normalizedDirectory])
    return
  }

  if (app.id === 'iterm') {
    const escapedDirectory = normalizedDirectory.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      `tell application "${app.label}" to activate`,
      '-e',
      `tell application "${app.label}" to create window with default profile`,
      '-e',
      `tell application "${app.label}" to tell current session of current window to write text "cd \\"${escapedDirectory}\\""`,
    ])
    return
  }

  await execFileAsync('/usr/bin/open', ['-a', app.appPath, normalizedDirectory])
}

export async function openDirectoryInTerminal(input: {
  directoryPath: string
  terminalId?: string
}): Promise<{ ok: true; terminal: TerminalAppInfo }> {
  if (process.platform !== 'darwin') {
    throw new Error('Open in terminal is currently supported on macOS only.')
  }

  const directoryPath = path.resolve(input.directoryPath)
  await fs.access(directoryPath)

  const installedApps = await findInstalledMacTerminalApps()
  const targetApp = input.terminalId
    ? installedApps.find((app) => app.id === input.terminalId)
    : installedApps[0]

  if (!targetApp) {
    throw new Error('No supported terminal app was detected on this Mac.')
  }

  await openDirectoryInMacTerminalApp(targetApp, directoryPath)
  return {
    ok: true,
    terminal: {
      id: targetApp.id,
      label: targetApp.label,
      bundleId: targetApp.bundleId,
    },
  }
}
