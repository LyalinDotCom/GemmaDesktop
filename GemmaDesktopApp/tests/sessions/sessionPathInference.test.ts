import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { inferConversationWorkingDirectory } from '../../src/main/sessionPathInference'

describe('session path inference', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map(async (target) => {
        await rm(target, { recursive: true, force: true })
      }),
    )
  })

  it('uses an explicit file path from the current message', async () => {
    const defaultDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-default-'))
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-project-'))
    cleanup.push(defaultDirectory, projectDirectory)
    const mainFile = path.join(projectDirectory, 'main.js')
    await writeFile(mainFile, 'console.log("hello")\n', 'utf8')

    const inferred = await inferConversationWorkingDirectory({
      currentWorkingDirectory: defaultDirectory,
      defaultWorkingDirectory: defaultDirectory,
      currentMessageText: `Please update \`${mainFile}\` to change the orbit math.`,
      appMessages: [],
    })

    expect(inferred).toEqual({
      workingDirectory: projectDirectory,
      matchedPath: mainFile,
      source: 'current_message',
    })
  })

  it('falls back to the latest user project path when retrying from the default workspace', async () => {
    const defaultDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-default-'))
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-project-'))
    cleanup.push(defaultDirectory, projectDirectory)

    const inferred = await inferConversationWorkingDirectory({
      currentWorkingDirectory: defaultDirectory,
      defaultWorkingDirectory: defaultDirectory,
      currentMessageText: 'try again',
      appMessages: [
        {
          id: 'older-user',
          role: 'user',
          timestamp: 1_000,
          content: [
            {
              type: 'text',
              text: `Look at this project: ${projectDirectory}`,
            },
          ],
        },
      ],
    })

    expect(inferred).toEqual({
      workingDirectory: projectDirectory,
      matchedPath: projectDirectory,
      source: 'history',
    })
  })

  it('ignores slash phrases like date/time', async () => {
    const defaultDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-default-'))
    cleanup.push(defaultDirectory)

    const inferred = await inferConversationWorkingDirectory({
      currentWorkingDirectory: defaultDirectory,
      defaultWorkingDirectory: defaultDirectory,
      currentMessageText:
        'can the planets load closer to where they really are based on date/time?',
      appMessages: [],
    })

    expect(inferred).toBeNull()
  })

  it('does not resurrect an older project path once the session is already rooted elsewhere', async () => {
    const defaultDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-default-'))
    const currentDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-current-'))
    const olderProjectDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-older-'))
    cleanup.push(defaultDirectory, currentDirectory, olderProjectDirectory)

    const inferred = await inferConversationWorkingDirectory({
      currentWorkingDirectory: currentDirectory,
      defaultWorkingDirectory: defaultDirectory,
      currentMessageText: 'try again',
      appMessages: [
        {
          id: 'older-user',
          role: 'user',
          timestamp: 1_000,
          content: [
            {
              type: 'text',
              text: `Original project path: ${olderProjectDirectory}`,
            },
          ],
        },
      ],
    })

    expect(inferred).toBeNull()
  })

  it('uses the parent directory for a not-yet-created file path when the folder exists', async () => {
    const defaultDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-default-'))
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-app-project-'))
    const nestedDirectory = path.join(projectDirectory, 'src')
    cleanup.push(defaultDirectory, projectDirectory)
    await mkdir(nestedDirectory, { recursive: true })

    const inferred = await inferConversationWorkingDirectory({
      currentWorkingDirectory: defaultDirectory,
      defaultWorkingDirectory: defaultDirectory,
      currentMessageText: `Create ${path.join(nestedDirectory, 'solar-system.ts')} please.`,
      appMessages: [],
    })

    expect(inferred).toEqual({
      workingDirectory: nestedDirectory,
      matchedPath: path.join(nestedDirectory, 'solar-system.ts'),
      source: 'current_message',
    })
  })
})
