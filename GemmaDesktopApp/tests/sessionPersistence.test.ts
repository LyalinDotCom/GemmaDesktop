import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getPersistedResearchDirectory,
  getPersistedSessionAssetDirectory,
  getPersistedSessionDirectory,
  getPersistedSessionFilePath,
  getPersistedSessionsDirectory,
  listPersistedSessionFilePaths,
  relocatePersistedSessionArtifacts,
  removePersistedSessionArtifacts,
} from '../src/main/sessionPersistence'

describe('session persistence', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('stores session state and research artifacts inside the project .gemma directory', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-session-persistence-'))

    expect(getPersistedSessionsDirectory(tempDir)).toBe(
      path.join(tempDir, '.gemma', 'session-state'),
    )
    expect(getPersistedResearchDirectory(tempDir)).toBe(
      path.join(tempDir, '.gemma', 'research'),
    )
    expect(getPersistedSessionDirectory(tempDir, 'session_123')).toBe(
      path.join(tempDir, '.gemma', 'session-state', 'session_123'),
    )
    expect(getPersistedSessionAssetDirectory(tempDir, 'session_123')).toBe(
      path.join(tempDir, '.gemma', 'session-state', 'session_123', 'assets'),
    )
  })

  it('lists persisted session files from the project session-state directory', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-session-persistence-'))

    const firstSessionFile = getPersistedSessionFilePath(tempDir, 'session_a')
    const secondSessionFile = getPersistedSessionFilePath(tempDir, 'session_b')

    await fs.mkdir(path.dirname(firstSessionFile), { recursive: true })
    await fs.mkdir(path.dirname(secondSessionFile), { recursive: true })
    await fs.writeFile(firstSessionFile, '{}', 'utf-8')
    await fs.writeFile(secondSessionFile, '{}', 'utf-8')

    await expect(listPersistedSessionFilePaths(tempDir)).resolves.toEqual([
      firstSessionFile,
      secondSessionFile,
    ])
  })

  it('removes the whole per-session directory, including transcript and assets', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-session-persistence-'))
    const sessionId = 'session_test-delete'
    const sessionFilePath = getPersistedSessionFilePath(tempDir, sessionId)
    const assetDirectory = getPersistedSessionAssetDirectory(tempDir, sessionId)

    await fs.mkdir(assetDirectory, { recursive: true })
    await fs.writeFile(sessionFilePath, '{"meta":{"id":"session_test-delete"}}', 'utf-8')
    await fs.writeFile(path.join(assetDirectory, 'capture.png'), 'asset', 'utf-8')

    await removePersistedSessionArtifacts({
      workingDirectory: tempDir,
      sessionId,
    })

    await expect(fs.stat(sessionFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(assetDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rewrites stored asset paths when a session moves to a new project folder', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-session-persistence-'))
    const fromWorkingDirectory = path.join(tempDir, 'alpha')
    const toWorkingDirectory = path.join(tempDir, 'beta')
    const sessionId = 'session_test-move'
    const oldAssetDirectory = getPersistedSessionAssetDirectory(
      fromWorkingDirectory,
      sessionId,
    )
    const oldAssetPath = path.join(oldAssetDirectory, 'capture.png')

    await fs.mkdir(oldAssetDirectory, { recursive: true })
    await fs.writeFile(oldAssetPath, 'asset', 'utf-8')

    const relocated = await relocatePersistedSessionArtifacts({
      data: {
        snapshot: {
          workingDirectory: toWorkingDirectory,
        },
        content: [
          oldAssetPath,
          pathToFileURL(oldAssetPath).toString(),
        ],
      },
      sessionId,
      fromWorkingDirectory,
      toWorkingDirectory,
    })

    const newAssetDirectory = getPersistedSessionAssetDirectory(
      toWorkingDirectory,
      sessionId,
    )
    const newAssetPath = path.join(newAssetDirectory, 'capture.png')

    expect(relocated).toEqual({
      snapshot: {
        workingDirectory: toWorkingDirectory,
      },
      content: [
        newAssetPath,
        pathToFileURL(newAssetPath).toString(),
      ],
    })
    await expect(fs.readFile(newAssetPath, 'utf-8')).resolves.toBe('asset')
    await expect(fs.stat(oldAssetDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is safe to run even when session artifacts are already missing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-session-persistence-'))

    await expect(
      removePersistedSessionArtifacts({
        workingDirectory: tempDir,
        sessionId: 'session_missing',
      }),
    ).resolves.toBeUndefined()
  })
})
