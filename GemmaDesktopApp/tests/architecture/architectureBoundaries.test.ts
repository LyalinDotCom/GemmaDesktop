import fs from 'fs/promises'
import path from 'path'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(__dirname, '../..')

async function readAppSource(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(appRoot, 'src', relativePath), 'utf-8')
}

describe('architecture boundaries', () => {
  it('keeps smart content and PDF derivation out of the IPC registration layer', async () => {
    const [ipcSource, smartContentSource] = await Promise.all([
      readAppSource('main/ipc.ts'),
      readAppSource('main/smartContent.ts'),
    ])

    expect(ipcSource).toContain("from './smartContent'")
    expect(smartContentSource).toContain('extractPdfText')
    expect(smartContentSource).toContain('renderPdfPages')
    expect(smartContentSource).toContain('createWorkspaceSearchBackend')

    expect(ipcSource).not.toContain('extractPdfText')
    expect(ipcSource).not.toContain('renderPdfPages')
    expect(ipcSource).not.toContain('createWorkspaceSearchBackend')
    expect(ipcSource).not.toContain('PDF_RENDER_SCALE')
  })
})
