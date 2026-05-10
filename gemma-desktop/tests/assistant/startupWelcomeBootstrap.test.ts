import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ipcSourcePath = path.resolve(process.cwd(), 'src/main/ipc.ts')

describe('startup welcome bootstrap guard', () => {
  it('does not start a hidden Assistant Chat welcome while model bootstrap is still running', () => {
    const ipcSource = fs.readFileSync(ipcSourcePath, 'utf8')
    const startupWelcome = ipcSource.match(
      /async function maybeStartStartupWelcomeInternal[\s\S]*?\n}\n\nasync function broadcastGlobalChatChanged/,
    )?.[0]

    expect(startupWelcome).toBeDefined()
    expect(startupWelcome).toContain('if (!bootstrapState.ready)')
    expect(startupWelcome).toContain("reason: 'bootstrap_not_ready'")
    expect(startupWelcome?.indexOf('if (!bootstrapState.ready)')).toBeLessThan(
      startupWelcome?.indexOf('await sendTalkMessageInternal') ?? 0,
    )
  })
})
