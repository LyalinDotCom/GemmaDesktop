type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error' | 'debug'

type ConsoleMethod = (...args: unknown[]) => void

type ErrorWithCause = Error & {
  cause?: unknown
  code?: string | number | null
  errno?: string | number | null
  signal?: string | null
}

const CONSOLE_METHODS: readonly ConsoleMethodName[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
] as const

let installed = false

function isErrorWithCause(value: unknown): value is ErrorWithCause {
  return value instanceof Error
}

function buildConsolePrefix(now = new Date()): string {
  return `[${now.toISOString()}]`
}

function formatErrorMetadata(error: ErrorWithCause): string[] {
  const details: string[] = []

  if (error.code != null && `${error.code}`.trim().length > 0) {
    details.push(`code=${error.code}`)
  }
  if (error.errno != null && `${error.errno}`.trim().length > 0) {
    details.push(`errno=${error.errno}`)
  }
  if (error.signal != null && `${error.signal}`.trim().length > 0) {
    details.push(`signal=${error.signal}`)
  }

  return details
}

function indentLines(value: string, prefix = '  '): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

export function formatErrorForConsole(
  error: unknown,
  seen = new Set<unknown>(),
): string {
  if (!isErrorWithCause(error)) {
    return String(error)
  }

  if (seen.has(error)) {
    return '[Circular error cause]'
  }
  seen.add(error)

  const headParts = [`${error.name}: ${error.message}`]
  const metadata = formatErrorMetadata(error)
  if (metadata.length > 0) {
    headParts.push(`(${metadata.join(', ')})`)
  }

  const sections = [headParts.join(' ')]

  if (typeof error.stack === 'string' && error.stack.trim().length > 0) {
    const stackLines = error.stack.trim().split('\n')
    const stackBody =
      stackLines[0]?.includes(error.message)
        ? stackLines.slice(1).join('\n')
        : error.stack.trim()
    if (stackBody.trim().length > 0) {
      sections.push(`stack:\n${indentLines(stackBody.trim())}`)
    }
  }

  if (error.cause !== undefined) {
    sections.push(`cause:\n${indentLines(formatErrorForConsole(error.cause, seen))}`)
  }

  return sections.join('\n')
}

function normalizeConsoleArg(arg: unknown): unknown {
  return isErrorWithCause(arg) ? formatErrorForConsole(arg) : arg
}

export function buildTimestampedConsoleArgs(
  args: unknown[],
  now = new Date(),
): unknown[] {
  return [buildConsolePrefix(now), ...args.map(normalizeConsoleArg)]
}

export function installMainConsoleFormatting(): void {
  if (installed) {
    return
  }
  installed = true

  for (const methodName of CONSOLE_METHODS) {
    const original = console[methodName].bind(console) as ConsoleMethod
    console[methodName] = ((...args: unknown[]) => {
      original(...buildTimestampedConsoleArgs(args))
    }) as ConsoleMethod
  }
}
