import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ipcSourcePath = path.join(__dirname, '..', 'src', 'main', 'ipc.ts')

function extractIpcHandler(source: string, channel: string): string {
  const channelIndex = source.indexOf(`'${channel}'`)
  expect(channelIndex).toBeGreaterThanOrEqual(0)
  const start = source.lastIndexOf('ipcMain.handle(', channelIndex)
  expect(start).toBeGreaterThanOrEqual(0)

  const nextHandler = source.indexOf('\n  ipcMain.handle(', start + 1)
  return source.slice(start, nextHandler === -1 ? undefined : nextHandler)
}

describe('startup bootstrap policy', () => {
  it('keeps startup environment inspection read-only so first launch cannot pull models implicitly', () => {
    const source = fs.readFileSync(ipcSourcePath, 'utf8')
    const inspectHandler = extractIpcHandler(source, 'environment:inspect')

    expect(inspectHandler).toContain('bootstrap: bootstrapState')
    expect(inspectHandler).not.toContain('ensureBootstrapReady')
    expect(inspectHandler).not.toContain('pullOllamaModel')
  })

  it('keeps model pulls behind explicit retry or guided download handlers', () => {
    const source = fs.readFileSync(ipcSourcePath, 'utf8')
    const retryHandler = extractIpcHandler(source, 'environment:retry-bootstrap')
    const guidedDownloadHandler = extractIpcHandler(source, 'environment:ensure-gemma-model')

    expect(retryHandler).toContain('ensureBootstrapReady(true)')
    expect(guidedDownloadHandler).toContain('gemmaInstallManager.ensureModel')
    expect(guidedDownloadHandler).not.toContain('ensureBootstrapReady')
  })
})
