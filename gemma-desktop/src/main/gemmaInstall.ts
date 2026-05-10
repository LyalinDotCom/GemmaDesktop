import { spawn } from 'child_process'
import type {
  GemmaCatalogEntry,
  GemmaInstallState,
} from '../shared/gemmaCatalog'

export interface EnsureGemmaModelResult {
  ok: boolean
  tag: string
  installed: boolean
  cancelled?: boolean
  error?: string
}

interface GemmaInstallManagerOptions {
  confirmDownload: (entry: GemmaCatalogEntry) => Promise<boolean>
  isModelInstalled: (tag: string) => Promise<boolean>
  onStatesChanged?: (states: GemmaInstallState[]) => void
  pullModel?: (
    tag: string,
    onProgress: (line: string) => void,
  ) => Promise<void>
}

interface RunningGemmaInstall {
  state: GemmaInstallState
  promise: Promise<EnsureGemmaModelResult>
}

function sortStates(states: GemmaInstallState[]): GemmaInstallState[] {
  return [...states].sort((left, right) => left.tag.localeCompare(right.tag))
}

function splitProgressText(buffer: string): {
  lines: string[]
  remainder: string
} {
  const normalized = buffer.replace(/\r/g, '\n')
  const parts = normalized.split('\n')
  const remainder = parts.pop() ?? ''
  return {
    lines: parts.map((line) => line.trim()).filter(Boolean),
    remainder,
  }
}

async function defaultPullModel(
  tag: string,
  onProgress: (line: string) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ollama', ['pull', tag], {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutRemainder = ''
    let stderrRemainder = ''
    let latestLine = ''

    const handleChunk = (
      chunk: string,
      buffer: string,
      setter: (value: string) => void,
    ) => {
      const next = `${buffer}${chunk}`
      const { lines, remainder } = splitProgressText(next)
      setter(remainder)
      for (const line of lines) {
        latestLine = line
        onProgress(line)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      handleChunk(chunk, stdoutRemainder, (value) => {
        stdoutRemainder = value
      })
    })
    child.stderr?.on('data', (chunk: string) => {
      handleChunk(chunk, stderrRemainder, (value) => {
        stderrRemainder = value
      })
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      const trailingOutput = [stdoutRemainder, stderrRemainder]
        .map((line) => line.trim())
        .filter(Boolean)

      if (trailingOutput.length > 0) {
        latestLine = trailingOutput[trailingOutput.length - 1] ?? latestLine
        for (const line of trailingOutput) {
          onProgress(line)
        }
      }

      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          latestLine || `ollama pull ${tag} failed with exit code ${code ?? 'unknown'}.`,
        ),
      )
    })
  })
}

export function createGemmaInstallManager(
  options: GemmaInstallManagerOptions,
) {
  const runningInstalls = new Map<string, RunningGemmaInstall>()
  const latestStates = new Map<string, GemmaInstallState>()

  const emit = () => {
    options.onStatesChanged?.(sortStates([...latestStates.values()]))
  }

  const updateState = (
    tag: string,
    patch: Partial<GemmaInstallState>,
  ): GemmaInstallState => {
    const current = latestStates.get(tag)
    const next: GemmaInstallState = {
      tag,
      status: patch.status ?? current?.status ?? 'running',
      progressText: patch.progressText ?? current?.progressText,
      startedAt: patch.startedAt ?? current?.startedAt ?? Date.now(),
      updatedAt: patch.updatedAt ?? Date.now(),
      finishedAt: patch.finishedAt ?? current?.finishedAt,
      error: patch.error ?? current?.error,
    }
    latestStates.set(tag, next)
    emit()
    return next
  }

  const ensureModel = async (
    entry: GemmaCatalogEntry,
  ): Promise<EnsureGemmaModelResult> => {
    if (await options.isModelInstalled(entry.tag)) {
      latestStates.delete(entry.tag)
      emit()
      return {
        ok: true,
        tag: entry.tag,
        installed: true,
      }
    }

    const running = runningInstalls.get(entry.tag)
    if (running) {
      return await running.promise
    }

    const pullModel = options.pullModel ?? defaultPullModel
    const promise = (async () => {
      const confirmed = await options.confirmDownload(entry)
      if (!confirmed) {
        latestStates.delete(entry.tag)
        emit()
        return {
          ok: false,
          tag: entry.tag,
          installed: false,
          cancelled: true,
        }
      }

      updateState(entry.tag, {
        status: 'running',
        progressText: `Preparing ${entry.label} download…`,
        startedAt: Date.now(),
      })

      try {
        await pullModel(entry.tag, (line) => {
          updateState(entry.tag, {
            status: 'running',
            progressText: line,
          })
        })

        updateState(entry.tag, {
          status: 'completed',
          progressText: `${entry.label} is ready.`,
          finishedAt: Date.now(),
        })

        return {
          ok: true,
          tag: entry.tag,
          installed: true,
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message.trim()
            : `Failed to download ${entry.label}.`

        updateState(entry.tag, {
          status: 'failed',
          progressText: message,
          finishedAt: Date.now(),
          error: message,
        })

        return {
          ok: false,
          tag: entry.tag,
          installed: false,
          error: message,
        }
      } finally {
        runningInstalls.delete(entry.tag)
      }
    })()

    runningInstalls.set(entry.tag, {
      state: latestStates.get(entry.tag) ?? {
        tag: entry.tag,
        status: 'running',
        progressText: `Preparing ${entry.label} download…`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
      promise,
    })

    return await promise
  }

  return {
    ensureModel,
    getStates(): GemmaInstallState[] {
      return sortStates([...latestStates.values()])
    },
  }
}
