import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/main/atomicWrite'

describe('atomic writes', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('writes through a temporary file and leaves only the target behind', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-atomic-write-'))
    const filePath = path.join(tempDir, 'state', 'settings.json')

    await writeFileAtomic(filePath, '{"ok":true}', 'utf-8')

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{"ok":true}')
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['settings.json'])
  })

  it('serializes concurrent writes to the same file path', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-atomic-write-'))
    const filePath = path.join(tempDir, 'session.json')

    await Promise.all([
      writeFileAtomic(filePath, 'first', 'utf-8'),
      writeFileAtomic(filePath, 'second', 'utf-8'),
    ])

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('second')
  })
})
