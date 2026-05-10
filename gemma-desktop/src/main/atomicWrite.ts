import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

const pendingFileWrites = new Map<string, Promise<void>>()

type WriteFileData = string | NodeJS.ArrayBufferView
type WriteFileEncoding = BufferEncoding | null | undefined

async function writeFileAtomicUnqueued(
  filePath: string,
  data: WriteFileData,
  encoding?: WriteFileEncoding,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`

  try {
    await fs.writeFile(tempFilePath, data, encoding)
    await fs.rename(tempFilePath, filePath)
  } catch (error) {
    try {
      await fs.unlink(tempFilePath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[gemma-desktop] Failed to remove temporary file ${tempFilePath}:`,
          cleanupError,
        )
      }
    }
    throw error
  }
}

export async function writeFileAtomic(
  filePath: string,
  data: WriteFileData,
  encoding?: WriteFileEncoding,
): Promise<void> {
  const resolvedPath = path.resolve(filePath)
  const previousWrite = pendingFileWrites.get(resolvedPath) ?? Promise.resolve()
  const nextWrite = previousWrite.then(
    () => writeFileAtomicUnqueued(resolvedPath, data, encoding),
    () => writeFileAtomicUnqueued(resolvedPath, data, encoding),
  )
  const trackedWrite = nextWrite.finally(() => {
    if (pendingFileWrites.get(resolvedPath) === trackedWrite) {
      pendingFileWrites.delete(resolvedPath)
    }
  })

  pendingFileWrites.set(resolvedPath, trackedWrite)
  await trackedWrite
}
