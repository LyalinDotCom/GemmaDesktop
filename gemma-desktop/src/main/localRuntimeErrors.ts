export interface LocalRuntimeUnavailableContext {
  runtimeId: string
  endpoint: string
  modelId?: string
  action?: string
}

const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

const CONNECTION_FAILURE_MESSAGE_PATTERN =
  /\b(fetch failed|connection refused|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|etimedout|eai_again)\b/i

const MODEL_NOT_LOADED_MESSAGE_PATTERN =
  /\b(model not loaded|no loaded model|model is not loaded)\b/i

export function getLocalRuntimeDisplayName(runtimeId: string): string {
  if (runtimeId === 'ollama-native' || runtimeId === 'ollama-openai') {
    return 'Ollama'
  }
  if (runtimeId === 'lmstudio-native' || runtimeId === 'lmstudio-openai') {
    return 'LM Studio'
  }
  if (runtimeId === 'llamacpp' || runtimeId === 'llamacpp-server') {
    return 'llama.cpp server'
  }
  if (runtimeId === 'omlx-openai') {
    return 'oMLX'
  }
  return 'The selected local runtime'
}

function getLocalRuntimeRecoveryHint(runtimeId: string): string {
  if (runtimeId === 'ollama-native' || runtimeId === 'ollama-openai') {
    return 'Start Ollama or run `ollama serve`, then retry or switch this session to another runtime.'
  }
  if (runtimeId === 'lmstudio-native' || runtimeId === 'lmstudio-openai') {
    return 'Start LM Studio and enable its local server, then retry or switch this session to another runtime.'
  }
  if (runtimeId === 'llamacpp' || runtimeId === 'llamacpp-server') {
    return 'Start the llama.cpp server, then retry or switch this session to another runtime.'
  }
  if (runtimeId === 'omlx-openai') {
    return 'Start oMLX, load the model there, then retry or switch this session to another runtime.'
  }
  return 'Start that runtime, then retry or switch this session to another runtime.'
}

function buildLocalRuntimeUnavailableMessage(
  context: LocalRuntimeUnavailableContext,
): string {
  const runtimeLabel = getLocalRuntimeDisplayName(context.runtimeId)
  const action = context.action?.trim()
  const modelPhrase = context.modelId
    ? ` ${context.modelId}`
    : ''
  const actionPhrase = action && action.length > 0
    ? ` while ${action}${modelPhrase}`
    : modelPhrase
      ? ` while preparing ${modelPhrase.trim()}`
      : ''

  return `${runtimeLabel} is not reachable at ${context.endpoint}${actionPhrase}. ${getLocalRuntimeRecoveryHint(context.runtimeId)}`
}

export class LocalRuntimeUnavailableError extends Error {
  public readonly runtimeId: string
  public readonly endpoint: string
  public readonly modelId?: string
  public readonly runtimeLabel: string
  public readonly recoveryHint: string

  public constructor(
    context: LocalRuntimeUnavailableContext,
    cause?: unknown,
  ) {
    super(buildLocalRuntimeUnavailableMessage(context), { cause })
    this.name = 'LocalRuntimeUnavailableError'
    this.runtimeId = context.runtimeId
    this.endpoint = context.endpoint
    this.modelId = context.modelId
    this.runtimeLabel = getLocalRuntimeDisplayName(context.runtimeId)
    this.recoveryHint = getLocalRuntimeRecoveryHint(context.runtimeId)
  }
}

function getErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current = error

  while (
    current
    && typeof current === 'object'
    && !seen.has(current)
  ) {
    chain.push(current)
    seen.add(current)
    current = (current as { cause?: unknown }).cause
  }

  return chain
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  return typeof record[key] === 'string'
    ? record[key]
    : undefined
}

function getErrorMessage(entry: unknown): string | undefined {
  return entry instanceof Error
    ? entry.message
    : getStringProperty(entry, 'message')
}

export function isLocalRuntimeConnectionFailure(error: unknown): boolean {
  for (const entry of getErrorChain(error)) {
    const code = getStringProperty(entry, 'code')
    if (code && CONNECTION_FAILURE_CODES.has(code)) {
      return true
    }

    const message = getErrorMessage(entry)
    if (message && CONNECTION_FAILURE_MESSAGE_PATTERN.test(message)) {
      return true
    }
  }

  return false
}

export function isModelNotLoadedError(error: unknown): boolean {
  for (const entry of getErrorChain(error)) {
    const message = getErrorMessage(entry)
    if (message && MODEL_NOT_LOADED_MESSAGE_PATTERN.test(message)) {
      return true
    }
  }

  return false
}

export function getLocalRuntimeUnavailableError(
  error: unknown,
): LocalRuntimeUnavailableError | null {
  return error instanceof LocalRuntimeUnavailableError
    ? error
    : null
}

export function toLocalRuntimeUnavailableError(
  error: unknown,
  context: LocalRuntimeUnavailableContext,
): LocalRuntimeUnavailableError | null {
  const existing = getLocalRuntimeUnavailableError(error)
  if (existing) {
    return existing
  }

  return isLocalRuntimeConnectionFailure(error)
    ? new LocalRuntimeUnavailableError(context, error)
    : null
}
