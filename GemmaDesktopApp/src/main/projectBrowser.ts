import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import type {
  ProjectBrowserConsoleEntry,
  ProjectBrowserPanelBounds,
  ProjectBrowserState,
} from '../shared/projectBrowser'

const PROJECT_BROWSER_PARTITION = 'persist:gemma-desktop-browser'
const MAX_STORED_CONSOLE_ENTRIES = 500
const DEFAULT_OPEN_RESULT_MAX_CHARS = 3_500
const MAX_OPEN_RESULT_MAX_CHARS = 8_000
const DEFAULT_DOM_MATCH_LIMIT = 25
const MAX_DOM_MATCH_LIMIT = 100
const DEFAULT_CONSOLE_ERROR_LIMIT = 50
const MAX_CONSOLE_ERROR_LIMIT = 200
const DEFAULT_OPEN_TIMEOUT_MS = 15_000
const MAX_OPEN_TIMEOUT_MS = 60_000
const PAGE_LOAD_FAILED_TITLE = 'Page failed to load'
const PROJECT_BROWSER_GOOGLE_SEARCH_URL = 'https://www.google.com/search'
const ELECTRON_INSECURE_CSP_WARNING = 'Electron Security Warning (Insecure Content-Security-Policy)'
const PASSIVE_EVENT_LISTENER_WARNING = 'Unable to preventDefault inside passive event listener'
const UNRECOGNIZED_WEB_FEATURE_WARNING = 'Unrecognized feature:'
export const PROJECT_BROWSER_USER_CONTROL_ERROR =
  'Project Browser control is held by the user. The user must click Release control before the agent can use the browser again.'
const DEFAULT_USER_CONTROL_REASON =
  'The agent needs you to complete a browser-side action in the visible browser.'

type ConsoleLevel = ProjectBrowserConsoleEntry['level']

type ProjectBrowserOpenResult = {
  title: string
  url: string
  readyState: string
  excerpt: string
  truncated: boolean
  consoleErrorCount: number
  timedOut: boolean
}

type ProjectBrowserDomSearchResult = {
  title: string
  url: string
  matchCount: number
  returnedCount: number
  truncated: boolean
  matches: Array<{
    kind: 'selector' | 'text'
    pattern: string
    tagName: string
    id?: string
    className?: string
    text?: string
    html?: string
    attributes: Record<string, string>
  }>
}

function now(): number {
  return Date.now()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false }
  }

  return {
    text: `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n[…truncated…]`,
    truncated: true,
  }
}

function buildState(input?: Partial<ProjectBrowserState>): ProjectBrowserState {
  return {
    open: false,
    sessionId: null,
    coBrowseActive: false,
    controlOwner: 'agent',
    controlReason: null,
    mounted: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    url: null,
    title: 'Project Browser',
    consoleErrorCount: 0,
    recentConsoleErrors: [],
    lastError: null,
    lastUpdatedAt: now(),
    ...input,
  }
}

function canNavigateBack(webContents: WebContents): boolean {
  return webContents.navigationHistory.canGoBack()
}

function canNavigateForward(webContents: WebContents): boolean {
  return webContents.navigationHistory.canGoForward()
}

export function isIgnorableProjectBrowserConsoleEntry(input: {
  level: ProjectBrowserConsoleEntry['level']
  message: string
  sourceId?: string
  pageUrl?: string
}): boolean {
  if (input.level === 'warning'
    && input.message.includes(ELECTRON_INSECURE_CSP_WARNING)
    && typeof input.sourceId === 'string'
    && input.sourceId.startsWith('node:electron/js2c/')) {
    return true
  }

  if (!isExternalProjectBrowserPageUrl(input.pageUrl)) {
    return false
  }

  return input.message.includes(PASSIVE_EVENT_LISTENER_WARNING)
    || (
      input.level === 'warning'
      && input.message.includes(UNRECOGNIZED_WEB_FEATURE_WARNING)
    )
}

function isExternalProjectBrowserPageUrl(input: string | undefined): boolean {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return false
  }

  try {
    const url = new URL(input)
    const hostname = url.hostname.toLowerCase()
    return !(
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || /^127\./.test(hostname)
    )
  } catch {
    return false
  }
}

function isInternalProjectBrowserUrl(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  return normalized.startsWith('chrome-error://') || normalized === 'about:blank'
}

export function getProjectBrowserDisplayUrl(
  candidateUrl: string | null | undefined,
  fallbackUrl: string | null | undefined,
): string {
  const candidate = typeof candidateUrl === 'string' ? candidateUrl.trim() : ''
  if (candidate && !isInternalProjectBrowserUrl(candidate)) {
    return candidate
  }

  const fallback = typeof fallbackUrl === 'string' ? fallbackUrl.trim() : ''
  if (fallback) {
    return fallback
  }

  return candidate
}

export function getProjectBrowserDisplayTitle(
  candidateTitle: string | null | undefined,
  lastError: string | null | undefined,
): string {
  const candidate = typeof candidateTitle === 'string' ? candidateTitle.trim() : ''
  if (candidate) {
    return candidate
  }

  return lastError ? PAGE_LOAD_FAILED_TITLE : 'Untitled page'
}

export function isAllowedProjectBrowserAgentUrl(input: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  return true
}

export function isAllowedProjectBrowserUrl(input: string): boolean {
  return isAllowedProjectBrowserAgentUrl(input)
}

function looksLikeAddressWithoutProtocol(input: string): boolean {
  return /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\])(?::\d+)?(?:[/?#].*)?$/i.test(input)
}

function looksLikeLocalAddressWithoutProtocol(input: string): boolean {
  return /^(?:localhost|(?:[a-z0-9-]+\.)*localhost|(?:127\.0\.0\.1|0\.0\.0\.0)|\[?::1\]?)(?::\d+)?(?:[/?#].*)?$/i.test(input)
}

export function normalizeProjectBrowserUserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Project Browser requires a URL.')
  }

  if (trimmed.toLowerCase() === 'about:blank') {
    return 'about:blank'
  }

  const hasScheme = /^[A-Za-z][A-Za-z\d+\-.]*:/.test(trimmed)
  const candidate = trimmed.startsWith('//')
    ? `https:${trimmed}`
    : !hasScheme || looksLikeAddressWithoutProtocol(trimmed)
      ? `${looksLikeLocalAddressWithoutProtocol(trimmed) ? 'http' : 'https'}://${trimmed}`
      : trimmed

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(
      'Project Browser accepts website URLs such as https://example.com.',
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Project Browser accepts http and https URLs.')
  }

  return parsed.toString()
}

export function normalizeProjectBrowserAgentUrl(input: string): string {
  const normalized = normalizeProjectBrowserUserUrl(input)

  if (!isAllowedProjectBrowserAgentUrl(normalized)) {
    throw new Error(
      'Project Browser agent navigation accepts http and https URLs.',
    )
  }

  return normalized
}

export function normalizeProjectBrowserUrl(input: string): string {
  return normalizeProjectBrowserAgentUrl(input)
}

function normalizeSearchDomain(input: string): string | null {
  const trimmed = input
    .trim()
    .replace(/^-?site:/i, '')
    .replace(/^['"]|['"]$/g, '')
  if (!trimmed) {
    return null
  }

  const candidate = /^[A-Za-z][A-Za-z\d+\-.]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const parsed = new URL(candidate)
    return parsed.hostname.toLowerCase()
  } catch {
    const domain = trimmed.split('/')[0]?.toLowerCase() ?? ''
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null
  }
}

function uniqueSearchDomains(values: string[] | undefined): string[] {
  const normalized = (values ?? [])
    .map(normalizeSearchDomain)
    .filter((entry): entry is string => Boolean(entry))

  return normalized.filter((entry, index) => normalized.indexOf(entry) === index)
}

export function buildProjectBrowserGoogleSearchUrl(input: {
  query: string
  includeDomains?: string[]
  excludeDomains?: string[]
}): string {
  const query = input.query.trim()
  if (!query) {
    throw new Error('Google search requires a query.')
  }

  const includeDomains = uniqueSearchDomains(input.includeDomains)
  const excludeDomains = uniqueSearchDomains(input.excludeDomains)
  const includeTerm =
    includeDomains.length === 0
      ? ''
      : includeDomains.length === 1
        ? `site:${includeDomains[0]}`
        : `(${includeDomains.map((domain) => `site:${domain}`).join(' OR ')})`
  const excludeTerms = excludeDomains.map((domain) => `-site:${domain}`)
  const searchTerms = [query, includeTerm, ...excludeTerms]
    .filter((entry) => entry.trim().length > 0)
    .join(' ')

  const url = new URL(PROJECT_BROWSER_GOOGLE_SEARCH_URL)
  url.searchParams.set('q', searchTerms)
  return url.toString()
}

function formatConsoleEntry(entry: ProjectBrowserConsoleEntry): string {
  const location = entry.sourceId
    ? ` (${entry.sourceId}${entry.lineNumber != null ? `:${entry.lineNumber}` : ''})`
    : ''
  return `[${entry.level}] ${entry.message}${location}`
}

function formatDomMatchAttributes(attributes: Record<string, string>): string[] {
  const keys = ['href', 'src', 'role', 'aria-label', 'name', 'value', 'data-testid']
  return keys
    .map((key) => {
      const value = attributes[key]
      return value && value.trim().length > 0 ? `${key}=${JSON.stringify(value)}` : null
    })
    .filter((entry): entry is string => Boolean(entry))
}

function normalizeConsoleLevel(level: unknown): ConsoleLevel {
  if (level === 'error' || level === 'warning' || level === 'info' || level === 'debug') {
    return level
  }

  if (typeof level === 'number') {
    return level >= 3 ? 'error' : level === 2 ? 'warning' : level === 1 ? 'info' : 'debug'
  }

  return 'debug'
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; value?: T }> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const value = await Promise.race([
      promise.then((resolved) => ({ type: 'value' as const, resolved })),
      new Promise<{ type: 'timeout' }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs)
      }),
    ])

    if (value.type === 'timeout') {
      return { timedOut: true }
    }

    return {
      timedOut: false,
      value: value.resolved,
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export class ProjectBrowserManager {
  private view: WebContentsView | null = null

  private bounds: ProjectBrowserPanelBounds | null = null

  private hostWindow: BrowserWindow | null = null

  private attachedWindow: BrowserWindow | null = null

  private state: ProjectBrowserState = buildState()

  private consoleEntries: ProjectBrowserConsoleEntry[] = []

  private agentNavigationInProgress = false

  constructor(
    private readonly onStateChanged: (state: ProjectBrowserState) => void,
  ) {}

  getState(): ProjectBrowserState {
    return { ...this.state }
  }

  assertAgentBrowserControl(input?: {
    sessionId?: string | null
    coBrowseActive?: boolean
  }): void {
    if (!this.isUserControlledCoBrowse(input)) {
      return
    }

    throw new Error(PROJECT_BROWSER_USER_CONTROL_ERROR)
  }

  releaseControlToUser(input?: {
    sessionId?: string | null
    reason?: string | null
  }): ProjectBrowserState {
    const reason =
      typeof input?.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : DEFAULT_USER_CONTROL_REASON

    this.setState({
      sessionId: input?.sessionId ?? this.state.sessionId,
      coBrowseActive: true,
      controlOwner: 'user',
      controlReason: reason,
    })

    return this.getState()
  }

  releaseControlToAgent(): ProjectBrowserState {
    this.setState({
      controlOwner: 'agent',
      controlReason: null,
    })

    return this.getState()
  }

  setHostWindow(window: BrowserWindow | null): void {
    this.hostWindow = window && !window.isDestroyed() ? window : null
    if (!this.view || !this.bounds) {
      this.setState({
        mounted: false,
        ...this.getNavigationState(),
      })
      return
    }

    const attached = this.attachViewToWindow()
    this.setState({
      mounted: attached,
      ...this.getNavigationState(),
    })
  }

  async open(input: {
    sessionId: string
    url: string
    timeoutMs?: number
    maxChars?: number
    coBrowseActive?: boolean
  }): Promise<{
    output: string
    structuredOutput: Record<string, unknown>
  }> {
    this.assertAgentBrowserControl({
      sessionId: input.sessionId,
      coBrowseActive: input.coBrowseActive,
    })

    const url = normalizeProjectBrowserAgentUrl(input.url)
    const timeoutMs = clamp(
      Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : DEFAULT_OPEN_TIMEOUT_MS,
      1_000,
      MAX_OPEN_TIMEOUT_MS,
    )
    const maxChars = clamp(
      Number.isFinite(input.maxChars) ? Number(input.maxChars) : DEFAULT_OPEN_RESULT_MAX_CHARS,
      250,
      MAX_OPEN_RESULT_MAX_CHARS,
    )
    const view = this.ensureView()

    this.consoleEntries = []
    this.setState({
      open: true,
      sessionId: input.sessionId,
      coBrowseActive: input.coBrowseActive === true,
      controlOwner: 'agent',
      controlReason: null,
      loading: true,
      url,
      title: 'Loading…',
      consoleErrorCount: 0,
      recentConsoleErrors: [],
      lastError: null,
      ...this.getNavigationState(),
    })

    let loadTimedOut = false
    this.agentNavigationInProgress = true
    try {
      const loaded = await raceWithTimeout(
        view.webContents.loadURL(url).catch(() => undefined),
        timeoutMs,
      )
      loadTimedOut = loaded.timedOut
      if (loadTimedOut) {
        view.webContents.stop()
      }
    } finally {
      this.agentNavigationInProgress = false
    }

    const inspected = await this.collectPageSnapshot(maxChars)
    const result: ProjectBrowserOpenResult = {
      ...inspected,
      consoleErrorCount: this.countConsoleErrors(),
      timedOut: loadTimedOut,
    }

    this.setState({
      open: true,
      sessionId: input.sessionId,
      coBrowseActive: input.coBrowseActive === true,
      controlOwner: 'agent',
      controlReason: null,
      loading: false,
      url: result.url,
      title: result.title,
      consoleErrorCount: result.consoleErrorCount,
      lastError: this.state.lastError,
      ...this.getNavigationState(),
    })

    const lines = [
      `Opened Project Browser at ${result.url}.`,
      `Title: ${result.title || 'Untitled page'}`,
      `Ready state: ${result.readyState || 'unknown'}`,
      loadTimedOut
        ? `Loading did not finish within ${timeoutMs} ms. The current page state is shown below.`
        : 'Page load finished.',
      `Recent console errors: ${result.consoleErrorCount}`,
    ]

    if (result.excerpt.trim().length > 0) {
      lines.push('', 'Visible text excerpt:', result.excerpt)
    }

    if (result.truncated) {
      lines.push('', 'Visible text excerpt was truncated.')
    }

    return {
      output: lines.join('\n'),
      structuredOutput: {
        action: 'open',
        title: result.title,
        url: result.url,
        readyState: result.readyState,
        excerpt: result.excerpt,
        excerptTruncated: result.truncated,
        consoleErrorCount: result.consoleErrorCount,
        timedOut: result.timedOut,
        lastError: this.state.lastError,
      },
    }
  }

  navigate(input: {
    url: string
    sessionId?: string | null
    coBrowseActive?: boolean
  }): ProjectBrowserState {
    const url = normalizeProjectBrowserUserUrl(input.url)
    const view = this.ensureView()
    const coBrowseActive = input.coBrowseActive ?? this.state.coBrowseActive
    const sessionId = coBrowseActive
      ? (input.sessionId ?? this.state.sessionId)
      : null
    const controlOwner = coBrowseActive ? this.state.controlOwner : 'agent'

    this.agentNavigationInProgress = false
    this.consoleEntries = []
    this.setState({
      open: true,
      sessionId,
      coBrowseActive,
      controlOwner,
      controlReason: controlOwner === 'user' ? this.state.controlReason : null,
      loading: true,
      url,
      title: 'Loading…',
      consoleErrorCount: 0,
      recentConsoleErrors: [],
      lastError: null,
      ...this.getNavigationState(),
    })

    void view.webContents.loadURL(url).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.pushConsoleEntry({
        level: 'error',
        message: `Navigation failed: ${message}`,
        sourceId: url,
      })
      this.setState({
        loading: false,
        url,
        title: this.state.title === 'Loading…' ? PAGE_LOAD_FAILED_TITLE : this.state.title,
        lastError: `Failed to load ${url}: ${message}`,
        ...this.getNavigationState(),
      })
    })

    return this.getState()
  }

  reload(): ProjectBrowserState {
    if (!this.view) {
      return this.getState()
    }

    this.view.webContents.reload()
    this.setState({
      loading: true,
      lastError: null,
      ...this.getNavigationState(),
    })
    return this.getState()
  }

  stopLoading(): ProjectBrowserState {
    if (!this.view) {
      return this.getState()
    }

    this.view.webContents.stop()
    this.setState({
      loading: false,
      url: getProjectBrowserDisplayUrl(this.view.webContents.getURL(), this.state.url),
      ...this.getNavigationState(),
    })
    return this.getState()
  }

  goBack(): ProjectBrowserState {
    if (this.view && canNavigateBack(this.view.webContents)) {
      this.view.webContents.navigationHistory.goBack()
      this.setState({
        loading: true,
        lastError: null,
        ...this.getNavigationState(),
      })
    }
    return this.getState()
  }

  goForward(): ProjectBrowserState {
    if (this.view && canNavigateForward(this.view.webContents)) {
      this.view.webContents.navigationHistory.goForward()
      this.setState({
        loading: true,
        lastError: null,
        ...this.getNavigationState(),
      })
    }
    return this.getState()
  }

  async searchDom(input: {
    selectors?: string[]
    textPatterns?: string[]
    maxMatches?: number
    includeHtml?: boolean
  }): Promise<{
    output: string
    structuredOutput: Record<string, unknown>
  }> {
    const view = this.requireView()
    const selectors = Array.isArray(input.selectors)
      ? input.selectors.filter((entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
        )
      : []
    const textPatterns = Array.isArray(input.textPatterns)
      ? input.textPatterns.filter((entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
        )
      : []

    if (selectors.length === 0 && textPatterns.length === 0) {
      throw new Error('DOM search requires selectors and/or textPatterns.')
    }

    const maxMatches = clamp(
      Number.isFinite(input.maxMatches) ? Number(input.maxMatches) : DEFAULT_DOM_MATCH_LIMIT,
      1,
      MAX_DOM_MATCH_LIMIT,
    )

    const result = await view.webContents.executeJavaScript(
      `(() => {
        const selectors = ${JSON.stringify(selectors)};
        const textPatterns = ${JSON.stringify(textPatterns)};
        const includeHtml = ${input.includeHtml === true ? 'true' : 'false'};
        const maxMatches = ${maxMatches};
        const matches = [];
        const seen = new Set();

        const normalizeText = (element) => (element instanceof HTMLElement ? element.innerText : element.textContent || '')
          .replace(/\\s+/g, ' ')
          .trim();

        const resolveUrlAttribute = (value) => {
          try {
            return new URL(value, document.baseURI).toString();
          } catch {
            return value;
          }
        };

        const collectAttributes = (element) => {
          const keys = ['role', 'aria-label', 'name', 'value', 'href', 'src', 'data-testid'];
          const attributes = {};
          for (const key of keys) {
            const rawValue = element.getAttribute?.(key);
            const value = (key === 'href' || key === 'src') && typeof rawValue === 'string'
              ? resolveUrlAttribute(rawValue)
              : rawValue;
            if (typeof value === 'string' && value.trim().length > 0) {
              attributes[key] = value;
            }
          }
          return attributes;
        };

        const findTextMatchTarget = (element, pattern) => {
          const normalizedPattern = pattern.toLowerCase();
          const isActionable = (candidate) => candidate?.matches?.('a[href], button, [role="button"]') === true;
          const textIncludesPattern = (candidate) => normalizeText(candidate).toLowerCase().includes(normalizedPattern);
          if (isActionable(element)) {
            return element;
          }
          const closestActionable = element.closest?.('a[href], button, [role="button"]');
          if (closestActionable && textIncludesPattern(closestActionable)) {
            return closestActionable;
          }
          const descendants = typeof element.querySelectorAll === 'function'
            ? Array.from(element.querySelectorAll('a[href], button, [role="button"]'))
            : [];
          return descendants.find(textIncludesPattern) || (descendants.length === 1 ? descendants[0] : element);
        };

        const push = (kind, pattern, element) => {
          if (!element || matches.length >= maxMatches) {
            return;
          }
          if (seen.has(element)) {
            return;
          }
          seen.add(element);

          const text = normalizeText(element);
          matches.push({
            kind,
            pattern,
            tagName: (element.tagName || '').toLowerCase(),
            id: element.id || undefined,
            className: typeof element.className === 'string' && element.className.trim().length > 0
              ? element.className.trim()
              : undefined,
            text: text.length > 0 ? text.slice(0, 300) : undefined,
            html: includeHtml && typeof element.outerHTML === 'string'
              ? element.outerHTML.slice(0, 400)
              : undefined,
            attributes: collectAttributes(element),
          });
        };

        for (const selector of selectors) {
          if (matches.length >= maxMatches) {
            break;
          }
          let found = [];
          try {
            found = Array.from(document.querySelectorAll(selector));
          } catch {
            continue;
          }
          for (const element of found) {
            push('selector', selector, element);
            if (matches.length >= maxMatches) {
              break;
            }
          }
        }

        if (matches.length < maxMatches && textPatterns.length > 0) {
          const elements = Array.from(document.querySelectorAll('body *'));
          for (const element of elements) {
            if (matches.length >= maxMatches) {
              break;
            }
            const haystack = normalizeText(element).toLowerCase();
            if (!haystack) {
              continue;
            }
            for (const pattern of textPatterns) {
              if (haystack.includes(pattern.toLowerCase())) {
                push('text', pattern, findTextMatchTarget(element, pattern));
                break;
              }
            }
          }
        }

        return {
          title: document.title || '',
          url: window.location.href,
          matchCount: matches.length,
          returnedCount: matches.length,
          truncated: matches.length >= maxMatches,
          matches,
        };
      })()`,
      true,
    ) as ProjectBrowserDomSearchResult

    const lines = [
      `DOM search inspected ${result.url}.`,
      `Title: ${result.title || 'Untitled page'}`,
      `Returned matches: ${result.returnedCount}`,
    ]

    if (result.matches.length > 0) {
      lines.push('')
      for (const match of result.matches) {
        lines.push(
          [
            `- ${match.kind} match for "${match.pattern}"`,
            match.tagName ? `tag=${match.tagName}` : '',
            match.id ? `id=${match.id}` : '',
            match.className ? `class=${match.className}` : '',
            ...formatDomMatchAttributes(match.attributes),
            match.text ? `text="${match.text}"` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
      }
    } else {
      lines.push('', 'No matching DOM nodes were found.')
    }

    if (result.truncated) {
      lines.push('', `Results were truncated at ${maxMatches} matches.`)
    }

    return {
      output: lines.join('\n'),
      structuredOutput: result,
    }
  }

  getConsoleErrors(input?: {
    maxItems?: number
  }): {
    output: string
    structuredOutput: Record<string, unknown>
  } {
    const limit = clamp(
      Number.isFinite(input?.maxItems) ? Number(input?.maxItems) : DEFAULT_CONSOLE_ERROR_LIMIT,
      1,
      MAX_CONSOLE_ERROR_LIMIT,
    )
    const errors = this.consoleEntries.filter((entry) => entry.level === 'error')
    const returned = errors.slice(-limit)
    const truncated = errors.length > returned.length
    const url = this.state.url

    const lines = [
      `Project Browser console errors${url ? ` for ${url}` : ''}.`,
      `Returned ${returned.length} of ${errors.length} captured errors.`,
    ]

    if (returned.length > 0) {
      lines.push('', ...returned.map(formatConsoleEntry))
    } else {
      lines.push('', 'No console errors have been captured yet.')
    }

    if (truncated) {
      lines.push('', `Results were truncated to the most recent ${returned.length} errors.`)
    }

    return {
      output: lines.join('\n'),
      structuredOutput: {
        url,
        totalErrorCount: errors.length,
        returnedErrorCount: returned.length,
        truncated,
        errors: returned,
      },
    }
  }

  setBounds(bounds: ProjectBrowserPanelBounds | null): void {
    this.bounds = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null
    if (!this.view) {
      return
    }

    if (!this.bounds) {
      this.view.setVisible(false)
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      this.setState({
        mounted: false,
        ...this.getNavigationState(),
      })
      return
    }

    const attached = this.attachViewToWindow()
    if (attached) {
      this.view.setVisible(true)
      this.view.setBounds(this.bounds)
    }
    this.setState({
      mounted: attached,
      ...this.getNavigationState(),
    })
  }

  close(): void {
    if (this.view) {
      if (this.attachedWindow && !this.attachedWindow.isDestroyed()) {
        try {
          this.attachedWindow.contentView.removeChildView(this.view)
        } catch {
          // Ignore stale child-view detach errors.
        }
      }
      this.view.webContents.close()
      this.view = null
    }

    this.consoleEntries = []
    this.hostWindow = null
    this.attachedWindow = null
    this.state = buildState()
    this.onStateChanged(this.getState())
  }

  private getNavigationState(): Pick<ProjectBrowserState, 'canGoBack' | 'canGoForward'> {
    if (!this.view) {
      return {
        canGoBack: false,
        canGoForward: false,
      }
    }

    return {
      canGoBack: canNavigateBack(this.view.webContents),
      canGoForward: canNavigateForward(this.view.webContents),
    }
  }

  private isUserControlledCoBrowse(input?: {
    sessionId?: string | null
    coBrowseActive?: boolean
  }): boolean {
    if (!this.state.coBrowseActive || this.state.controlOwner !== 'user') {
      return false
    }

    const sessionMatches =
      !input?.sessionId
      || !this.state.sessionId
      || input.sessionId === this.state.sessionId
    const isCoBrowseBrowserCall = input?.coBrowseActive === true
      || (input?.coBrowseActive == null && this.state.coBrowseActive && sessionMatches)

    return isCoBrowseBrowserCall && sessionMatches
  }

  private applyCoBrowseInputGuard(): void {
    if (!this.view) {
      return
    }

    const readOnly = this.state.coBrowseActive && this.state.controlOwner === 'agent'
    const script = `
      (() => {
        const key = '__gemmaDesktopCoBrowseInputGuard';
        const eventNames = [
          'auxclick',
          'beforeinput',
          'change',
          'click',
          'contextmenu',
          'dblclick',
          'dragover',
          'dragstart',
          'drop',
          'focusin',
          'input',
          'keydown',
          'keypress',
          'keyup',
          'mousedown',
          'mouseup',
          'pointerdown',
          'pointermove',
          'pointerup',
          'submit',
          'touchend',
          'touchmove',
          'touchstart',
          'wheel',
        ];
        const shouldBlock = ${readOnly ? 'true' : 'false'};
        if (shouldBlock) {
          let guard = window[key];
          if (!guard) {
            guard = { enabled: true };
            const block = (event) => {
              if (!window[key]?.enabled) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              return false;
            };
            for (const eventName of eventNames) {
              window.addEventListener(eventName, block, true);
            }
            window[key] = guard;
          }
          guard.enabled = true;
          document.documentElement.setAttribute('data-gemma-cobrowse-readonly', 'true');
          return 'read-only';
        }
        const guard = window[key];
        if (guard) {
          guard.enabled = false;
        }
        document.documentElement.removeAttribute('data-gemma-cobrowse-readonly');
        return 'released';
      })()
    `

    void this.view.webContents.executeJavaScript(script, true).catch(() => {
      // Pages can disappear while navigating; the next dom-ready/state change retries.
    })
  }

  private guardAgentNavigation(
    event: { preventDefault: () => void },
    navigationUrl: string,
  ): void {
    if (
      !this.agentNavigationInProgress
      || isInternalProjectBrowserUrl(navigationUrl)
      || isAllowedProjectBrowserAgentUrl(navigationUrl)
    ) {
      return
    }

    event.preventDefault()
    this.pushConsoleEntry({
      level: 'error',
      message: `Blocked agent navigation to non-local URL ${navigationUrl}`,
      sourceId: navigationUrl,
    })
    this.setState({
      loading: false,
      lastError: `Agent browser navigation accepts http and https URLs: ${navigationUrl}`,
      ...this.getNavigationState(),
    })
  }

  private countConsoleErrors(): number {
    return this.consoleEntries.filter((entry) => entry.level === 'error').length
  }

  private getRecentConsoleErrors(limit = 5): string[] {
    return this.consoleEntries
      .filter((entry) => entry.level === 'error')
      .slice(-limit)
      .map(formatConsoleEntry)
  }

  private setState(patch: Partial<ProjectBrowserState>): void {
    const previousState = this.state
    this.state = buildState({
      ...this.state,
      ...patch,
      lastUpdatedAt: now(),
    })
    if (
      previousState.coBrowseActive !== this.state.coBrowseActive
      || previousState.controlOwner !== this.state.controlOwner
    ) {
      this.applyCoBrowseInputGuard()
    }
    this.onStateChanged(this.getState())
  }

  private getHostWindow(): BrowserWindow | null {
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      return this.hostWindow
    }

    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (focusedWindow && !focusedWindow.isDestroyed()) {
      return focusedWindow
    }

    return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
  }

  private attachViewToWindow(): boolean {
    const hostWindow = this.getHostWindow()
    if (!hostWindow || !this.view) {
      return false
    }

    if (
      this.attachedWindow
      && this.attachedWindow !== hostWindow
      && !this.attachedWindow.isDestroyed()
    ) {
      try {
        this.attachedWindow.contentView.removeChildView(this.view)
      } catch {
        // Ignore stale detach failures when moving the browser surface.
      }
    }

    if (this.attachedWindow !== hostWindow) {
      hostWindow.contentView.addChildView(this.view)
      this.attachedWindow = hostWindow
    }

    if (this.bounds) {
      this.view.setVisible(true)
      this.view.setBounds(this.bounds)
    }

    return true
  }

  private ensureView(): WebContentsView {
    if (this.view) {
      const attached = this.attachViewToWindow()
      this.setState({
        mounted: attached && Boolean(this.bounds),
        ...this.getNavigationState(),
      })
      return this.view
    }

    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: PROJECT_BROWSER_PARTITION,
        webSecurity: true,
        devTools: true,
      },
    })
    view.setBackgroundColor('#ffffff')

    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        this.navigate({ url })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.pushConsoleEntry({
          level: 'error',
          message: `Blocked popup navigation to ${url}: ${message}`,
          sourceId: url,
        })
      }
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, navigationUrl) => {
      this.guardAgentNavigation(event, navigationUrl)
    })
    view.webContents.on('will-redirect', (event, navigationUrl) => {
      this.guardAgentNavigation(event, navigationUrl)
    })
    view.webContents.on('dom-ready', () => {
      this.applyCoBrowseInputGuard()
    })
    view.webContents.on('console-message', (details) => {
      const pageUrl = view.webContents.getURL()
      const normalized = {
        level: normalizeConsoleLevel(details.level),
        message: typeof details.message === 'string' ? details.message : '',
        sourceId: typeof details.sourceId === 'string' ? details.sourceId : undefined,
        lineNumber: typeof details.lineNumber === 'number' ? details.lineNumber : undefined,
        pageUrl: pageUrl || undefined,
      }
      if (isIgnorableProjectBrowserConsoleEntry(normalized)) {
        return
      }
      this.pushConsoleEntry({
        level: normalized.level,
        message: normalized.message,
        sourceId: normalized.sourceId,
        lineNumber: normalized.lineNumber,
      })
      if (normalized.level === 'warning' || normalized.level === 'error') {
        const displayPageUrl = pageUrl || '(no page url)'
        const location = normalized.sourceId
          ? `${normalized.sourceId}${normalized.lineNumber != null ? `:${normalized.lineNumber}` : ''}`
          : '(no source location)'
        const line = `[project-browser-console] [${normalized.level}] page=${displayPageUrl} at=${location} message=${normalized.message}`
        if (normalized.level === 'error') {
          console.error(line)
        } else {
          console.warn(line)
        }
      }
    })
    view.webContents.on('did-start-loading', () => {
      this.setState({
        loading: true,
        lastError: null,
        ...this.getNavigationState(),
      })
    })
    view.webContents.on('did-stop-loading', () => {
      this.setState({
        loading: false,
        url: getProjectBrowserDisplayUrl(
          view.webContents.getURL(),
          this.state.url,
        ),
        ...this.getNavigationState(),
      })
    })
    view.webContents.on('did-navigate', (_event, navigationUrl) => {
      this.setState({
        url: getProjectBrowserDisplayUrl(navigationUrl, this.state.url),
        ...this.getNavigationState(),
      })
    })
    view.webContents.on('did-navigate-in-page', (_event, navigationUrl) => {
      this.setState({
        url: getProjectBrowserDisplayUrl(navigationUrl, this.state.url),
        ...this.getNavigationState(),
      })
    })
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      this.setState({
        title,
        url: getProjectBrowserDisplayUrl(
          view.webContents.getURL(),
          this.state.url,
        ),
        ...this.getNavigationState(),
      })
    })
    view.webContents.on('did-fail-load', (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    ) => {
      if (!isMainFrame) {
        return
      }
      if (errorCode === -3) {
        this.setState({
          loading: false,
          url: getProjectBrowserDisplayUrl(
            validatedURL || view.webContents.getURL(),
            this.state.url,
          ),
          ...this.getNavigationState(),
        })
        return
      }
      this.pushConsoleEntry({
        level: 'error',
        message: `Page load failed (${errorCode}): ${errorDescription}`,
        sourceId: validatedURL,
      })
      const displayUrl = getProjectBrowserDisplayUrl(
        validatedURL || view.webContents.getURL(),
        this.state.url,
      )
      this.setState({
        loading: false,
        url: displayUrl,
        title: this.state.title === 'Loading…' ? PAGE_LOAD_FAILED_TITLE : this.state.title,
        lastError: `Failed to load ${displayUrl} (${errorCode}): ${errorDescription}`,
        ...this.getNavigationState(),
      })
    })

    this.view = view
    const attached = this.attachViewToWindow()
    this.setState({
      open: true,
      mounted: attached && Boolean(this.bounds),
      ...this.getNavigationState(),
    })
    return view
  }

  private requireView(): WebContentsView {
    if (!this.view) {
      throw new Error(
        'Project Browser is not open. Use open_project_browser with an http or https URL first.',
      )
    }

    return this.view
  }

  private async collectPageSnapshot(maxChars: number): Promise<Omit<ProjectBrowserOpenResult, 'consoleErrorCount' | 'timedOut'>> {
    const view = this.requireView()
    const result = await view.webContents.executeJavaScript(
      `(() => {
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        return {
          title: document.title || '',
          url: window.location.href,
          readyState: document.readyState,
          text,
        };
      })()`,
      true,
    )
      .catch(() => ({
        title: this.state.title,
        url: getProjectBrowserDisplayUrl(
          view.webContents.getURL(),
          this.state.url,
        ),
        readyState: 'unknown',
        text: '',
      })) as {
        title: string
        url: string
        readyState: string
        text: string
      }

    const excerpt = truncateText(result.text, maxChars)
    const title = getProjectBrowserDisplayTitle(result.title, this.state.lastError)
    return {
      title,
      url: getProjectBrowserDisplayUrl(result.url, this.state.url),
      readyState: result.readyState || 'unknown',
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
    }
  }

  private pushConsoleEntry(input: {
    level: ConsoleLevel
    message: string
    sourceId?: string
    lineNumber?: number
  }): void {
    const entry: ProjectBrowserConsoleEntry = {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      level: input.level,
      message: input.message,
      sourceId: input.sourceId,
      lineNumber: input.lineNumber,
      timestamp: now(),
    }

    this.consoleEntries.push(entry)
    if (this.consoleEntries.length > MAX_STORED_CONSOLE_ENTRIES) {
      this.consoleEntries.splice(0, this.consoleEntries.length - MAX_STORED_CONSOLE_ENTRIES)
    }

    this.setState({
      consoleErrorCount: this.countConsoleErrors(),
      recentConsoleErrors: this.getRecentConsoleErrors(),
    })
  }
}
