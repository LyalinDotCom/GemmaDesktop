import { execFile } from 'child_process'
import {
  normalizeConversationApprovalMode,
  type ConversationApprovalMode,
} from '@gemma-desktop/sdk-core'
import { ASK_GEMINI_DEFAULT_MODEL } from '../shared/geminiModels'

export { ASK_GEMINI_DEFAULT_MODEL } from '../shared/geminiModels'

export const ASK_GEMINI_TOOL_NAME = 'ask_gemini'
export const ASK_GEMINI_EXECUTABLE = 'gemini'
export const ASK_GEMINI_TIMEOUT_MS = 45_000
const GEMINI_EXECUTABLE_RESOLUTION_TIMEOUT_MS = 5_000
const GEMINI_MAX_BUFFER_BYTES = 1024 * 1024 * 8

export type GeminiCliErrorKind =
  | 'missing_binary'
  | 'timeout'
  | 'auth_missing'
  | 'capacity_exhausted'
  | 'invalid_json'
  | 'empty_response'
  | 'cli_error'

export interface AskGeminiCliInput {
  question: string
  context?: string
  model?: string
  workingDirectory: string
  approvalMode?: ConversationApprovalMode
}

export interface AskGeminiCliSuccess {
  ok: true
  model: string
  question: string
  prompt: string
  response: string
  durationMs: number
  sessionId?: string
  stats?: Record<string, unknown>
  warnings?: string[]
  stdout?: string
  stderr?: string
}

export interface AskGeminiCliFailure {
  ok: false
  model: string
  question: string
  prompt: string
  error: string
  errorKind: GeminiCliErrorKind
  retryable: boolean
  durationMs: number
  exitCode?: number | string
  stdout?: string
  stderr?: string
  details?: string
}

export type AskGeminiCliResult = AskGeminiCliSuccess | AskGeminiCliFailure

type ExecFileError = Error & {
  code?: number | string | null
  signal?: NodeJS.Signals | string | null
  killed?: boolean
  stdout?: string
  stderr?: string
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: {
    cwd?: string
    timeout?: number
    maxBuffer?: number
  },
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => void

interface GeminiJsonOutput {
  session_id?: unknown
  response?: unknown
  stats?: unknown
  error?: unknown
}

export async function askGeminiCli(
  input: AskGeminiCliInput,
  deps: {
    execFile?: ExecFileLike
    now?: () => number
  } = {},
): Promise<AskGeminiCliResult> {
  const execFileImpl = deps.execFile ?? execFile
  const now = deps.now ?? (() => Date.now())
  const question = input.question.trim()
  const model = input.model?.trim() || ASK_GEMINI_DEFAULT_MODEL
  const prompt = buildGeminiPrompt({
    question,
    context: input.context,
  })
  const approvalMode = normalizeConversationApprovalMode(input.approvalMode)
  const geminiApprovalMode = approvalMode === 'yolo' ? 'yolo' : 'plan'
  const startedAt = now()

  if (question.length === 0) {
    return {
      ok: false,
      model,
      question,
      prompt,
      error: 'Ask Gemini requires a non-empty question.',
      errorKind: 'cli_error',
      retryable: false,
      durationMs: 0,
    }
  }

  const args = [
    '--model',
    model,
    '--prompt',
    prompt,
    '--output-format',
    'json',
    '--approval-mode',
    geminiApprovalMode,
  ]

  let { error, stdout, stderr } = await execGeminiCli({
    execFile: execFileImpl,
    executable: ASK_GEMINI_EXECUTABLE,
    args,
    workingDirectory: input.workingDirectory,
  })

  if (error?.code === 'ENOENT') {
    const resolvedExecutable = await resolveGeminiExecutable(execFileImpl)
    if (resolvedExecutable) {
      const retryResult = await execGeminiCli({
        execFile: execFileImpl,
        executable: resolvedExecutable,
        args,
        workingDirectory: input.workingDirectory,
      })
      error = retryResult.error
      stdout = retryResult.stdout
      stderr = retryResult.stderr
    }
  }

  const durationMs = Math.max(now() - startedAt, 1)
  const parsed = tryParseGeminiJson(stdout)
  const warningMessages = collectGeminiWarnings({
    stderr,
    parsed,
  })
  const response =
    typeof parsed?.response === 'string'
      ? parsed.response.trim()
      : ''

  if (response.length > 0) {
    return {
      ok: true,
      model,
      question,
      prompt,
      response,
      durationMs,
      sessionId:
        typeof parsed?.session_id === 'string' ? parsed.session_id : undefined,
      stats: toRecord(parsed?.stats),
      warnings: warningMessages.length > 0 ? warningMessages : undefined,
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
    }
  }

  if (parsed?.error && typeof parsed.error === 'object') {
    const parsedError = toRecord(parsed.error) ?? {}
    const parsedMessage =
      typeof parsedError.message === 'string'
        ? parsedError.message.trim()
        : undefined
    const parsedCode =
      typeof parsedError.code === 'number' || typeof parsedError.code === 'string'
        ? parsedError.code
        : undefined
    const classified = classifyGeminiFailure(error, stdout, stderr, parsedMessage)

    return {
      ok: false,
      model,
      question,
      prompt,
      error: parsedMessage || classified.message,
      errorKind: classified.kind,
      retryable: classified.retryable,
      durationMs,
      exitCode: parsedCode ?? error?.code ?? undefined,
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
      details: buildGeminiFailureDetails(stdout, stderr),
    }
  }

  if (stdout.trim().length > 0 && !parsed) {
    return {
      ok: false,
      model,
      question,
      prompt,
      error: 'Gemini CLI returned invalid JSON output.',
      errorKind: 'invalid_json',
      retryable: true,
      durationMs,
      exitCode: error?.code ?? undefined,
      stdout: stdout.trim(),
      stderr: stderr.trim() || undefined,
      details: buildGeminiFailureDetails(stdout, stderr),
    }
  }

  const classified = classifyGeminiFailure(error, stdout, stderr)
  return {
    ok: false,
    model,
    question,
    prompt,
    error: classified.message,
    errorKind: classified.kind,
    retryable: classified.retryable,
    durationMs,
    exitCode: error?.code ?? undefined,
    stdout: stdout.trim() || undefined,
    stderr: stderr.trim() || undefined,
    details: buildGeminiFailureDetails(stdout, stderr),
  }
}

async function execGeminiCli(input: {
  execFile: ExecFileLike
  executable: string
  args: string[]
  workingDirectory: string
}): Promise<{
  error: ExecFileError | null
  stdout: string
  stderr: string
}> {
  return await new Promise((resolve) => {
    input.execFile(
      input.executable,
      input.args,
      {
        cwd: input.workingDirectory,
        timeout: ASK_GEMINI_TIMEOUT_MS,
        maxBuffer: GEMINI_MAX_BUFFER_BYTES,
      },
      (callbackError, callbackStdout, callbackStderr) => {
        resolve({
          error: callbackError as ExecFileError | null,
          stdout: callbackStdout ?? '',
          stderr: callbackStderr ?? '',
        })
      },
    )
  })
}

async function resolveGeminiExecutable(execFileImpl: ExecFileLike): Promise<string | undefined> {
  const shell = process.env.SHELL?.trim() || '/bin/zsh'

  const { error, stdout } = await new Promise<{
    error: ExecFileError | null
    stdout: string
    stderr: string
  }>((resolve) => {
    execFileImpl(
      shell,
      ['-lic', `command -v ${ASK_GEMINI_EXECUTABLE}`],
      {
        timeout: GEMINI_EXECUTABLE_RESOLUTION_TIMEOUT_MS,
        maxBuffer: 1024 * 64,
      },
      (callbackError, callbackStdout, callbackStderr) => {
        resolve({
          error: callbackError as ExecFileError | null,
          stdout: callbackStdout ?? '',
          stderr: callbackStderr ?? '',
        })
      },
    )
  })

  if (error) {
    return undefined
  }

  const firstLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return firstLine && firstLine !== ASK_GEMINI_EXECUTABLE
    ? firstLine
    : undefined
}

function buildGeminiPrompt(input: {
  question: string
  context?: string
}): string {
  const parts = [
    'You are helping another coding agent from inside a desktop coding app.',
    'Answer the question directly and practically.',
    'Keep assumptions explicit and avoid unnecessary preamble.',
  ]

  const context = input.context?.trim()
  if (context) {
    parts.push(`Additional context:\n${context}`)
  }

  parts.push(`Question:\n${input.question}`)

  return parts.join('\n\n')
}

function tryParseGeminiJson(stdout: string): GeminiJsonOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object'
      ? parsed as GeminiJsonOutput
      : null
  } catch {
    return null
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function collectGeminiWarnings(input: {
  stderr: string
  parsed: GeminiJsonOutput | null
}): string[] {
  const warnings: string[] = []
  const stderr = input.stderr.trim()
  const parsedError = toRecord(input.parsed?.error)
  const parsedMessage =
    typeof parsedError?.message === 'string' ? parsedError.message.trim() : ''

  if (/MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available|status 429/i.test(stderr)) {
    warnings.push('Gemini CLI hit transient capacity errors before succeeding.')
  }

  if (/Loaded cached credentials\./i.test(stderr)) {
    warnings.push('Gemini CLI used cached credentials.')
  }

  if (parsedMessage.length > 0) {
    warnings.push(`Gemini also reported: ${parsedMessage}`)
  }

  return Array.from(new Set(warnings))
}

function classifyGeminiFailure(
  error: ExecFileError | null,
  stdout: string,
  stderr: string,
  parsedMessage?: string,
): {
  kind: GeminiCliErrorKind
  message: string
  retryable: boolean
} {
  const haystack = [parsedMessage, error?.message, stdout, stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')

  if (error?.code === 'ENOENT' || /not found|no such file or directory/i.test(haystack)) {
    return {
      kind: 'missing_binary',
      message: 'Gemini CLI is not installed or not available on PATH.',
      retryable: false,
    }
  }

  if (
    error?.code === 'ETIMEDOUT'
    || error?.signal === 'SIGTERM'
    || error?.killed
  ) {
    return {
      kind: 'timeout',
      message: `Gemini CLI did not finish within ${Math.round(ASK_GEMINI_TIMEOUT_MS / 1000)} seconds.`,
      retryable: true,
    }
  }

  if (
    /sign in with google|re-authenticate|authentication|authenticate|credentials|api key|oauth|unauthorized|forbidden|login/i.test(
      haystack,
    )
  ) {
    return {
      kind: 'auth_missing',
      message: 'Gemini CLI is not authenticated for headless use on this machine.',
      retryable: false,
    }
  }

  if (
    /MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available|rateLimitExceeded|Too Many Requests|status 429/i.test(
      haystack,
    )
  ) {
    return {
      kind: 'capacity_exhausted',
      message: 'Gemini CLI could not get model capacity right now.',
      retryable: true,
    }
  }

  if (stdout.trim().length === 0 && stderr.trim().length === 0) {
    return {
      kind: 'empty_response',
      message: 'Gemini CLI returned no response.',
      retryable: true,
    }
  }

  return {
    kind: 'cli_error',
    message:
      parsedMessage?.trim()
      || error?.message.trim()
      || 'Gemini CLI failed to answer the question.',
    retryable: Boolean(error),
  }
}

function buildGeminiFailureDetails(stdout: string, stderr: string): string | undefined {
  const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n').trim()
  return details.length > 0 ? details : undefined
}
