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
const DEFAULT_BROWSER_SCAN_SCROLLS = 3
const DEFAULT_BROWSER_SCAN_SCROLL_AMOUNT = 900
const DEFAULT_BROWSER_SCAN_WAIT_MS = 750
const DEFAULT_BROWSER_SCAN_MAX_STORIES = 80
const MAX_BROWSER_SCAN_SCROLLS = 8
const MAX_BROWSER_SCAN_STORIES = 200

export const BROWSER_TOOL_ACTIONS = [
  'tabs',
  'focus',
  'open',
  'navigate',
  'wait',
  'snapshot',
  'screenshot',
  'scan_page',
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

type BrowserEvaluateData = {
  origin?: string
  result?: unknown
}

type BrowserScanLink = {
  text?: string
  href?: string
  top?: number
  viewportTop?: number
  area?: number
}

type BrowserScanEvalResult = {
  url?: string
  title?: string
  scrollY?: number
  viewportHeight?: number
  documentHeight?: number
  links?: BrowserScanLink[]
}

type BrowserScanStory = {
  text: string
  href?: string
  firstSeenStep: number
  sightings: number
}

type BrowserScanStepSummary = {
  index: number
  scrollY?: number
  viewportHeight?: number
  documentHeight?: number
  screenshotPath?: string
  storyCount: number
  newStoryCount: number
  errors?: string[]
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
      'Use scan_page for news homepages, feeds, and long pages where scrolling plus multiple screenshots can reveal more stories than the first viewport.',
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
        scrolls: { type: 'number' },
        scrollAmount: { type: 'number' },
        maxStories: { type: 'number' },
        captureScreenshots: { type: 'boolean' },
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

function readSnapshotText(data: BrowserSnapshotData | undefined): string {
  return typeof data?.snapshot === 'string' ? data.snapshot.trim() : ''
}

function normalizeSnapshotText(data: BrowserSnapshotData | undefined): string {
  const snapshot = typeof data?.snapshot === 'string' ? data.snapshot.trim() : ''
  if (snapshot.length === 0) {
    return '(no browser snapshot text returned)'
  }

  return snapshot.replace(/\bref=(e\d+)\b/g, 'ref=@$1')
}

function normalizeEvaluateArgs(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isBareEvaluateFunction(source: string): boolean {
  return /^(?:async\s+)?(?:\([^()]*\)|[$A-Z_a-z][$\w]*)\s*=>/s.test(source)
    || /^(?:async\s+)?function(?:\s+[$A-Z_a-z][$\w]*)?\s*\(/s.test(source)
}

function buildEvaluateScript(functionSource: string, args: unknown): string {
  const trimmed = functionSource.trim()
  if (!isBareEvaluateFunction(trimmed)) {
    return trimmed
  }

  return `(${trimmed})(...${JSON.stringify(normalizeEvaluateArgs(args))})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeStoryText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : ''
}

function normalizeStoryHref(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function getStoryKey(story: { text: string; href?: string }): string {
  return story.href ?? story.text.toLowerCase()
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBrowserScanEvalResult(data: BrowserEvaluateData | undefined): BrowserScanEvalResult {
  const result = data?.result
  if (!isRecord(result)) {
    return {}
  }

  const links = Array.isArray(result.links)
    ? result.links
      .filter(isRecord)
      .map((link) => ({
        text: normalizeStoryText(link.text),
        href: normalizeStoryHref(link.href),
        top: readNumber(link.top),
        viewportTop: readNumber(link.viewportTop),
        area: readNumber(link.area),
      }))
      .filter((link) => link.text.length > 0 || link.href)
    : []

  return {
    url: normalizeStoryHref(result.url),
    title: normalizeStoryText(result.title),
    scrollY: readNumber(result.scrollY),
    viewportHeight: readNumber(result.viewportHeight),
    documentHeight: readNumber(result.documentHeight),
    links,
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return String(error)
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
    case 'scan_page':
      return 'Scanned the browser page.'
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

const SCAN_PAGE_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const documentHeight = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0
  );
  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => {
      const rect = anchor.getBoundingClientRect();
      const visible =
        rect.bottom > 0
        && rect.top < viewportHeight
        && rect.right > 0
        && rect.left < viewportWidth;
      const imageAlt = anchor.querySelector("img")?.getAttribute("alt") || "";
      const text = normalize(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || imageAlt);
      const rawHref = anchor.getAttribute("href") || "";
      let href = rawHref;
      try {
        href = new URL(rawHref, document.baseURI).href;
      } catch {
        href = rawHref;
      }
      return {
        text,
        href,
        visible,
        top: Math.round(rect.top + window.scrollY),
        viewportTop: Math.round(rect.top),
        area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
      };
    })
    .filter((link) => link.visible && link.href && link.text.length >= 24)
    .sort((a, b) => a.viewportTop - b.viewportTop || b.area - a.area)
    .slice(0, 120);

  return {
    url: window.location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    viewportHeight,
    documentHeight,
    links,
  };
})()`

function resolveScanPageOptions(args: Record<string, unknown>): {
  scrolls: number
  scrollAmount: number
  waitMs: number
  maxStories: number
  captureScreenshots: boolean
  maxChars: number
} {
  return {
    scrolls: clampInteger(args.scrolls, DEFAULT_BROWSER_SCAN_SCROLLS, 0, MAX_BROWSER_SCAN_SCROLLS),
    scrollAmount: clampInteger(args.scrollAmount, DEFAULT_BROWSER_SCAN_SCROLL_AMOUNT, 100, 3000),
    waitMs: clampInteger(args.waitMs, DEFAULT_BROWSER_SCAN_WAIT_MS, 0, 5000),
    maxStories: clampInteger(args.maxStories, DEFAULT_BROWSER_SCAN_MAX_STORIES, 1, MAX_BROWSER_SCAN_STORIES),
    captureScreenshots: args.captureScreenshots !== false,
    maxChars: clampInteger(args.maxChars, DEFAULT_BROWSER_SNAPSHOT_INLINE_TEXT_CHARS, 400, MAX_BROWSER_INLINE_TEXT_CHARS),
  }
}

async function captureScanStep(input: {
  cli: BrowserCliLike
  sessionId: string
  stepIndex: number
  captureScreenshots: boolean
  seenStories: Map<string, BrowserScanStory>
  maxStories: number
}): Promise<BrowserScanStepSummary> {
  const errors: string[] = []
  let screenshotPath: string | undefined

  if (input.captureScreenshots) {
    try {
      const screenshot = await input.cli.execJson<BrowserScreenshotData>(input.sessionId, ['screenshot'])
      screenshotPath = normalizeStoryHref(screenshot.data?.path)
    } catch (error) {
      errors.push(`screenshot: ${extractErrorMessage(error)}`)
    }
  }

  let scanResult: BrowserScanEvalResult = {}
  try {
    const evaluated = await input.cli.execJson<BrowserEvaluateData>(input.sessionId, ['eval', SCAN_PAGE_SCRIPT])
    scanResult = readBrowserScanEvalResult(evaluated.data)
  } catch (error) {
    errors.push(`extract: ${extractErrorMessage(error)}`)
  }

  const links = (scanResult.links ?? [])
    .map((link) => ({
      text: normalizeStoryText(link.text),
      href: normalizeStoryHref(link.href),
    }))
    .filter((link) => link.text.length > 0)

  let newStoryCount = 0
  for (const link of links) {
    if (input.seenStories.size >= input.maxStories) {
      break
    }

    const key = getStoryKey(link)
    const existing = input.seenStories.get(key)
    if (existing) {
      existing.sightings += 1
      continue
    }

    input.seenStories.set(key, {
      text: link.text,
      href: link.href,
      firstSeenStep: input.stepIndex,
      sightings: 1,
    })
    newStoryCount += 1
  }

  return {
    index: input.stepIndex,
    scrollY: scanResult.scrollY,
    viewportHeight: scanResult.viewportHeight,
    documentHeight: scanResult.documentHeight,
    screenshotPath,
    storyCount: links.length,
    newStoryCount,
    ...(errors.length > 0 ? { errors } : {}),
  }
}

function formatBrowserScanResult(input: {
  steps: BrowserScanStepSummary[]
  stories: BrowserScanStory[]
  scrolls: number
  scrollAmount: number
  waitMs: number
}): string {
  const screenshotCount = input.steps.filter((step) => step.screenshotPath).length
  const firstViewportStoryCount = input.steps[0]?.newStoryCount ?? 0
  const addedAfterFirstViewport = Math.max(0, input.stories.length - firstViewportStoryCount)
  const lines = [
    `Scanned ${input.steps.length} viewport${input.steps.length === 1 ? '' : 's'} (${input.scrolls} requested scroll${input.scrolls === 1 ? '' : 's'}, ${input.scrollAmount}px each, ${input.waitMs}ms wait).`,
    `Captured ${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}.`,
    `Found ${input.stories.length} unique story link${input.stories.length === 1 ? '' : 's'}; first viewport had ${firstViewportStoryCount}, scrolling added ${addedAfterFirstViewport}.`,
  ]

  const warnings = input.steps
    .filter((step) => step.errors && step.errors.length > 0)
    .map((step) => `Step ${step.index}: ${step.errors?.join('; ')}`)
  if (warnings.length > 0) {
    lines.push('', 'Warnings:', ...warnings.map((warning) => `- ${warning}`))
  }

  const screenshotLines = input.steps
    .filter((step) => step.screenshotPath)
    .map((step) => `- Step ${step.index}: ${step.screenshotPath}`)
  if (screenshotLines.length > 0) {
    lines.push('', 'Screenshots:', ...screenshotLines)
  }

  if (input.stories.length > 0) {
    lines.push(
      '',
      'Story links:',
      ...input.stories.slice(0, 40).map((story, index) =>
        `${index + 1}. ${story.text}${story.href ? ` — ${story.href}` : ''} (first seen step ${story.firstSeenStep})`,
      ),
    )
  }

  return lines.join('\n')
}

async function runBrowserPageScan(input: {
  sessionId: string
  args: Record<string, unknown>
  cli: BrowserCliLike
  persistArtifact?: BrowserSessionManagerOptions['persistArtifact']
}): Promise<BrowserToolCallResult> {
  await selectTabIfNeeded(input.cli, input.sessionId, input.args.tabId)
  const options = resolveScanPageOptions(input.args)
  const seenStories = new Map<string, BrowserScanStory>()
  const steps: BrowserScanStepSummary[] = []

  for (let stepIndex = 0; stepIndex <= options.scrolls; stepIndex += 1) {
    const stepErrors: string[] = []
    if (stepIndex > 0) {
      try {
        await input.cli.execJson(input.sessionId, ['scroll', 'down', String(options.scrollAmount)])
      } catch (error) {
        stepErrors.push(`scroll: ${extractErrorMessage(error)}`)
      }

      if (options.waitMs > 0) {
        try {
          await input.cli.execJson(input.sessionId, ['wait', String(options.waitMs)])
        } catch (error) {
          stepErrors.push(`wait: ${extractErrorMessage(error)}`)
        }
      }
    }

    const step = await captureScanStep({
      cli: input.cli,
      sessionId: input.sessionId,
      stepIndex,
      captureScreenshots: options.captureScreenshots,
      seenStories,
      maxStories: options.maxStories,
    })
    steps.push({
      ...step,
      ...(stepErrors.length > 0 || step.errors
        ? { errors: [...stepErrors, ...(step.errors ?? [])] }
        : {}),
    })
  }

  const stories = [...seenStories.values()]
  const text = formatBrowserScanResult({
    steps,
    stories,
    scrolls: options.scrolls,
    scrollAmount: options.scrollAmount,
    waitMs: options.waitMs,
  })
  const firstViewportStoryCount = steps[0]?.newStoryCount ?? 0

  return await finalizeBrowserTextResult({
    sessionId: input.sessionId,
    action: 'scan_page',
    text,
    maxChars: options.maxChars,
    persistArtifact: input.persistArtifact,
    metadata: {
      scrolls: options.scrolls,
      scrollAmount: options.scrollAmount,
      waitMs: options.waitMs,
      captureScreenshots: options.captureScreenshots,
      screenshotCount: steps.filter((step) => step.screenshotPath).length,
      firstViewportStoryCount,
      uniqueStoryCount: stories.length,
      addedAfterFirstViewport: Math.max(0, stories.length - firstViewportStoryCount),
      steps,
      stories,
    },
    lead: buildLead('scan_page'),
  })
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
      let envelope = await input.cli.execJson<BrowserSnapshotData>(input.sessionId, ['snapshot'])
      let snapshotMode: 'interactive' | 'full' = 'full'

      if (readSnapshotText(envelope.data).length === 0) {
        const interactiveEnvelope = await input.cli.execJson<BrowserSnapshotData>(input.sessionId, ['snapshot', '-i'])
        if (readSnapshotText(interactiveEnvelope.data).length > 0) {
          envelope = interactiveEnvelope
          snapshotMode = 'interactive'
        }
      }

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
          snapshotMode,
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
    case 'scan_page': {
      return await runBrowserPageScan(input)
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
      const script = buildEvaluateScript(fn, input.args.args)
      const envelope = await input.cli.execJson<BrowserEvaluateData>(input.sessionId, ['eval', script])
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
  buildEvaluateScript,
  formatBrowserCommandFailureMessage,
  isRetryableBrowserCommandFailure,
}
