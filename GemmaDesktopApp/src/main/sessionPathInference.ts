import fs from 'fs/promises'
import path from 'path'

export interface PathInferenceMessage {
  id?: string
  role: string
  content: Array<Record<string, unknown>>
  timestamp: number
}

export interface InferredWorkingDirectory {
  workingDirectory: string
  matchedPath: string
  source: 'current_message' | 'history'
}

const ABSOLUTE_PATH_PATTERN
  = /(?:^|[\s([{'"`])((?:\/(?:[^/\s'"`(){}<>]+))+)/g

function collectTextContent(content: Array<Record<string, unknown>>): string {
  return content
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .filter((text) => text.length > 0)
    .join('\n')
}

function extractAbsolutePathCandidates(text: string): string[] {
  const matches: string[] = []

  for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
    const candidate = match[1]?.trim()
    if (!candidate || candidate.startsWith('//')) {
      continue
    }

    matches.push(candidate)
  }

  return [...new Set(matches)].sort((left, right) => right.length - left.length)
}

async function statIfExists(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(targetPath)
  } catch {
    return null
  }
}

async function resolveWorkspaceTarget(
  candidatePath: string,
): Promise<{ workingDirectory: string; matchedPath: string } | null> {
  const normalized = path.resolve(candidatePath)
  const directStat = await statIfExists(normalized)
  if (directStat?.isDirectory()) {
    return {
      workingDirectory: normalized,
      matchedPath: normalized,
    }
  }
  if (directStat?.isFile()) {
    return {
      workingDirectory: path.dirname(normalized),
      matchedPath: normalized,
    }
  }

  // If the user referenced a not-yet-created file under an existing folder,
  // use the containing folder as the best available workspace root.
  if (path.extname(normalized).length > 0) {
    const parentDirectory = path.dirname(normalized)
    const parentStat = await statIfExists(parentDirectory)
    if (parentStat?.isDirectory()) {
      return {
        workingDirectory: parentDirectory,
        matchedPath: normalized,
      }
    }
  }

  return null
}

async function inferFromText(
  text: string,
): Promise<{ workingDirectory: string; matchedPath: string } | null> {
  const candidates = extractAbsolutePathCandidates(text)
  for (const candidate of candidates) {
    const resolved = await resolveWorkspaceTarget(candidate)
    if (resolved) {
      return resolved
    }
  }

  return null
}

export async function inferConversationWorkingDirectory(input: {
  currentWorkingDirectory: string
  defaultWorkingDirectory: string
  currentMessageText: string
  appMessages: PathInferenceMessage[]
}): Promise<InferredWorkingDirectory | null> {
  const currentWorkingDirectory = path.resolve(input.currentWorkingDirectory)
  const defaultWorkingDirectory = path.resolve(input.defaultWorkingDirectory)

  const currentMessageMatch = await inferFromText(input.currentMessageText)
  if (
    currentMessageMatch
    && path.resolve(currentMessageMatch.workingDirectory) !== currentWorkingDirectory
  ) {
    return {
      ...currentMessageMatch,
      source: 'current_message',
    }
  }

  if (currentWorkingDirectory !== defaultWorkingDirectory) {
    return null
  }

  const priorUserMessages = [...input.appMessages]
    .filter((message) => message.role === 'user')
    .sort((left, right) => right.timestamp - left.timestamp)

  for (const message of priorUserMessages) {
    const priorMatch = await inferFromText(collectTextContent(message.content))
    if (
      priorMatch
      && path.resolve(priorMatch.workingDirectory) !== currentWorkingDirectory
    ) {
      return {
        ...priorMatch,
        source: 'history',
      }
    }
  }

  return null
}
