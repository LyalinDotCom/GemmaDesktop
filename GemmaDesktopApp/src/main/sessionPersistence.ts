import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'

const GEMMA_STORAGE_DIRECTORY_NAME = '.gemma'
const SESSION_STATE_DIRECTORY_NAME = 'session-state'
const RESEARCH_DIRECTORY_NAME = 'research'
const SESSION_FILE_NAME = 'session.json'
const SESSION_ASSET_DIRECTORY_NAME = 'assets'

function normalizeWorkingDirectory(workingDirectory: string): string {
  return path.resolve(workingDirectory)
}

function replaceStringValues(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === 'string') {
    let nextValue = value
    for (const [from, to] of replacements) {
      if (from && nextValue.includes(from)) {
        nextValue = nextValue.split(from).join(to)
      }
    }
    return nextValue
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceStringValues(entry, replacements))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceStringValues(entry, replacements),
      ]),
    )
  }

  return value
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function moveDirectory(
  fromPath: string,
  toPath: string,
): Promise<void> {
  if (fromPath === toPath || !await pathExists(fromPath)) {
    return
  }

  await fs.rm(toPath, { recursive: true, force: true })
  await fs.mkdir(path.dirname(toPath), { recursive: true })

  try {
    await fs.rename(fromPath, toPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') {
      throw error
    }

    await fs.cp(fromPath, toPath, {
      recursive: true,
      force: true,
    })
    await fs.rm(fromPath, { recursive: true, force: true })
  }
}

export function getGemmaStorageDirectory(workingDirectory: string): string {
  return path.join(
    normalizeWorkingDirectory(workingDirectory),
    GEMMA_STORAGE_DIRECTORY_NAME,
  )
}

export function getPersistedSessionsDirectory(workingDirectory: string): string {
  return path.join(
    getGemmaStorageDirectory(workingDirectory),
    SESSION_STATE_DIRECTORY_NAME,
  )
}

export function getPersistedResearchDirectory(workingDirectory: string): string {
  return path.join(
    getGemmaStorageDirectory(workingDirectory),
    RESEARCH_DIRECTORY_NAME,
  )
}

export function getPersistedSessionDirectory(
  workingDirectory: string,
  sessionId: string,
): string {
  return path.join(
    getPersistedSessionsDirectory(workingDirectory),
    sessionId,
  )
}

export function getPersistedSessionFilePath(
  workingDirectory: string,
  sessionId: string,
): string {
  return path.join(
    getPersistedSessionDirectory(workingDirectory, sessionId),
    SESSION_FILE_NAME,
  )
}

export function getPersistedSessionAssetDirectory(
  workingDirectory: string,
  sessionId: string,
): string {
  return path.join(
    getPersistedSessionDirectory(workingDirectory, sessionId),
    SESSION_ASSET_DIRECTORY_NAME,
  )
}

export async function listPersistedSessionFilePaths(
  workingDirectory: string,
): Promise<string[]> {
  const sessionsDirectory = getPersistedSessionsDirectory(workingDirectory)

  let entries
  try {
    entries = await fs.readdir(sessionsDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const sessionFilePaths: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const sessionFilePath = path.join(sessionsDirectory, entry.name, SESSION_FILE_NAME)
    if (await pathExists(sessionFilePath)) {
      sessionFilePaths.push(sessionFilePath)
    }
  }

  return sessionFilePaths.sort()
}

export function rewritePersistedSessionAssetPaths<T>(
  data: T,
  input: {
    fromWorkingDirectory: string
    toWorkingDirectory: string
    sessionId: string
  },
): T {
  const fromAssetDirectory = getPersistedSessionAssetDirectory(
    input.fromWorkingDirectory,
    input.sessionId,
  )
  const toAssetDirectory = getPersistedSessionAssetDirectory(
    input.toWorkingDirectory,
    input.sessionId,
  )

  const replacements: Array<readonly [string, string]> = [
    [fromAssetDirectory, toAssetDirectory],
    [
      pathToFileURL(fromAssetDirectory).toString(),
      pathToFileURL(toAssetDirectory).toString(),
    ],
  ]

  return replaceStringValues(data, replacements) as T
}

export async function relocatePersistedSessionArtifacts<T>(input: {
  data: T
  sessionId: string
  fromWorkingDirectory: string
  toWorkingDirectory: string
}): Promise<T> {
  const fromSessionDirectory = getPersistedSessionDirectory(
    input.fromWorkingDirectory,
    input.sessionId,
  )
  const toSessionDirectory = getPersistedSessionDirectory(
    input.toWorkingDirectory,
    input.sessionId,
  )

  if (fromSessionDirectory !== toSessionDirectory) {
    await moveDirectory(fromSessionDirectory, toSessionDirectory)
  }

  return rewritePersistedSessionAssetPaths(input.data, {
    fromWorkingDirectory: input.fromWorkingDirectory,
    toWorkingDirectory: input.toWorkingDirectory,
    sessionId: input.sessionId,
  })
}

export async function removePersistedSessionArtifacts(input: {
  workingDirectory: string
  sessionId: string
}): Promise<void> {
  await fs.rm(
    getPersistedSessionDirectory(input.workingDirectory, input.sessionId),
    {
      recursive: true,
      force: true,
    },
  )
}
