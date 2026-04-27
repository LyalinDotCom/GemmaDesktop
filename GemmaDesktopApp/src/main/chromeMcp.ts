import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CompatibilityCallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  CHROME_DEVTOOLS_TOOL_NAME,
  type SupportedSessionToolPlatform,
} from '../shared/sessionTools'

const CHROME_MCP_PACKAGE = 'chrome-devtools-mcp@0.21.0'
export const DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS = 30_000
export const DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS = 30_000
export const CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS = 5_000
export const CHROME_MCP_ATTACH_READY_WINDOW_MS = 8_000
export const CHROME_MCP_ATTACH_READY_POLL_MS = 200
export const CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS = 1_000

type JsonSchema = Record<string, unknown>
type ChromeMcpClientLike = Pick<Client, 'connect' | 'listTools' | 'callTool' | 'close'>
type ChromeMcpTransportLike = Pick<StdioClientTransport, 'close' | 'stderr'> & {
  pid: number | null
}
type ChromeMcpTextPage = {
  id: number
  url?: string
  selected?: boolean
}
type ChromeMcpSnapshotNode = {
  id?: string
  role?: string
  name?: string
  value?: string | number | boolean
  description?: string
  children?: ChromeMcpSnapshotNode[]
}
type PersistedChromeArtifact = {
  path: string
  fileUrl: string
}

export interface ChromeMcpToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface ChromeMcpStatusRecord {
  state: 'idle' | 'ready' | 'error'
  message: string
  checkedAt: number
}

export interface NormalizedToolContent {
  type: string
  [key: string]: unknown
}

export interface NormalizedToolResult {
  content: NormalizedToolContent[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export interface ChromeMcpSessionManagerOptions {
  disableUsageStatistics: boolean
  disablePerformanceCrux: boolean
  onStatus: (status: ChromeMcpStatusRecord) => Promise<void> | void
  onLog?: (sessionId: string, line: string) => void
  persistArtifact?: (input: {
    sessionId: string
    action: string
    text: string
    metadata?: Record<string, unknown>
    extension?: 'md' | 'txt'
  }) => Promise<PersistedChromeArtifact>
}

export interface ChromeMcpServiceDependencies {
  createTransport?: (options: ChromeMcpSessionManagerOptions) => ChromeMcpTransportLike
  createClient?: () => ChromeMcpClientLike
  sleep?: (ms: number) => Promise<void>
}

interface ChromeMcpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<NormalizedToolResult>
}

type BrowserToolCallResult = {
  output: string
  structuredOutput?: Record<string, unknown>
}

const BASE_CONNECTION_ERROR = [
  'Chrome DevTools MCP could not attach to your live Chrome session.',
  'Make sure Chrome is already running, then open chrome://inspect/#remote-debugging and allow incoming debugging connections once.',
  'After that, retry the browser action.',
].join(' ')

export const CHROME_BROWSER_ACTIONS = [
  'tabs',
  'focus',
  'open',
  'navigate',
  'wait',
  'snapshot',
  'screenshot',
  'console',
  'network',
  'click',
  'fill',
  'type',
  'press',
  'close',
  'dialog',
  'evaluate',
] as const
export type ChromeBrowserAction = (typeof CHROME_BROWSER_ACTIONS)[number]

export const CHROME_DEVTOOLS_MUTATING_ACTIONS = [
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

const CHROME_BROWSER_ACTION_SET = new Set<string>(CHROME_BROWSER_ACTIONS)
const CHROME_BROWSER_MUTATING_ACTION_SET = new Set<string>(
  CHROME_DEVTOOLS_MUTATING_ACTIONS,
)
const DEFAULT_BROWSER_INLINE_TEXT_CHARS = 4_000
const DEFAULT_BROWSER_SNAPSHOT_INLINE_TEXT_CHARS = 6_000
const MAX_BROWSER_INLINE_TEXT_CHARS = 12_000
const DEFAULT_BROWSER_DETAIL_FILE_EXTENSION = 'md'
const SNAPSHOT_STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'section',
  'none',
  'presentation',
  'list',
  'listitem',
])

const NAVIGATION_TOOL_NAMES = new Set(['new_page', 'navigate_page'])
const PAGE_METADATA_TOOL_NAMES = new Set(['list_pages', 'new_page'])
const CHROME_TRANSPORT_ERROR_PATTERNS = [
  /socket connection was closed unexpectedly/i,
  /\bconnection (?:closed|reset)\b/i,
  /\btransport\b.*\bclosed\b/i,
  /\btarget closed\b/i,
  /\bbroken pipe\b/i,
  /\beconnreset\b/i,
] as const
const IGNORED_CHROME_MCP_LOG_PATTERNS = [
  /^No handler registered for issue code PerformanceIssue$/i,
] as const

const RAW_TOOL_DEFINITIONS: readonly ChromeMcpToolDefinition[] = [
  {
    name: 'list_pages',
    description: 'Get a list of pages open in the browser.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'select_page',
    description: 'Select an open page as the context for future tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number' },
        bringToFront: { type: 'boolean' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_page',
    description: 'Open a new tab and load a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        background: { type: 'boolean' },
        isolatedContext: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate_page',
    description: 'Navigate the selected page to a URL or move through its history.',
    inputSchema: {
      type: 'object',
      properties: {
        handleBeforeUnload: {
          type: 'string',
          enum: ['accept', 'decline'],
        },
        ignoreCache: { type: 'boolean' },
        initScript: { type: 'string' },
        timeout: { type: 'number' },
        type: {
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload'],
        },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for one of the supplied texts to appear on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'array',
          items: { type: 'string' },
        },
        timeout: { type: 'number' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'take_snapshot',
    description: 'Capture a structured snapshot of the selected page.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'] },
        fullPage: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_console_messages',
    description: 'List console messages from the selected page.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_console_message',
    description: 'Get one console message by index from the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number' },
      },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_network_requests',
    description: 'List recent network requests from the selected page.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_network_request',
    description: 'Get one network request by index from the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number' },
      },
      required: ['index'],
      additionalProperties: false,
    },
  },
  {
    name: 'evaluate_script',
    description: 'Run a JavaScript function on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string' },
        args: {
          type: 'array',
          items: {},
        },
      },
      required: ['function'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click the provided element from the current page snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        dblClick: { type: 'boolean' },
        includeSnapshot: { type: 'boolean' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Fill an input, textarea, or select element on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        value: { type: 'string' },
        includeSnapshot: { type: 'boolean' },
      },
      required: ['uid', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Type text using the keyboard into a previously focused input.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        submitKey: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or key combination on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        includeSnapshot: { type: 'boolean' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_page',
    description: 'Close an open page by page id.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss an open browser dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss'],
        },
        promptText: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
] as const

const RAW_CHROME_MCP_TOOL_NAME_SET = new Set<string>(
  RAW_TOOL_DEFINITIONS.map((tool) => tool.name),
)

const BROWSER_TOOL_DEFINITIONS: readonly ChromeMcpToolDefinition[] = [
  {
    name: CHROME_DEVTOOLS_TOOL_NAME,
    description: [
      'Safely control the user\'s live Chrome session through a single high-level Chrome DevTools tool.',
      'Use it to list tabs, focus a specific tab, open a URL in a new tab, navigate the selected tab, wait for text, read page snapshots, take screenshots, inspect console or network activity, click, fill, type, press keys, handle dialogs, close tabs, or run page scripts when needed.',
      'Prefer it for advanced debugging, console or network inspection, page evaluation, or when the user explicitly asks for Chrome DevTools.',
      'Pass pageId when you want to target a specific tab.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...CHROME_BROWSER_ACTIONS],
        },
        pageId: { type: 'number' },
        url: { type: 'string' },
        background: { type: 'boolean' },
        bringToFront: { type: 'boolean' },
        navigation: {
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload'],
        },
        timeout: { type: 'number' },
        waitForText: {
          type: 'array',
          items: { type: 'string' },
        },
        maxChars: { type: 'number' },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
        },
        fullPage: { type: 'boolean' },
        index: { type: 'number' },
        uid: { type: 'string' },
        dblClick: { type: 'boolean' },
        value: { type: 'string' },
        inputText: { type: 'string' },
        submitKey: { type: 'string' },
        key: { type: 'string' },
        includeSnapshot: { type: 'boolean' },
        dialogAction: {
          type: 'string',
          enum: ['accept', 'dismiss'],
        },
        promptText: { type: 'string' },
        ignoreCache: { type: 'boolean' },
        handleBeforeUnload: {
          type: 'string',
          enum: ['accept', 'decline'],
        },
        initScript: { type: 'string' },
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

export class ChromeMcpService {
  private client: ChromeMcpClientLike | null = null
  private transport: ChromeMcpTransportLike | null = null
  private availableToolNames = new Set<string>()
  private connectPromise: Promise<void> | null = null

  constructor(
    private readonly sessionId: string,
    private readonly options: ChromeMcpSessionManagerOptions,
    private readonly deps: ChromeMcpServiceDependencies = {},
  ) {}

  async ensureConnected(): Promise<void> {
    if (this.client && this.transport?.pid !== null) {
      return
    }

    if (!this.connectPromise) {
      const connectPromise = this.connectInternal()
      this.connectPromise = connectPromise.finally(() => {
        if (this.connectPromise === connectPromise) {
          this.connectPromise = null
        }
      })
    }

    await this.connectPromise
  }

  async disconnect(): Promise<void> {
    this.availableToolNames.clear()
    this.connectPromise = null
    await disposeChromeConnection(this.client, this.transport)
    this.client = null
    this.transport = null
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<NormalizedToolResult> {
    await this.ensureConnected()

    if (!this.client || !this.availableToolNames.has(name)) {
      throw new Error(`Chrome tool "${name}" is not available in this session.`)
    }

    try {
      return await invokeChromeClientTool(
        this.client,
        name,
        args,
        resolveChromeToolRequestOptions(name, args),
      )
    } catch (error) {
      if (isChromeMcpTransportError(error)) {
        await this.disconnect()
      }
      throw error
    }
  }

  private async connectInternal(): Promise<void> {
    this.availableToolNames.clear()
    await disposeChromeConnection(this.client, this.transport)
    this.client = null
    this.transport = null

    const transport = this.deps.createTransport?.(this.options) ?? new StdioClientTransport({
      command: 'npx',
      args: buildChromeMcpArgs(this.options),
      stderr: 'pipe',
    })

    transport.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (
          trimmed.length > 0
          && !IGNORED_CHROME_MCP_LOG_PATTERNS.some((pattern) => pattern.test(trimmed))
        ) {
          this.options.onLog?.(this.sessionId, trimmed)
        }
      }
    })

    const client = this.deps.createClient?.() ?? new Client({
      name: 'gemma-desktop-app-chrome-mcp',
      version: '0.1.0',
    })

    try {
      await client.connect(transport as StdioClientTransport)
      const listed = await client.listTools()
      const availableToolNames = new Set(
        listed.tools
          .map((tool) => tool.name)
          .filter((toolName) => RAW_CHROME_MCP_TOOL_NAME_SET.has(toolName)),
      )

      if (!availableToolNames.has('list_pages')) {
        throw new Error('Chrome MCP server did not expose the expected navigation tools.')
      }

      await waitForChromeAttachReady({
        callListPages: (requestOptions) =>
          invokeChromeClientTool(client, 'list_pages', {}, requestOptions),
        sleep: this.deps.sleep,
      })

      this.availableToolNames = availableToolNames
      this.client = client
      this.transport = transport
    } catch (error) {
      await disposeChromeConnection(client, transport)
      this.availableToolNames.clear()
      this.client = null
      this.transport = null
      throw new Error(formatChromeConnectionError(error), { cause: error })
    }
  }
}

export function isChromeBrowserActionName(value: unknown): value is ChromeBrowserAction {
  return typeof value === 'string' && CHROME_BROWSER_ACTION_SET.has(value)
}

export function isChromeBrowserMutatingActionName(value: unknown): boolean {
  return typeof value === 'string' && CHROME_BROWSER_MUTATING_ACTION_SET.has(value)
}

function readChromePages(
  structuredOutput: Record<string, unknown> | undefined,
): ChromeMcpTextPage[] {
  if (!structuredOutput) {
    return []
  }

  const directPages = structuredOutput.pages
  if (Array.isArray(directPages)) {
    return directPages.flatMap((entry) => normalizeChromePageRecord(entry))
  }

  if (isRecord(directPages) && Array.isArray(directPages.pages)) {
    return directPages.pages.flatMap((entry) => normalizeChromePageRecord(entry))
  }

  return []
}

function normalizeChromePageRecord(entry: unknown): ChromeMcpTextPage[] {
  if (!isRecord(entry) || typeof entry.id !== 'number') {
    return []
  }

  return [{
    id: entry.id,
    url: typeof entry.url === 'string' ? entry.url : undefined,
    selected: entry.selected === true,
  }]
}

function formatChromePages(pages: ChromeMcpTextPage[]): string {
  if (pages.length === 0) {
    return 'No open Chrome tabs were reported.'
  }

  return pages
    .map((page) =>
      `${page.id}: ${page.url ?? 'about:blank'}${page.selected ? ' [selected]' : ''}`,
    )
    .join('\n')
}

function pruneUndefinedRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function coercePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : undefined
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

function normalizeSnapshotNode(value: unknown): ChromeMcpSnapshotNode | null {
  if (!isRecord(value)) {
    return null
  }

  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    role: typeof value.role === 'string' ? value.role : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    value:
      typeof value.value === 'string'
      || typeof value.value === 'number'
      || typeof value.value === 'boolean'
        ? value.value
        : undefined,
    description: typeof value.description === 'string' ? value.description : undefined,
    children: Array.isArray(value.children)
      ? value.children
          .map((entry) => normalizeSnapshotNode(entry))
          .filter((entry): entry is ChromeMcpSnapshotNode => entry !== null)
      : undefined,
  }
}

function shouldIncludeSnapshotNode(node: ChromeMcpSnapshotNode): boolean {
  if (node.id || node.name || node.value !== undefined || node.description) {
    return true
  }

  const role = (node.role ?? '').trim().toLowerCase()
  return role.length > 0 && !SNAPSHOT_STRUCTURAL_ROLES.has(role)
}

function escapeSnapshotValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function buildCompactSnapshotText(
  root: ChromeMcpSnapshotNode,
): string {
  const lines: string[] = []

  const visit = (node: ChromeMcpSnapshotNode, depth: number) => {
    if (shouldIncludeSnapshotNode(node)) {
      const role = (node.role ?? 'node').trim().toLowerCase() || 'node'
      let line = `${'  '.repeat(depth)}- ${role}`

      if (node.name) {
        line += ` "${escapeSnapshotValue(node.name)}"`
      }

      if (node.id) {
        line += ` [uid=${node.id}]`
      }

      if (node.value !== undefined) {
        line += ` value="${escapeSnapshotValue(String(node.value))}"`
      }

      if (node.description) {
        line += ` description="${escapeSnapshotValue(node.description)}"`
      }

      lines.push(line)
    }

    for (const child of node.children ?? []) {
      visit(child, depth + 1)
    }
  }

  visit(root, 0)
  return lines.join('\n').trim()
}

function extractSnapshotText(
  result: BrowserToolCallResult,
): string {
  const structuredSnapshot = normalizeSnapshotNode(result.structuredOutput?.snapshot)
  if (structuredSnapshot) {
    const compact = buildCompactSnapshotText(structuredSnapshot)
    if (compact.length > 0) {
      return compact
    }
  }

  return result.output.trim()
}

async function finalizeBrowserTextResult(input: {
  sessionId: string
  action: ChromeBrowserAction
  text: string
  maxChars: number
  persistArtifact?: ChromeMcpSessionManagerOptions['persistArtifact']
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
  let artifact: PersistedChromeArtifact | null = null

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
    structuredOutput: pruneUndefinedRecord({
      action: input.action,
      truncated: truncated.truncated || undefined,
      originalChars: truncated.truncated ? truncated.originalChars : undefined,
      artifactPath: artifact?.path,
      artifactFileUrl: artifact?.fileUrl,
      ...(input.metadata ?? {}),
    }),
  }
}

async function selectChromePageIfNeeded(input: {
  args: Record<string, unknown>
  callRawTool: (name: string, args: Record<string, unknown>) => Promise<BrowserToolCallResult>
}): Promise<number | undefined> {
  const pageId = typeof input.args.pageId === 'number' ? input.args.pageId : undefined
  if (!pageId) {
    return undefined
  }

  await input.callRawTool('select_page', pruneUndefinedRecord({
    pageId,
    bringToFront:
      typeof input.args.bringToFront === 'boolean' ? input.args.bringToFront : undefined,
  }))
  return pageId
}

async function resolveChromeTargetPageId(input: {
  args: Record<string, unknown>
  callRawTool: (name: string, args: Record<string, unknown>) => Promise<BrowserToolCallResult>
}): Promise<number> {
  const explicitPageId = await selectChromePageIfNeeded(input)
  if (explicitPageId) {
    return explicitPageId
  }

  const tabs = await input.callRawTool('list_pages', {})
  const pages = readChromePages(tabs.structuredOutput)
  const selectedPage = pages.find((page) => page.selected) ?? pages[0]
  if (!selectedPage) {
    throw new Error(
      'Browser action "navigate" requires an existing Chrome tab, but no pages were available.',
    )
  }

  return selectedPage.id
}

function buildBrowserLead(action: ChromeBrowserAction, detail?: string): string {
  const suffix = detail?.trim()
  switch (action) {
    case 'tabs':
      return 'Current Chrome tabs:'
    case 'focus':
      return suffix ? `Selected Chrome tab ${suffix}.` : 'Selected the requested Chrome tab.'
    case 'open':
      return suffix ? `Opened a new Chrome tab for ${suffix}.` : 'Opened a new Chrome tab.'
    case 'navigate':
      return suffix
        ? `Updated the targeted Chrome tab to ${suffix}.`
        : 'Updated the targeted Chrome tab.'
    case 'wait':
      return 'Wait condition satisfied in Chrome.'
    case 'snapshot':
      return 'Captured a Chrome page snapshot.'
    case 'screenshot':
      return 'Captured a Chrome page screenshot.'
    case 'console':
      return 'Chrome console inspection result:'
    case 'network':
      return 'Chrome network inspection result:'
    case 'click':
      return 'Completed the requested Chrome click.'
    case 'fill':
      return 'Filled the requested Chrome form field.'
    case 'type':
      return 'Typed into the focused Chrome field.'
    case 'press':
      return 'Sent keyboard input to Chrome.'
    case 'close':
      return suffix ? `Closed Chrome tab ${suffix}.` : 'Closed the requested Chrome tab.'
    case 'dialog':
      return 'Handled the Chrome dialog.'
    case 'evaluate':
      return 'Ran the requested Chrome page script.'
  }
}

function appendBrowserDetailSections(
  lead: string,
  detail: string | null,
  pages: ChromeMcpTextPage[],
): string {
  return [
    lead,
    pages.length > 0 ? formatChromePages(pages) : detail,
  ]
    .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
    .join('\n\n')
}

export async function executeChromeBrowserTool(input: {
  sessionId: string
  args: Record<string, unknown>
  callRawTool: (name: string, args: Record<string, unknown>) => Promise<BrowserToolCallResult>
  persistArtifact?: ChromeMcpSessionManagerOptions['persistArtifact']
}): Promise<BrowserToolCallResult> {
  const action = input.args.action
  if (!isChromeBrowserActionName(action)) {
    throw new Error(
      `Browser action is required and must be one of ${CHROME_BROWSER_ACTIONS.join(', ')}.`,
    )
  }

  switch (action) {
    case 'tabs': {
      const result = await input.callRawTool('list_pages', {})
      const pages = readChromePages(result.structuredOutput)
      return {
        output: `${buildBrowserLead(action)}\n${formatChromePages(pages)}`,
        structuredOutput: {
          action,
          pages,
        },
      }
    }
    case 'focus': {
      const pageId = typeof input.args.pageId === 'number' ? input.args.pageId : undefined
      if (!pageId) {
        throw new Error('Browser action "focus" requires pageId.')
      }

      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const tabs = await input.callRawTool('list_pages', {})
      const pages = readChromePages(tabs.structuredOutput)
      return {
        output: `${buildBrowserLead(action, String(pageId))}\n\n${formatChromePages(pages)}`,
        structuredOutput: {
          action,
          pageId,
          pages,
        },
      }
    }
    case 'open': {
      const url = typeof input.args.url === 'string' ? input.args.url.trim() : ''
      if (!url) {
        throw new Error('Browser action "open" requires url.')
      }

      const result = await input.callRawTool('new_page', pruneUndefinedRecord({
        url,
        background: typeof input.args.background === 'boolean' ? input.args.background : undefined,
        timeout: typeof input.args.timeout === 'number' ? input.args.timeout : undefined,
      }))
      const pages = readChromePages(result.structuredOutput)
      const openedPage = pages.find((page) => page.selected) ?? pages.at(-1)
      return {
        output: appendBrowserDetailSections(
          buildBrowserLead(action, url),
          result.output.trim().length > 0 ? result.output.trim() : null,
          pages,
        ),
        structuredOutput: pruneUndefinedRecord({
          action,
          url,
          pageId: openedPage?.id,
          pages: pages.length > 0 ? pages : undefined,
        }),
      }
    }
    case 'navigate': {
      const pageId = await resolveChromeTargetPageId({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const url = typeof input.args.url === 'string' ? input.args.url.trim() : undefined
      const navigation =
        typeof input.args.navigation === 'string' && input.args.navigation.length > 0
          ? input.args.navigation
          : url
            ? 'url'
            : undefined

      if (!navigation) {
        throw new Error(
          'Browser action "navigate" requires navigation or url.',
        )
      }

      if (navigation === 'url' && !url) {
        throw new Error('Browser action "navigate" requires url when navigation="url".')
      }

      const result = await input.callRawTool('navigate_page', pruneUndefinedRecord({
        pageId,
        type: navigation,
        url,
        timeout: typeof input.args.timeout === 'number' ? input.args.timeout : undefined,
        ignoreCache:
          typeof input.args.ignoreCache === 'boolean' ? input.args.ignoreCache : undefined,
        handleBeforeUnload:
          typeof input.args.handleBeforeUnload === 'string'
            ? input.args.handleBeforeUnload
            : undefined,
        initScript:
          typeof input.args.initScript === 'string' ? input.args.initScript : undefined,
      }))
      const pages = readChromePages(result.structuredOutput)
      return {
        output: appendBrowserDetailSections(
          buildBrowserLead(action, url ?? navigation),
          result.output.trim().length > 0 ? result.output.trim() : null,
          pages,
        ),
        structuredOutput: pruneUndefinedRecord({
          action,
          pageId,
          url,
          navigation,
          pages: pages.length > 0 ? pages : undefined,
        }),
      }
    }
    case 'wait': {
      const waitForText = Array.isArray(input.args.waitForText)
        ? input.args.waitForText.filter(
            (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
          )
        : []
      if (waitForText.length === 0) {
        throw new Error('Browser action "wait" requires waitForText.')
      }

      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const result = await input.callRawTool('wait_for', pruneUndefinedRecord({
        text: waitForText,
        timeout: typeof input.args.timeout === 'number' ? input.args.timeout : undefined,
      }))

      return {
        output: [
          buildBrowserLead(action),
          result.output.trim().length > 0 ? result.output.trim() : null,
        ]
          .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
          .join('\n\n'),
        structuredOutput: {
          action,
          waitForText,
        },
      }
    }
    case 'snapshot': {
      const pageId = await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const result = await input.callRawTool('take_snapshot', {})
      const snapshotText = extractSnapshotText(result)
      const maxChars =
        coercePositiveInteger(input.args.maxChars) ?? DEFAULT_BROWSER_SNAPSHOT_INLINE_TEXT_CHARS

      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: snapshotText,
        maxChars,
        persistArtifact: input.persistArtifact,
        metadata: pruneUndefinedRecord({
          pageId,
        }),
        lead: buildBrowserLead(action),
      })
    }
    case 'screenshot': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const result = await input.callRawTool('take_screenshot', pruneUndefinedRecord({
        format: typeof input.args.format === 'string' ? input.args.format : undefined,
        fullPage: typeof input.args.fullPage === 'boolean' ? input.args.fullPage : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        lead: buildBrowserLead(action),
      })
    }
    case 'console':
    case 'network': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const index = typeof input.args.index === 'number' ? input.args.index : undefined
      const rawToolName =
        action === 'console'
          ? index !== undefined
            ? 'get_console_message'
            : 'list_console_messages'
          : index !== undefined
            ? 'get_network_request'
            : 'list_network_requests'
      const rawArgs = index !== undefined ? { index } : {}
      const result = await input.callRawTool(rawToolName, rawArgs)
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: coercePositiveInteger(input.args.maxChars) ?? DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        metadata: pruneUndefinedRecord({ index }),
        lead: buildBrowserLead(action),
      })
    }
    case 'click': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const uid = typeof input.args.uid === 'string' ? input.args.uid.trim() : ''
      if (!uid) {
        throw new Error('Browser action "click" requires uid.')
      }

      const result = await input.callRawTool('click', pruneUndefinedRecord({
        uid,
        dblClick: typeof input.args.dblClick === 'boolean' ? input.args.dblClick : undefined,
        includeSnapshot:
          typeof input.args.includeSnapshot === 'boolean'
            ? input.args.includeSnapshot
            : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        metadata: { uid },
        lead: buildBrowserLead(action),
      })
    }
    case 'fill': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const uid = typeof input.args.uid === 'string' ? input.args.uid.trim() : ''
      if (!uid) {
        throw new Error('Browser action "fill" requires uid.')
      }
      if (typeof input.args.value !== 'string') {
        throw new Error('Browser action "fill" requires value.')
      }

      const result = await input.callRawTool('fill', pruneUndefinedRecord({
        uid,
        value: input.args.value,
        includeSnapshot:
          typeof input.args.includeSnapshot === 'boolean'
            ? input.args.includeSnapshot
            : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        metadata: { uid },
        lead: buildBrowserLead(action),
      })
    }
    case 'type': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const inputText =
        typeof input.args.inputText === 'string' ? input.args.inputText : undefined
      if (!inputText) {
        throw new Error('Browser action "type" requires inputText.')
      }

      const result = await input.callRawTool('type_text', pruneUndefinedRecord({
        text: inputText,
        submitKey:
          typeof input.args.submitKey === 'string' ? input.args.submitKey : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        lead: buildBrowserLead(action),
      })
    }
    case 'press': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const key = typeof input.args.key === 'string' ? input.args.key.trim() : ''
      if (!key) {
        throw new Error('Browser action "press" requires key.')
      }

      const result = await input.callRawTool('press_key', pruneUndefinedRecord({
        key,
        includeSnapshot:
          typeof input.args.includeSnapshot === 'boolean'
            ? input.args.includeSnapshot
            : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        metadata: { key },
        lead: buildBrowserLead(action),
      })
    }
    case 'close': {
      const pageId = typeof input.args.pageId === 'number' ? input.args.pageId : undefined
      if (!pageId) {
        throw new Error('Browser action "close" requires pageId.')
      }
      const result = await input.callRawTool('close_page', { pageId })
      const pages = readChromePages(result.structuredOutput)
      return {
        output: appendBrowserDetailSections(
          buildBrowserLead(action, String(pageId)),
          result.output.trim().length > 0 ? result.output.trim() : null,
          pages,
        ),
        structuredOutput: pruneUndefinedRecord({
          action,
          pageId,
          pages: pages.length > 0 ? pages : undefined,
        }),
      }
    }
    case 'dialog': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const dialogAction =
        typeof input.args.dialogAction === 'string' ? input.args.dialogAction : undefined
      if (dialogAction !== 'accept' && dialogAction !== 'dismiss') {
        throw new Error(
          'Browser action "dialog" requires dialogAction of "accept" or "dismiss".',
        )
      }

      const result = await input.callRawTool('handle_dialog', pruneUndefinedRecord({
        action: dialogAction,
        promptText:
          typeof input.args.promptText === 'string' ? input.args.promptText : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        metadata: { dialogAction },
        lead: buildBrowserLead(action),
      })
    }
    case 'evaluate': {
      await selectChromePageIfNeeded({
        args: input.args,
        callRawTool: input.callRawTool,
      })
      const fn = typeof input.args.function === 'string' ? input.args.function : undefined
      if (!fn) {
        throw new Error('Browser action "evaluate" requires function.')
      }

      const result = await input.callRawTool('evaluate_script', pruneUndefinedRecord({
        function: fn,
        args: Array.isArray(input.args.args) ? input.args.args : undefined,
      }))
      return await finalizeBrowserTextResult({
        sessionId: input.sessionId,
        action,
        text: result.output,
        maxChars: coercePositiveInteger(input.args.maxChars) ?? DEFAULT_BROWSER_INLINE_TEXT_CHARS,
        persistArtifact: input.persistArtifact,
        lead: buildBrowserLead(action),
      })
    }
  }
}

export class ChromeMcpSessionManager {
  private readonly services = new Map<string, ChromeMcpService>()

  constructor(private readonly options: ChromeMcpSessionManagerOptions) {}

  getToolDefinitions(): ChromeMcpToolDefinition[] {
    return [...BROWSER_TOOL_DEFINITIONS]
  }

  async callTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    output: string
    structuredOutput?: Record<string, unknown>
  }> {
    if (name === CHROME_DEVTOOLS_TOOL_NAME) {
      return await executeChromeBrowserTool({
        sessionId,
        args,
        callRawTool: (rawName, rawArgs) => this.callTool(sessionId, rawName, rawArgs),
        persistArtifact: this.options.persistArtifact,
      })
    }

    const service = this.getOrCreateService(sessionId)
    const normalizedArgs = applyChromeToolArgumentDefaults(name, args)

    return await this.callRawChromeTool(service, name, normalizedArgs)
  }

  private async callRawChromeTool(
    service: ChromeMcpService,
    name: string,
    normalizedArgs: Record<string, unknown>,
  ): Promise<{
    output: string
    structuredOutput?: Record<string, unknown>
  }> {
    try {
      const result = await service.callTool(name, normalizedArgs)
      const output = collectTextBlocks(result)
      const normalizedOutput =
        output.length > 0
          ? output
          : 'Chrome tool completed without a text payload.'

      if (result.isError) {
        throw new Error(normalizedOutput)
      }

      await this.options.onStatus({
        state: 'ready',
        message: 'Chrome DevTools MCP is ready for this session.',
        checkedAt: Date.now(),
      })

      return {
        output: normalizedOutput,
        structuredOutput: result.structuredContent,
      }
    } catch (error) {
      const recovered = await recoverNavigationTimeoutResult({
        service,
        name,
        args: normalizedArgs,
        error,
      })

      if (recovered) {
        await this.options.onStatus({
          state: 'ready',
          message:
            'Chrome DevTools MCP is attached, but the last page load took longer than expected.',
          checkedAt: Date.now(),
        })

        return recovered
      }

      await this.options.onStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      })
      throw error
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const service = this.services.get(sessionId)
    if (!service) {
      return
    }

    this.services.delete(sessionId)
    await service.disconnect()
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.services.entries()).map(async ([sessionId, service]) => {
        this.services.delete(sessionId)
        await service.disconnect()
      }),
    )
  }

  private getOrCreateService(sessionId: string): ChromeMcpService {
    const existing = this.services.get(sessionId)
    if (existing) {
      return existing
    }

    const service = new ChromeMcpService(sessionId, this.options)
    this.services.set(sessionId, service)
    return service
  }
}

function buildChromeMcpArgs(
  options: ChromeMcpSessionManagerOptions,
): string[] {
  const args = [
    '-y',
    CHROME_MCP_PACKAGE,
    '--autoConnect',
    '--experimentalStructuredContent',
    '--experimental-page-id-routing',
    '--channel=stable',
  ]

  if (options.disableUsageStatistics) {
    args.push('--no-usage-statistics')
  }

  if (options.disablePerformanceCrux) {
    args.push('--no-performance-crux')
  }

  return args
}

function normalizeContentBlocks(raw: unknown): NormalizedToolContent[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== 'string') {
        return null
      }

      return entry as NormalizedToolContent
    })
    .filter((entry): entry is NormalizedToolContent => entry !== null)
}

function extractTextContent(content: NormalizedToolContent[]): string[] {
  return content
    .map((entry) => (entry.type === 'text' && typeof entry.text === 'string' ? entry.text : ''))
    .filter((entry) => entry.length > 0)
}

function extractChromePageUrl(text: string): string | undefined {
  const matches = text.match(/[a-z][a-z0-9+.-]*:[^\s]+/gi)
  const candidate = matches?.at(-1)?.trim()
  return candidate && candidate.length > 0 ? candidate : undefined
}

export function extractChromePagesFromText(text: string): ChromeMcpTextPage[] {
  const pages: ChromeMcpTextPage[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i)
    if (!match) {
      continue
    }

    const pageText = (match[2] ?? '').trim()
    pages.push({
      id: Number.parseInt(match[1] ?? '', 10),
      url: extractChromePageUrl(pageText) ?? (pageText || undefined),
      selected: Boolean(match[3]),
    })
  }

  return pages.filter((page) => Number.isFinite(page.id))
}

function enrichStructuredContentFromText(
  name: string,
  structuredContent: Record<string, unknown> | undefined,
  content: NormalizedToolContent[],
): Record<string, unknown> | undefined {
  if (!PAGE_METADATA_TOOL_NAMES.has(name)) {
    return structuredContent
  }

  if (Array.isArray(structuredContent?.pages) && structuredContent.pages.length > 0) {
    return structuredContent
  }

  const pages = extractTextContent(content)
    .flatMap((block) => extractChromePagesFromText(block))
    .map((page) => ({
      id: page.id,
      ...(page.url ? { url: page.url } : {}),
      ...(page.selected ? { selected: true } : {}),
    }))

  if (pages.length === 0) {
    return structuredContent
  }

  return {
    ...(structuredContent ?? {}),
    pages,
  }
}

async function invokeChromeClientTool(
  client: ChromeMcpClientLike,
  name: string,
  args: Record<string, unknown>,
  requestOptions?: RequestOptions,
): Promise<NormalizedToolResult> {
  const result = await client.callTool({
    name,
    arguments: args,
  }, undefined, requestOptions)

  if ('content' in result) {
    const content = normalizeContentBlocks(result.content)
    return {
      content,
      isError: typeof result.isError === 'boolean' ? result.isError : undefined,
      structuredContent: enrichStructuredContentFromText(
        name,
        isRecord(result.structuredContent)
          ? result.structuredContent
          : undefined,
        content,
      ),
    }
  }

  const compatibility = result as CompatibilityCallToolResult
  const content: NormalizedToolContent[] = [
    {
      type: 'text',
      text:
        typeof compatibility.toolResult === 'string'
          ? compatibility.toolResult
          : JSON.stringify(compatibility.toolResult, null, 2),
    },
  ]

  return {
    content,
    structuredContent: enrichStructuredContentFromText(name, undefined, content),
  }
}

export function collectTextBlocks(result: NormalizedToolResult): string {
  const parts: string[] = []

  for (const entry of result.content ?? []) {
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text)
    }
  }

  return parts.join('\n\n').trim()
}

export function applyChromeToolArgumentDefaults(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!NAVIGATION_TOOL_NAMES.has(name)) {
    return args
  }

  if (typeof args.timeout === 'number' && Number.isFinite(args.timeout)) {
    return args
  }

  return {
    ...args,
    timeout: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
  }
}

export function resolveChromeToolRequestOptions(
  name: string,
  args: Record<string, unknown>,
): RequestOptions {
  if (!NAVIGATION_TOOL_NAMES.has(name)) {
    return {
      timeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
      maxTotalTimeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
    }
  }

  const timeout = resolveRequestedTimeout(args) + CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS
  return {
    timeout,
    maxTotalTimeout: timeout,
  }
}

export function isNavigationTimeoutError(error: unknown): error is Error {
  return (
    error instanceof Error
    && /Navigation timeout of \d+ ms exceeded/i.test(error.message)
  )
}

export function isMcpRequestTimeoutError(error: unknown): error is Error {
  return (
    error instanceof Error
    && /(?:request timed out|maximum total timeout exceeded)/i.test(error.message)
  )
}

export function isChromeMcpTransportError(error: unknown): error is Error {
  return (
    error instanceof Error
    && CHROME_TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
  )
}

function resolveRequestedTimeout(args: Record<string, unknown>): number {
  return (
    typeof args.timeout === 'number' && Number.isFinite(args.timeout)
      ? args.timeout
      : DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS
  )
}

export async function waitForChromeAttachReady(input: {
  callListPages: (requestOptions: RequestOptions) => Promise<NormalizedToolResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  windowMs?: number
  pollMs?: number
  probeTimeoutMs?: number
}): Promise<void> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? delay
  const windowMs = input.windowMs ?? CHROME_MCP_ATTACH_READY_WINDOW_MS
  const pollMs = input.pollMs ?? CHROME_MCP_ATTACH_READY_POLL_MS
  const probeTimeoutMs = input.probeTimeoutMs ?? CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS
  const deadlineMs = now() + windowMs
  let lastError: unknown

  while (now() < deadlineMs) {
    try {
      const result = await input.callListPages({
        timeout: probeTimeoutMs,
        maxTotalTimeout: probeTimeoutMs,
      })
      if (result.isError) {
        throw new Error(
          collectTextBlocks(result) || 'Chrome list_pages failed during attach readiness check.',
        )
      }
      return
    } catch (error) {
      lastError = error
    }

    await sleep(pollMs)
  }

  const detail =
    lastError instanceof Error && lastError.message.trim().length > 0
      ? ` Last error: ${lastError.message.trim()}`
      : ''
  throw new Error(
    'Chrome DevTools MCP attached, but Chrome never exposed usable tabs.' +
      ' Approve the browser attach prompt, keep Chrome open, and retry.' +
      detail,
  )
}

export async function recoverNavigationTimeoutResult(input: {
  service: ChromeMcpToolCaller
  name: string
  args: Record<string, unknown>
  error: unknown
}): Promise<{
  output: string
    structuredOutput?: Record<string, unknown>
} | null> {
  const chromeNavigationTimeout = isNavigationTimeoutError(input.error)
  const mcpRequestTimeout = isMcpRequestTimeoutError(input.error)

  if (
    !NAVIGATION_TOOL_NAMES.has(input.name)
    || (!chromeNavigationTimeout && !mcpRequestTimeout)
  ) {
    return null
  }

  try {
    const pagesResult = await input.service.callTool('list_pages', {})
    const pagesText = collectTextBlocks(pagesResult)
    const timeoutMs = resolveRequestedTimeout(input.args)
    const targetUrl =
      typeof input.args.url === 'string' && input.args.url.trim().length > 0
        ? input.args.url.trim()
        : null
    const actionSummary = input.name === 'new_page'
      ? `Chrome opened a new tab${targetUrl ? ` for ${targetUrl}` : ''}`
      : `Chrome started navigating the current page${targetUrl ? ` to ${targetUrl}` : ''}`
    const timeoutSummary = chromeNavigationTimeout
      ? `the page did not finish loading within ${timeoutMs} ms`
      : `the Chrome automation bridge did not answer within ${timeoutMs + CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS} ms`

    return {
      output: [
        `${actionSummary}, but ${timeoutSummary}.`,
        'The browser session is still connected, so continue by checking the current pages and inspecting the partially loaded page if needed.',
        pagesText.length > 0 ? `Open pages:\n${pagesText}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      structuredOutput: {
        recoveredFromNavigationTimeout: true,
        recoveryKind: chromeNavigationTimeout ? 'navigation_timeout' : 'mcp_request_timeout',
        toolName: input.name,
        timeoutMs,
        pageList: pagesText,
        ...(pagesResult.structuredContent
          ? { pages: pagesResult.structuredContent }
          : {}),
      },
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function disposeChromeConnection(
  client: ChromeMcpClientLike | null,
  transport: ChromeMcpTransportLike | null,
): Promise<void> {
  await client?.close().catch(() => undefined)
  await transport?.close().catch(() => undefined)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatChromeConnectionError(error: unknown): string {
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : 'Unknown Chrome DevTools MCP connection error.'

  return `${BASE_CONNECTION_ERROR} ${detail}`
}

export function isChromeMcpSupportedPlatform(
  platform: string,
): platform is SupportedSessionToolPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}
