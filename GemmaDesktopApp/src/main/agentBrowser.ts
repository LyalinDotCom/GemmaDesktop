import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const BROWSER_TOOL_NAME = 'browser'
export const AGENT_BROWSER_PACKAGE = 'agent-browser@0.26.0'
export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 30_000
export const DEFAULT_BROWSER_SNAPSHOT_INLINE_TEXT_CHARS = 6_000
export const DEFAULT_BROWSER_INLINE_TEXT_CHARS = 4_000
const MAX_BROWSER_INLINE_TEXT_CHARS = 12_000
const DEFAULT_BROWSER_DETAIL_FILE_EXTENSION = 'md'
const BROWSER_COMMAND_RETRY_DELAYS_MS = [0, 400]

export const BROWSER_TOOL_ACTIONS = [
  'tabs',
  'focus',
  'open',
  'navigate',
  'wait',
  'snapshot',
  'screenshot',
  'click',
  'fill',
  'type',
  'press',
  'close',
  'dialog',
  'evaluate',
] as const

export type BrowserToolAction = (typeof BROWSER_TOOL_ACTIONS)[number]

export const BROWSER_MUTATING_ACTIONS = [
  'open',
  'navigate',
  'click',
  'fill',
  'type',
  'press',
  'close',
  'dialog',
  'evaluate',
] as const

const BROWSER_TOOL_ACTION_SET = new Set<string>(BROWSER_TOOL_ACTIONS)
const BROWSER_MUTATING_ACTION_SET = new Set<string>(BROWSER_MUTATING_ACTIONS)

type JsonSchema = Record<string, unknown>

type BrowserCliInvocation = {
  command: string
  baseArgs: string[]
}

type BrowserCliEnvelope<T> = {
  success?: boolean
  data?: T
  error?: string | null
  warning?: unknown
}

type BrowserSnapshotData = {
  origin?: string
  refs?: Record<string, { role?: string; name?: string }>
  snapshot?: string
}

type BrowserScreenshotData = {
  path?: string
}

type BrowserTabRecord = {
  tabId?: string
  label?: string | null
  title?: string | null
  url?: string
  active?: boolean
  type?: string
}

type BrowserTabsData = {
  tabs?: BrowserTabRecord[]
}

type BrowserOpenData = {
  title?: string
  url?: string
}

type PersistedBrowserArtifact = {
  path: string
  fileUrl: string
}

export interface BrowserToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface BrowserToolStatusRecord {
  state: 'idle' | 'ready' | 'error'
  message: string
  checkedAt: number
}

export interface AgentBrowserDoctorCheck {
  category: string
  id: string
  message: string
  status: 'pass' | 'fail' | 'warn' | 'info'
  fix?: string
}

export interface AgentBrowserDoctorReport {
  success: boolean
  summary?: {
    fail?: number
    pass?: number
    warn?: number
  }
  checks?: AgentBrowserDoctorCheck[]
  fixed?: unknown[]
}

export interface AgentBrowserDoctorInspection {
  ok: boolean
  status: BrowserToolStatusRecord
  report?: AgentBrowserDoctorReport
}

type BrowserToolCallResult = {
  output: string
  structuredOutput?: Record<string, unknown>
}

type BrowserCliLike = {
  execJson<T>(sessionId: string | null, args: string[]): Promise<BrowserCliEnvelope<T>>
  execText(sessionId: string | null, args: string[]): Promise<string>
}

export interface BrowserSessionManagerOptions {
  onStatus: (status: BrowserToolStatusRecord) => Promise<void> | void
  onLog?: (sessionId: string, line: string) => void
  persistArtifact?: (input: {
    sessionId: string
    action: string
    text: string
    metadata?: Record<string, unknown>
    extension?: 'md' | 'txt'
  }) => Promise<PersistedBrowserArtifact>
}

export const BROWSER_TOOL_DEFINITIONS: readonly BrowserToolDefinition[] = [
  {
    name: BROWSER_TOOL_NAME,
    description: [
      'Use a managed browser session for live or dynamic sites that need real page interaction.',
      'Open pages, inspect tabs, capture snapshots, wait for page content, click refs, fill forms, type, press keys, navigate, take screenshots, handle dialogs, or run page scripts when needed.',
      'Prefer snapshot after each meaningful page change so you get fresh refs before the next action.',
      'Use this tool instead of fetch-only web tools when a site is JavaScript-heavy, interactive, personalized, or blocked behind dynamic rendering.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...BROWSER_TOOL_ACTIONS],
        },
        tabId: { type: 'string' },
        url: { type: 'string' },
        navigation: {
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload'],
        },
        waitForText: {
          type: 'array',
          items: { type: 'string' },
        },
        waitForLoadState: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
        },
        waitMs: { type: 'number' },
        maxChars: { type: 'number' },
        ref: { type: 'string' },
        uid: { type: 'string' },
        value: { type: 'string' },
        inputText: { type: 'string' },
        key: { type: 'string' },
        fullPage: { type: 'boolean' },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
        },
        dialogAction: {
          type: 'string',
          enum: ['accept', 'dismiss'],
        },
        promptText: { type: 'string' },
        function: { type: 'string' },
        args: {
          type: 'array',
          items: {},
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
] as const

let resolvedInvocationPromise: Promise<BrowserCliInvocation> | null = null

function nowStatus(message: string, state: BrowserToolStatusRecord['state']): BrowserToolStatusRecord {
  return {
    state,
    message,
    checkedAt: Date.now(),
  }
}

function sanitizeSessionId(sessionId: string): string {
  const normalized = sessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return normalized.length > 0 ? `gemma-desktop-${normalized}` : 'gemma-desktop-session'
}

function extractErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

type BrowserCommandAttempt = {
  attempt: number
  message: string
}

function isRetryableBrowserCommandFailure(message: string): boolean {
  return /\b(?:returned no output|timed out|timeout|econnreset|econnrefused|enetunreach|ehostunreach|eai_again|enotfound|socket hang up|temporary failure|browser disconnected|target closed|net::err_|tls|ssl)\b/i.test(
    message,
  )
}

function formatBrowserCommandFailureMessage(attempts: BrowserCommandAttempt[]): string {
  const last = attempts.at(-1)
  const parts = [
    `Managed browser command failed after ${attempts.length || 1} attempt${attempts.length === 1 ? '' : 's'}.`,
  ]

  if (last?.message) {
    parts.push(`Last failure: ${last.message}.`)
  }

  if (attempts.length > 1) {
    parts.push(`Attempts: ${attempts.map((attempt) => attempt.message).join(' -> ')}.`)
  }

  if (attempts.length > 0 && attempts.every((attempt) => isRetryableBrowserCommandFailure(attempt.message))) {
    parts.push(
      'This looks like a transient browser, site, or network stall rather than a deterministic tool-input error.',
    )
  }

  return parts.join(' ')
}

async function resolveBrowserCliInvocation(): Promise<BrowserCliInvocation> {
  try {
    await execFileAsync('agent-browser', ['--version'], {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    })
    return {
      command: 'agent-browser',
      baseArgs: [],
    }
  } catch (error) {
    const missing =
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'

    if (!missing) {
      throw error
    }

    return {
      command: 'npx',
      baseArgs: ['-y', AGENT_BROWSER_PACKAGE],
    }
  }
}

async function getBrowserCliInvocation(): Promise<BrowserCliInvocation> {
  if (!resolvedInvocationPromise) {
    resolvedInvocationPromise = resolveBrowserCliInvocation().catch((error) => {
      resolvedInvocationPromise = null
      throw error
    })
  }

  return await resolvedInvocationPromise
}

async function execBrowserCommand(input: {
  sessionId?: string | null
  args: string[]
  json?: boolean
  timeoutMs?: number
}): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const invocation = await getBrowserCliInvocation()
  const commandArgs = [
    ...invocation.baseArgs,
    ...(input.sessionId ? ['--session', sanitizeSessionId(input.sessionId)] : []),
    ...(input.json === false ? [] : ['--json']),
    ...input.args,
  ]

  try {
    const result = await execFileAsync(invocation.command, commandArgs, {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      timeout: input.timeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    }
  } catch (error) {
    const execError = error as Error & {
      code?: number | string
      stdout?: string
      stderr?: string
    }

    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      exitCode: typeof execError.code === 'number' ? execError.code : 1,
    }
  }
}

function parseBrowserEnvelope<T>(text: string): BrowserCliEnvelope<T> {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new Error('Managed browser returned no output.')
  }

  return JSON.parse(trimmed) as BrowserCliEnvelope<T>
}

function createBrowserCli(): BrowserCliLike {
  return {
    async execJson<T>(sessionId: string | null, args: string[]): Promise<BrowserCliEnvelope<T>> {
      const attempts: BrowserCommandAttempt[] = []

      for (let attemptIndex = 0; attemptIndex < BROWSER_COMMAND_RETRY_DELAYS_MS.length; attemptIndex += 1) {
        if (attemptIndex > 0) {
          await sleep(BROWSER_COMMAND_RETRY_DELAYS_MS[attemptIndex] ?? 0)
        }

        const result = await execBrowserCommand({
          sessionId,
          args,
          json: true,
        })
        const raw = [result.stdout, result.stderr].find((entry) => entry.trim().length > 0) ?? ''

        try {
          const parsed = parseBrowserEnvelope<T>(raw)

          if (parsed.success === false && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
            throw new Error(parsed.error.trim())
          }

          if (result.exitCode !== 0 && parsed.success !== true) {
            throw new Error(
              typeof parsed.error === 'string' && parsed.error.trim().length > 0
                ? parsed.error.trim()
                : 'Managed browser command failed.',
            )
          }

          return parsed
        } catch (error) {
          const message = extractErrorText(error)
          attempts.push({
            attempt: attemptIndex + 1,
            message,
          })

          const shouldRetry =
            attemptIndex < BROWSER_COMMAND_RETRY_DELAYS_MS.length - 1
            && isRetryableBrowserCommandFailure(message)
          if (!shouldRetry) {
            throw new Error(formatBrowserCommandFailureMessage(attempts))
          }
        }
      }

      throw new Error(formatBrowserCommandFailureMessage(attempts))
    },
    async execText(sessionId: string | null, args: string[]): Promise<string> {
      const result = await execBrowserCommand({
        sessionId,
        args,
        json: false,
      })
      const text = `${result.stdout}\n${result.stderr}`.trim()
      if (result.exitCode !== 0) {
        throw new Error(text || 'Managed browser command failed.')
      }
      return text
    },
  }
}

function normalizeTabRecord(entry: BrowserTabRecord): {
  tabId: string
  label?: string
  title?: string
  url?: string
  active?: boolean
} | null {
  if (typeof entry.tabId !== 'string' || entry.tabId.trim().length === 0) {
    return null
  }

  return {
    tabId: entry.tabId,
    label:
      typeof entry.label === 'string' && entry.label.trim().length > 0
        ? entry.label.trim()
        : undefined,
    title:
      typeof entry.title === 'string' && entry.title.trim().length > 0
        ? entry.title.trim()
        : undefined,
    url:
      typeof entry.url === 'string' && entry.url.trim().length > 0
        ? entry.url.trim()
        : undefined,
    active: entry.active === true || undefined,
  }
}

function formatTabs(
  tabs: Array<{
    tabId: string
    label?: string
    title?: string
    url?: string
    active?: boolean
  }>,
): string {
  if (tabs.length === 0) {
    return 'No browser tabs are open.'
  }

  return tabs
    .map((tab) => {
      const detail = [
        tab.title,
        tab.url,
      ]
        .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
        .join(' — ')

      return `${tab.tabId}${tab.active ? ' [active]' : ''}${tab.label ? ` (${tab.label})` : ''}${detail ? `: ${detail}` : ''}`
    })
    .join('\n')
}

function normalizeSnapshotText(data: BrowserSnapshotData | undefined): string {
  const snapshot = typeof data?.snapshot === 'string' ? data.snapshot.trim() : ''
  if (snapshot.length === 0) {
    return '(no interactive elements)'
  }

  return snapshot.replace(/\bref=(e\d+)\b/g, 'ref=@$1')
}

function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

function resolveInputRef(args: Record<string, unknown>): string {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
  if (ref.length > 0) {
    return normalizeRef(ref)
  }

  const uid = typeof args.uid === 'string' ? args.uid.trim() : ''
  if (uid.length > 0) {
    return normalizeRef(uid)
  }

  return ''
}

function truncateBrowserInlineText(text: string, maxChars: number): {
  text: string
  truncated: boolean
  originalChars: number
} {
  const normalizedMaxChars = Math.max(
    200,
    Math.min(MAX_BROWSER_INLINE_TEXT_CHARS, Math.floor(maxChars)),
  )

  if (text.length <= normalizedMaxChars) {
    return {
      text,
      truncated: false,
      originalChars: text.length,
    }
  }

  const excerpt = text.slice(0, normalizedMaxChars).trimEnd()
  return {
    text: `${excerpt}\n\n[...TRUNCATED - full browser output stored separately if needed]`,
    truncated: true,
    originalChars: text.length,
  }
}

async function finalizeBrowserTextResult(input: {
  sessionId: string
  action: BrowserToolAction
  text: string
  maxChars: number
  persistArtifact?: BrowserSessionManagerOptions['persistArtifact']
  metadata?: Record<string, unknown>
  lead?: string
}): Promise<BrowserToolCallResult> {
  const trimmedText = input.text.trim()
  const lead = input.lead?.trim()

  if (!trimmedText) {
    return {
      output: lead?.length ? lead : 'Browser action completed.',
      structuredOutput: {
        action: input.action,
      },
    }
  }

  const truncated = truncateBrowserInlineText(trimmedText, input.maxChars)
  let artifact: PersistedBrowserArtifact | null = null

  if (truncated.truncated && input.persistArtifact) {
    artifact = await input.persistArtifact({
      sessionId: input.sessionId,
      action: input.action,
      text: trimmedText,
      metadata: input.metadata,
      extension:
        input.action === 'snapshot'
          ? DEFAULT_BROWSER_DETAIL_FILE_EXTENSION
          : 'txt',
    }).catch(() => null)
  }

  return {
    output: [
      lead?.length ? lead : null,
      truncated.truncated
        ? `Returned an excerpt (${Math.min(input.maxChars, truncated.originalChars)} of ${truncated.originalChars} chars).`
        : null,
      truncated.text,
      artifact
        ? `Full browser ${input.action} details saved to ${artifact.path}. Read that file only if you need the complete output.`
        : null,
    ]
      .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
      .join('\n\n'),
    structuredOutput: {
      action: input.action,
      ...(truncated.truncated
        ? {
            truncated: true,
            originalChars: truncated.originalChars,
          }
        : {}),
      ...(artifact
        ? {
            artifactPath: artifact.path,
            artifactFileUrl: artifact.fileUrl,
          }
        : {}),
      ...(input.metadata ?? {}),
    },
  }
}

async function selectTabIfNeeded(
  cli: BrowserCliLike,
  sessionId: string,
  tabId: unknown,
): Promise<string | undefined> {
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    return undefined
  }

  const normalized = tabId.trim()
  await cli.execJson(sessionId, ['tab', normalized])
  return normalized
}

async function listTabs(
  cli: BrowserCliLike,
  sessionId: string,
): Promise<Array<{
  tabId: string
  label?: string
  title?: string
  url?: string
  active?: boolean
}>> {
  const envelope = await cli.execJson<BrowserTabsData>(sessionId, ['tab'])
  return (envelope.data?.tabs ?? [])
    .map((entry) => normalizeTabRecord(entry))
    .filter((entry): entry is NonNullable<ReturnType<typeof normalizeTabRecord>> => entry !== null)
}

function buildLead(action: BrowserToolAction, detail?: string): string {
  const suffix = detail?.trim()
  switch (action) {
    case 'tabs':
      return 'Current browser tabs:'
    case 'focus':
      return suffix ? `Selected browser tab ${suffix}.` : 'Selected the requested browser tab.'
    case 'open':
      return suffix ? `Opened a new browser tab for ${suffix}.` : 'Opened a new browser tab.'
    case 'navigate':
      return suffix ? `Updated the targeted browser tab to ${suffix}.` : 'Updated the targeted browser tab.'
    case 'wait':
      return 'Wait condition satisfied in the browser.'
    case 'snapshot':
      return 'Captured a browser snapshot.'
    case 'screenshot':
      return 'Captured a browser screenshot.'
    case 'click':
      return 'Completed the requested browser click.'
    case 'fill':
      return 'Filled the requested browser form field.'
    case 'type':
      return 'Typed into the browser page.'
    case 'press':
      return 'Sent keyboard input to the browser.'
    case 'close':
      return suffix ? `Closed browser tab ${suffix}.` : 'Closed the requested browser tab.'
    case 'dialog':
      return 'Handled the browser dialog.'
    case 'evaluate':
      return 'Ran the requested browser page script.'
  }
}

export function isBrowserActionName(value: unknown): value is BrowserToolAction {
  return typeof value === 'string' && BROWSER_TOOL_ACTION_SET.has(value)
}

export function isBrowserMutatingActionName(value: unknown): boolean {
  return typeof value === 'string' && BROWSER_MUTATING_ACTION_SET.has(value)
}

export async function executeAgentBrowserTool(input: {
  sessionId: string
  args: Record<string, unknown>
  cli: BrowserCliLike
  persistArtifact?: BrowserSessionManagerOptions['persistArtifact']
}): Promise<BrowserToolCallResult> {
  const action = input.args.action
  if (!isBrowserActionName(action)) {
    throw new Error(
      `Browser action is required and must be one of ${BROWSER_TOOL_ACTIONS.join(', ')}.`,
    )
  }

  switch (action) {
    case 'tabs': {
      const tabs = await listTabs(input.cli, input.sessionId)
      return {
        output: `${buildLead(action)}\n${formatTabs(tabs)}`,
        structuredOutput: {
          action,
          tabs,
        },
      }
    }
    case 'focus': {
      const tabId = await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      if (!tabId) {
        throw new Error('Browser action "focus" requires tabId.')
      }
      const tabs = await listTabs(input.cli, input.sessionId)
      return {
        output: `${buildLead(action, tabId)}\n\n${formatTabs(tabs)}`,
        structuredOutput: {
          action,
          tabId,
          tabs,
        },
      }
    }
    case 'open': {
      const url = typeof input.args.url === 'string' ? input.args.url.trim() : ''
      if (!url) {
        throw new Error('Browser action "open" requires url.')
      }

      const envelope = await input.cli.execJson<BrowserOpenData>(input.sessionId, ['tab', 'new', url])
      const tabs = await listTabs(input.cli, input.sessionId)
      const openedTab = tabs.find((tab) => tab.active) ?? tabs.at(-1)
      return {
        output: [
          buildLead(action, url),
          formatTabs(tabs),
        ].join('\n\n'),
        structuredOutput: {
          action,
          url,
          tabId: openedTab?.tabId,
          title:
            typeof envelope.data?.title === 'string' && envelope.data.title.trim().length > 0
              ? envelope.data.title.trim()
              : undefined,
          tabs,
        },
      }
    }
    case 'navigate': {
      const selectedTabId = await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const navigation =
        typeof input.args.navigation === 'string' && input.args.navigation.trim().length > 0
          ? input.args.navigation.trim()
          : typeof input.args.url === 'string' && input.args.url.trim().length > 0
            ? 'url'
            : undefined

      if (!navigation) {
        throw new Error('Browser action "navigate" requires navigation or url.')
      }

      const url = typeof input.args.url === 'string' ? input.args.url.trim() : undefined
      if (navigation === 'url' && (!url || url.length === 0)) {
        throw new Error('Browser action "navigate" requires url when navigation="url".')
      }

      let envelope: BrowserCliEnvelope<BrowserOpenData>
      if (navigation === 'url') {
        envelope = await input.cli.execJson<BrowserOpenData>(input.sessionId, ['open', url!])
      } else {
        envelope = await input.cli.execJson<BrowserOpenData>(input.sessionId, [navigation])
      }

      const tabs = await listTabs(input.cli, input.sessionId)
      return {
        output: [
          buildLead(action, url ?? navigation),
          formatTabs(tabs),
        ].join('\n\n'),
        structuredOutput: {
          action,
          navigation,
          url,
          tabId: selectedTabId ?? tabs.find((tab) => tab.active)?.tabId,
          title:
            typeof envelope.data?.title === 'string' && envelope.data.title.trim().length > 0
              ? envelope.data.title.trim()
              : undefined,
          tabs,
        },
      }
    }
    case 'wait': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const waitForText = Array.isArray(input.args.waitForText)
        ? input.args.waitForText.filter(
            (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
          )
        : []
      const waitForLoadState =
        typeof input.args.waitForLoadState === 'string'
          ? input.args.waitForLoadState.trim()
          : ''
      const waitMs =
        typeof input.args.waitMs === 'number' && Number.isFinite(input.args.waitMs)
          ? Math.max(0, Math.floor(input.args.waitMs))
          : null

      if (waitMs && waitMs > 0) {
        await input.cli.execJson(input.sessionId, ['wait', String(waitMs)])
        return {
          output: `${buildLead(action)}\n\nWaited ${waitMs} ms.`,
          structuredOutput: {
            action,
            waitMs,
          },
        }
      }

      if (waitForLoadState === 'load' || waitForLoadState === 'domcontentloaded' || waitForLoadState === 'networkidle') {
        await input.cli.execJson(input.sessionId, ['wait', '--load', waitForLoadState])
        return {
          output: `${buildLead(action)}\n\nReached load state: ${waitForLoadState}`,
          structuredOutput: {
            action,
            waitForLoadState,
          },
        }
      }

      if (waitForText.length === 0) {
        throw new Error(
          'Browser action "wait" requires waitForText, waitForLoadState, or waitMs.',
        )
      }

      if (waitForText.length === 1) {
        await input.cli.execJson(input.sessionId, ['wait', '--text', waitForText[0]!])
      } else {
        const functionBody = `(() => {
  const text = document.body?.innerText ?? "";
  return ${JSON.stringify(waitForText)}.some((needle) => text.includes(needle));
})()`
        await input.cli.execJson(input.sessionId, ['wait', '--fn', functionBody])
      }

      return {
        output: `${buildLead(action)}\n\nMatched one of: ${waitForText.join(', ')}`,
        structuredOutput: {
          action,
          waitForText,
        },
      }
    }
    case 'snapshot': {
      const tabId = await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const envelope = await input.cli.execJson<BrowserSnapshotData>(input.sessionId, ['snapshot', '-i'])
      const snapshotText = normalizeSnapshotText(envelope.data)
      const maxChars =
        typeof input.args.maxChars === 'number' && Number.isFinite(input.args.maxChars)
          ? input.args.maxChars
          : DEFAULT_BROWSER_SNAPSHOT_INLINE_TEXT_CHARS

      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: snapshotText,
        maxChars,
        persistArtifact: input.persistArtifact,
        metadata: {
          ...(tabId ? { tabId } : {}),
          ...(typeof envelope.data?.origin === 'string' ? { origin: envelope.data.origin } : {}),
          ...(envelope.data?.refs ? { refs: envelope.data.refs } : {}),
        },
        lead: buildLead(action),
      })
    }
    case 'screenshot': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const args = ['screenshot']
      if (input.args.fullPage === true) {
        args.push('--full')
      }
      if (input.args.format === 'jpeg') {
        args.push('--screenshot-format', 'jpeg')
      }

      const envelope = await input.cli.execJson<BrowserScreenshotData>(input.sessionId, args)
      const screenshotPath =
        typeof envelope.data?.path === 'string' && envelope.data.path.trim().length > 0
          ? envelope.data.path.trim()
          : undefined

      return {
        output: screenshotPath
          ? `${buildLead(action)}\n\nSaved to ${screenshotPath}`
          : buildLead(action),
        structuredOutput: {
          action,
          path: screenshotPath,
        },
      }
    }
    case 'click': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const ref = resolveInputRef(input.args)
      if (!ref) {
        throw new Error('Browser action "click" requires ref.')
      }
      await input.cli.execJson(input.sessionId, ['click', ref])
      return {
        output: buildLead(action),
        structuredOutput: {
          action,
          ref,
        },
      }
    }
    case 'fill': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const ref = resolveInputRef(input.args)
      if (!ref) {
        throw new Error('Browser action "fill" requires ref.')
      }
      if (typeof input.args.value !== 'string') {
        throw new Error('Browser action "fill" requires value.')
      }
      await input.cli.execJson(input.sessionId, ['fill', ref, input.args.value])
      return {
        output: buildLead(action),
        structuredOutput: {
          action,
          ref,
        },
      }
    }
    case 'type': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const inputText =
        typeof input.args.inputText === 'string' ? input.args.inputText : undefined
      if (!inputText || inputText.trim().length === 0) {
        throw new Error('Browser action "type" requires inputText.')
      }

      const ref = resolveInputRef(input.args)
      if (ref.length > 0) {
        await input.cli.execJson(input.sessionId, ['type', ref, inputText])
      } else {
        await input.cli.execJson(input.sessionId, ['keyboard', 'type', inputText])
      }

      return {
        output: buildLead(action),
        structuredOutput: {
          action,
          ...(ref.length > 0 ? { ref } : {}),
        },
      }
    }
    case 'press': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const key = typeof input.args.key === 'string' ? input.args.key.trim() : ''
      if (!key) {
        throw new Error('Browser action "press" requires key.')
      }
      await input.cli.execJson(input.sessionId, ['press', key])
      return {
        output: buildLead(action),
        structuredOutput: {
          action,
          key,
        },
      }
    }
    case 'close': {
      const tabId = typeof input.args.tabId === 'string' ? input.args.tabId.trim() : ''
      if (!tabId) {
        throw new Error('Browser action "close" requires tabId.')
      }
      await input.cli.execText(input.sessionId, ['tab', 'close', tabId])
      const tabs = await listTabs(input.cli, input.sessionId)
      return {
        output: `${buildLead(action, tabId)}\n\n${formatTabs(tabs)}`,
        structuredOutput: {
          action,
          tabId,
          tabs,
        },
      }
    }
    case 'dialog': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const dialogAction =
        typeof input.args.dialogAction === 'string' ? input.args.dialogAction : undefined
      if (dialogAction !== 'accept' && dialogAction !== 'dismiss') {
        throw new Error('Browser action "dialog" requires dialogAction of "accept" or "dismiss".')
      }
      const args = ['dialog', dialogAction]
      if (dialogAction === 'accept' && typeof input.args.promptText === 'string') {
        args.push(input.args.promptText)
      }
      await input.cli.execJson(input.sessionId, args)
      return {
        output: buildLead(action),
        structuredOutput: {
          action,
          dialogAction,
        },
      }
    }
    case 'evaluate': {
      await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
      const fn = typeof input.args.function === 'string' ? input.args.function : undefined
      if (!fn || fn.trim().length === 0) {
        throw new Error('Browser action "evaluate" requires function.')
      }
      const envelope = await input.cli.execJson<Record<string, unknown>>(input.sessionId, ['eval', fn])
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: JSON.stringify(envelope.data ?? {}, null, 2),
        maxChars:
          typeof input.args.maxChars === 'number' && Number.isFinite(input.args.maxChars)
            ? input.args.maxChars
            : DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        lead: buildLead(action),
      })
    }
  }
}

export async function inspectAgentBrowserDoctor(): Promise<AgentBrowserDoctorInspection> {
  try {
    const result = await execBrowserCommand({
      sessionId: null,
      args: ['doctor', '--offline', '--quick'],
      json: true,
      timeoutMs: 45_000,
    })
    const raw = [result.stdout, result.stderr].find((entry) => entry.trim().length > 0) ?? ''
    const report = JSON.parse(raw) as AgentBrowserDoctorReport
    const failingCheck = report.checks?.find((check) => check.status === 'fail')
    if (report.success && !failingCheck) {
      return {
        ok: true,
        report,
        status: nowStatus(
          `Managed browser is ready (${report.summary?.pass ?? 0} checks passed).`,
          'ready',
        ),
      }
    }

    return {
      ok: false,
      report,
      status: nowStatus(
        failingCheck?.message
          ?? 'Managed browser doctor reported a setup problem.',
        'error',
      ),
    }
  } catch (error) {
    return {
      ok: false,
      status: nowStatus(extractErrorText(error), 'error'),
    }
  }
}

export class BrowserSessionManager {
  private readonly cli = createBrowserCli()

  constructor(private readonly options: BrowserSessionManagerOptions) {}

  getToolDefinitions(): BrowserToolDefinition[] {
    return [...BROWSER_TOOL_DEFINITIONS]
  }

  async callTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<BrowserToolCallResult> {
    if (name !== BROWSER_TOOL_NAME) {
      throw new Error(`Unknown browser tool: ${name}`)
    }

    try {
      const result = await executeAgentBrowserTool({
        sessionId,
        args,
        cli: this.cli,
        persistArtifact: this.options.persistArtifact,
      })
      await this.options.onStatus(
        nowStatus('Managed browser is ready for this session.', 'ready'),
      )
      return result
    } catch (error) {
      await this.options.onStatus(
        nowStatus(extractErrorText(error), 'error'),
      )
      throw error
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    await this.cli.execText(sessionId, ['close']).catch(() => undefined)
  }

  async shutdown(): Promise<void> {
    return
  }
}

export const __testing = {
  formatBrowserCommandFailureMessage,
  isRetryableBrowserCommandFailure,
}
