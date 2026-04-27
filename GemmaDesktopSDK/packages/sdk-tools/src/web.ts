import { Readability } from "@mozilla/readability";
import { GemmaDesktopError, type ToolProgressUpdate } from "@gemma-desktop/sdk-core";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import {
  executeGeminiApiSearch,
  type GeminiApiSearchInput,
  type GeminiApiSearchResponse,
} from "./geminiApiSearch.js";

export type SearchDepth = "quick" | "standard" | "deep";
export type SearchEngine = "auto" | "google" | "bing";
export type SearchRecency = "any" | "day" | "week" | "month" | "year";
export type ResolvedSearchEngine = Exclude<SearchEngine, "auto">;
export type SearchExecutionProvider = ResolvedSearchEngine | "multi" | "gemini-api";
export type SearchAttemptedEngine = ResolvedSearchEngine | "gemini-api";

export interface FetchUrlInput {
  url: string;
  maxChars?: number;
}

export interface SearchWebInput {
  query: string;
  depth?: SearchDepth;
  limit?: number;
  maxResults?: number;
  maxPages?: number;
  maxCharsPerPage?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  engine?: SearchEngine;
  recency?: SearchRecency;
}

export interface SearchResultRecord {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  rank?: number;
  engine?: ResolvedSearchEngine;
  query?: string;
  occurrences?: number;
  relevanceScore?: number;
}

export interface FetchHeadlineRecord {
  title: string;
  url: string;
}

export interface SearchFetchedPageRecord {
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  contentType: string;
  kind: "html" | "feed" | "json" | "text";
  title?: string;
  description?: string;
  blockedLikely: boolean;
  extractedWith:
    | "readability"
    | "headline-fallback"
    | "body-fallback"
    | "feed-parser"
    | "json"
    | "text"
    | "stack-overflow"
    | "github";
  headlines?: FetchHeadlineRecord[];
  content: string;
  contentLength: number;
  relevanceScore?: number;
}

export interface SearchExecutionResult {
  output: string;
  structuredOutput: {
    provider: SearchExecutionProvider;
    engine: SearchExecutionProvider;
    query: string;
    depth: SearchDepth;
    searchQuery: string;
    queriesRun: string[];
    resultCount: number;
    pageCount: number;
    results: SearchResultRecord[];
    pages: SearchFetchedPageRecord[];
    attemptedEngines: SearchAttemptedEngine[];
    fetchedAt: string;
    summary?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface FetchExecutionResult {
  output: string;
  structuredOutput: SearchFetchedPageRecord;
  metadata?: Record<string, unknown>;
}

export interface WebExecutionOptions {
  signal?: AbortSignal;
  emitProgress?: (progress: ToolProgressUpdate) => void;
  workingDirectory?: string;
  geminiApiKey?: string;
  geminiApiModel?: string;
}

interface RequestTextOptions {
  signal?: AbortSignal;
  searchRequest?: boolean;
  emitProgress?: (progress: ToolProgressUpdate) => void;
}

interface RequestAttemptRecord {
  attempt: number;
  status?: number;
  error?: string;
  transientLikely: boolean;
}

interface SearchRequestNormalization {
  query: string;
  depth: SearchDepth;
  maxResults: number;
  maxPages: number;
  maxCharsPerPage: number;
  includeDomains: string[];
  excludeDomains: string[];
  engine: SearchEngine;
  recency: SearchRecency;
}

interface EngineSearchOutcome {
  engine: ResolvedSearchEngine;
  searchQuery: string;
  results: SearchResultRecord[];
  attemptedUrl: string;
  status: number;
  fetchedAt: string;
  blocked?: boolean;
  parseFailed?: boolean;
  error?: string;
}

interface CachedSearchOutcome {
  expiresAt: number;
  outcome: EngineSearchOutcome;
}

interface FetchExtractionRecord {
  kind: "html" | "feed" | "json" | "text";
  title?: string;
  description?: string;
  blockedLikely: boolean;
  extractedWith: SearchFetchedPageRecord["extractedWith"];
  headlines?: FetchHeadlineRecord[];
  content: string;
}

interface CachedFetchRecord {
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  contentType: string;
  parsed: FetchExtractionRecord;
}

interface FetchExtractionResult {
  record: CachedFetchRecord;
  cacheHit: boolean;
  requestAttempts?: RequestAttemptRecord[];
}

export type SearchProviderOverride = (
  input: GeminiApiSearchInput,
  options: WebExecutionOptions,
) => Promise<GeminiApiSearchResponse>;

let searchProviderOverride: SearchProviderOverride | null = null;

export function setSearchProviderForTests(fn: SearchProviderOverride | null): void {
  searchProviderOverride = fn;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_STANDARD_MAX_PAGES = 3;
const DEFAULT_DEEP_MAX_PAGES = 6;
const DEFAULT_MAX_CHARS_PER_PAGE = 8_000;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const MIN_SEARCH_DELAY_MS = 1_000;
const MAX_SEARCH_DELAY_MS = 3_000;

const GOOGLE_RECENCY_PARAM: Record<SearchRecency, string | undefined> = {
  any: undefined,
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
];

const TEXT_RESPONSE_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
} as const;

const SEARCH_CACHE = new Map<string, CachedSearchOutcome>();
const PAGE_CACHE = new Map<string, CachedFetchRecord>();
const SEARCH_HOST_LAST_REQUEST_AT = new Map<string, number>();

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function truncateContent(text: string, limit: number): { output: string; truncated: boolean } {
  if (text.length <= limit) {
    return {
      output: text,
      truncated: false,
    };
  }

  return {
    output: `${text.slice(0, limit)}\n\n[Content truncated at ${limit} chars. Full page is ${text.length} chars.]`,
    truncated: true,
  };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickUserAgent(): string {
  return USER_AGENTS[randomInt(0, USER_AGENTS.length - 1)] ?? USER_AGENTS[0]!;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string };
  return (
    error.name === "AbortError"
    || errorWithCode.code === "ABORT_ERR"
    || /\brequest aborted\b/i.test(error.message)
    || /\bthe operation was aborted\b/i.test(error.message)
  );
}

function shouldFallbackToNativeFetch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string };
  return errorWithCode.code === "ERR_TOO_MANY_REDIRECTS";
}

function debugWeb(event: string, detail: Record<string, unknown>): void {
  if (process.env.GEMMA_DESKTOP_WEB_DEBUG !== "1") {
    return;
  }

  console.warn(`[gemma-desktop-web] ${event}`, detail);
}

function emitWebProgress(
  options: WebExecutionOptions | undefined,
  progress: ToolProgressUpdate,
): void {
  options?.emitProgress?.(progress);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const errorWithCode = error as { code?: unknown; cause?: unknown };
  if (typeof errorWithCode.code === "string" && errorWithCode.code.trim().length > 0) {
    return errorWithCode.code.trim();
  }

  if (errorWithCode.cause && typeof errorWithCode.cause === "object") {
    const causeCode = (errorWithCode.cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && causeCode.trim().length > 0) {
      return causeCode.trim();
    }
  }

  return undefined;
}

function isLikelyTransientNetworkCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }

  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPROTO",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code.toUpperCase());
}

function isLikelyTransientNetworkMessage(message: string): boolean {
  return /\b(?:timed out|timeout|socket hang up|fetch failed|connection reset|connection refused|network is unreachable|host is unreachable|temporary failure|dns|tls|ssl|certificate|429|502|503|504)\b/i.test(
    message,
  );
}

function isLikelyTransientNetworkError(error: unknown): boolean {
  return (
    isLikelyTransientNetworkCode(extractErrorCode(error))
    || isLikelyTransientNetworkMessage(extractErrorMessage(error))
  );
}

function buildRequestRetryLabel(input: {
  status?: number;
  error?: string;
  nextAttempt: number;
  totalAttempts: number;
}): string {
  const reason =
    typeof input.status === "number"
      ? `HTTP ${input.status}`
      : normalizeWhitespace(input.error ?? "a transient network error");
  return `Retrying request after ${reason} (attempt ${input.nextAttempt} of ${input.totalAttempts})`;
}

function describeRequestAttempt(attempt: RequestAttemptRecord): string {
  if (typeof attempt.status === "number") {
    return `HTTP ${attempt.status}`;
  }

  return attempt.error ?? "unknown failure";
}

function buildRequestFailureMessage(url: string, attempts: RequestAttemptRecord[]): string {
  const parts = [
    `Failed to fetch ${url} after ${formatCountLabel(attempts.length || 1, "attempt")}.`,
  ];
  const lastAttempt = attempts.at(-1);
  if (lastAttempt) {
    parts.push(`Last failure: ${describeRequestAttempt(lastAttempt)}.`);
  }
  if (attempts.length > 1) {
    parts.push(`Attempts: ${attempts.map((attempt) => describeRequestAttempt(attempt)).join(" -> ")}.`);
  }
  if (attempts.length > 0 && attempts.every((attempt) => attempt.transientLikely)) {
    parts.push("This looks like a transient network or remote-site failure, not a deterministic tool bug.");
  }
  return parts.join(" ");
}

function formatEngineLabel(engine: ResolvedSearchEngine): string {
  switch (engine) {
    case "google":
      return "Google";
    case "bing":
      return "Bing";
  }
}

function formatCountLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function buildFetchContentParseLabel(contentType: string, body: string): string {
  if (isHtmlContentType(contentType)) {
    return "Parsing HTML";
  }
  if (isJsonContentType(contentType) || looksLikeJson(body)) {
    return "Parsing JSON";
  }
  if (isXmlContentType(contentType) || looksLikeXml(body)) {
    return "Parsing feed";
  }
  return "Reading text response";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new GemmaDesktopError("tool_execution_failed", "Request aborted."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function throttleSearchHost(url: string, signal?: AbortSignal): Promise<void> {
  if (isLocalhostUrl(url)) {
    return;
  }

  const hostname = new URL(url).hostname.toLowerCase();
  const previous = SEARCH_HOST_LAST_REQUEST_AT.get(hostname);
  const requiredGap = randomInt(MIN_SEARCH_DELAY_MS, MAX_SEARCH_DELAY_MS);
  const now = Date.now();
  const waitMs = previous ? Math.max(0, requiredGap - (now - previous)) : 0;
  if (waitMs > 0) {
    await sleep(waitMs, signal);
  }
  SEARCH_HOST_LAST_REQUEST_AT.set(hostname, Date.now());
}

async function requestText(
  url: string,
  options: RequestTextOptions = {},
): Promise<{
  url: string;
  status: number;
  contentType: string;
  body: string;
  attempts: RequestAttemptRecord[];
}> {
  const delays = [0, 250, 900];
  let lastError: unknown;
  const attempts: RequestAttemptRecord[] = [];

  if (options.searchRequest) {
    await throttleSearchHost(url, options.signal);
  }

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt] ?? 0, options.signal);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          ...TEXT_RESPONSE_HEADERS,
          "user-agent": pickUserAgent(),
        },
      });

      const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
      if (response.status >= 400 && shouldRetryStatus(response.status) && attempt < delays.length - 1) {
        lastError = new Error(`Request failed with status ${response.status}`);
        attempts.push({
          attempt: attempt + 1,
          status: response.status,
          transientLikely: true,
        });
        emitWebProgress(
          { emitProgress: options.emitProgress },
          {
            id: "request-retry",
            label: buildRequestRetryLabel({
              status: response.status,
              nextAttempt: attempt + 2,
              totalAttempts: delays.length,
            }),
            tone: "warning",
          },
        );
        continue;
      }

      if (response.status >= 400 && shouldRetryStatus(response.status)) {
        attempts.push({
          attempt: attempt + 1,
          status: response.status,
          transientLikely: true,
        });
        lastError = new Error(`Request failed with status ${response.status}`);
        break;
      }

      return {
        url: response.url,
        status: response.status,
        contentType,
        body: await response.text(),
        attempts,
      };
    } catch (error) {
      if (isAbortError(error)) {
        if (options.signal?.aborted) {
          throw error;
        }
        if (timedOut) {
          lastError = new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
          attempts.push({
            attempt: attempt + 1,
            error: "Request timed out.",
            transientLikely: true,
          });
          if (attempt < delays.length - 1) {
            emitWebProgress(
              { emitProgress: options.emitProgress },
              {
                id: "request-retry",
                label: buildRequestRetryLabel({
                  error: "request timeout",
                  nextAttempt: attempt + 2,
                  totalAttempts: delays.length,
                }),
                tone: "warning",
              },
            );
          }
          if (attempt === delays.length - 1) {
            break;
          }
          continue;
        }
        throw error;
      }

      lastError = error;
      const message = extractErrorMessage(error);
      attempts.push({
        attempt: attempt + 1,
        error: message,
        transientLikely: isLikelyTransientNetworkError(error),
      });
      if (attempt < delays.length - 1) {
        emitWebProgress(
          { emitProgress: options.emitProgress },
          {
            id: "request-retry",
            label: buildRequestRetryLabel({
              error: message,
              nextAttempt: attempt + 2,
              totalAttempts: delays.length,
            }),
            tone: "warning",
          },
        );
      }
      if (attempt === delays.length - 1) {
        break;
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  throw new GemmaDesktopError("tool_execution_failed", buildRequestFailureMessage(url, attempts), {
    cause: lastError,
    details: {
      attempts,
      transientFailureLikely:
        attempts.length > 0 && attempts.every((attempt) => attempt.transientLikely),
    },
  });
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new GemmaDesktopError("invalid_tool_input", `Unsupported URL protocol for "${url}".`);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof GemmaDesktopError) {
      throw error;
    }
    throw new GemmaDesktopError("invalid_tool_input", `Invalid URL: "${url}".`, {
      cause: error,
    });
  }
}

function safeNormalizeHttpUrl(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

function convertGithubBlobUrlToRaw(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && parsed.pathname.includes("/blob/")) {
      parsed.hostname = "raw.githubusercontent.com";
      parsed.pathname = parsed.pathname.replace(/^\/([^/]+\/[^/]+)\/blob\//, "/$1/");
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function looksLikeXml(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<rss") ||
    trimmed.startsWith("<feed") ||
    trimmed.startsWith("<rdf:RDF")
  );
}

function isHtmlContentType(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml/.test(contentType);
}

function isJsonContentType(contentType: string): boolean {
  return /application\/json|application\/.+\+json/.test(contentType);
}

function isXmlContentType(contentType: string): boolean {
  return /application\/xml|text\/xml|application\/rss\+xml|application\/atom\+xml/.test(contentType);
}

function resolveSiteName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
}

function matchesDomain(url: string, domains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function buildSearchQuery(query: string, includeDomains: string[], excludeDomains: string[]): string {
  const includeClause =
    includeDomains.length === 0
      ? ""
      : includeDomains.length === 1
        ? ` site:${includeDomains[0]}`
        : ` (${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`;
  const excludeClause =
    excludeDomains.length === 0 ? "" : ` ${excludeDomains.map((domain) => `-site:${domain}`).join(" ")}`;
  return `${query.trim()}${includeClause}${excludeClause}`.trim();
}

function buildGoogleSearchUrl(input: SearchRequestNormalization, searchQuery: string): string {
  const endpoint = process.env.GEMMA_DESKTOP_GOOGLE_SEARCH_ENDPOINT?.trim() || "https://www.google.com/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("num", String(input.maxResults));
  url.searchParams.set("hl", "en");
  const tbs = GOOGLE_RECENCY_PARAM[input.recency];
  if (tbs) {
    url.searchParams.set("tbs", tbs);
  }
  return url.toString();
}

function buildBingSearchUrl(input: SearchRequestNormalization, searchQuery: string): string {
  const endpoint = process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT?.trim() || "https://www.bing.com/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("count", String(input.maxResults));
  url.searchParams.set("setlang", "en-US");
  return url.toString();
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
    return null;
  }

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function stripTitleFromText(text: string, title: string, siteName?: string): string {
  let next = text;
  for (const token of [title, siteName]) {
    if (!token) {
      continue;
    }
    next = next.replace(token, " ");
  }
  return normalizeWhitespace(next);
}

function extractSnippetFromContainer(container: Element | null, title: string, url: string): string {
  if (!container) {
    return "";
  }

  const siteName = resolveSiteName(url);
  const candidates = Array.from(container.querySelectorAll("span, div, p"))
    .map((node) => normalizeWhitespace(node.textContent ?? ""))
    .filter((text) => text.length >= 40)
    .map((text) => stripTitleFromText(text, title, siteName))
    .filter((text) => text.length >= 40);

  const best = candidates.find((text) => text !== title) ?? stripTitleFromText(normalizeWhitespace(container.textContent ?? ""), title, siteName);
  if (best.length <= 320) {
    return best;
  }

  return `${best.slice(0, 317)}...`;
}

function extractGoogleResultUrl(anchor: HTMLAnchorElement, baseUrl: string): string | null {
  const candidates = [
    anchor.getAttribute("data-href") ?? "",
    anchor.getAttribute("data-url") ?? "",
    anchor.getAttribute("href") ?? "",
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const absolute = toAbsoluteUrl(candidate, baseUrl);
    if (!absolute) {
      continue;
    }

    try {
      const parsed = new URL(absolute);
      if (parsed.pathname.startsWith("/url") || parsed.hostname.endsWith("google.com")) {
        const redirected = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
        if (redirected) {
          return redirected;
        }
        if (parsed.pathname.startsWith("/url")) {
          continue;
        }
      }
      return absolute;
    } catch {
      continue;
    }
  }

  return null;
}

function isGoogleBlocked(html: string, status: number): boolean {
  if (status === 429) {
    return true;
  }
  return /unusual traffic|sorry\/index|detected unusual traffic|recaptcha|our systems have detected/i.test(html);
}

function parseGoogleHtml(html: string, baseUrl: string): SearchResultRecord[] {
  const dom = new JSDOM(html, { url: baseUrl });
  try {
    const document = dom.window.document;
    const results: SearchResultRecord[] = [];
    const seen = new Set<string>();
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));

    for (const anchor of anchors) {
      const title = normalizeWhitespace(anchor.querySelector("h3")?.textContent ?? "");
      if (!title) {
        continue;
      }

      const url = extractGoogleResultUrl(anchor, baseUrl);
      const normalizedUrl = url ? safeNormalizeHttpUrl(url) : null;
      if (!normalizedUrl || matchesDomain(normalizedUrl, ["google.com", "googleusercontent.com"])) {
        continue;
      }

      if (seen.has(normalizedUrl)) {
        continue;
      }

      const container = anchor.closest("div");
      const snippet = extractSnippetFromContainer(container?.parentElement ?? container, title, normalizedUrl);
      results.push({
        title,
        url: normalizedUrl,
        snippet,
        siteName: resolveSiteName(normalizedUrl),
      });
      seen.add(normalizedUrl);
    }

    return results;
  } finally {
    dom.window.close();
  }
}

function isBingBlocked(html: string, status: number): boolean {
  if (status === 429) {
    return true;
  }
  return /captcha|verify you are human|bing requires verification|sorry, but we need to show you/i.test(html);
}

function parseBingHtml(html: string, baseUrl = "https://www.bing.com/"): SearchResultRecord[] {
  const dom = new JSDOM(html, { url: baseUrl });
  try {
    const document = dom.window.document;
    const results: SearchResultRecord[] = [];
    const nodes = Array.from(document.querySelectorAll("li.b_algo"));

    for (const node of nodes) {
      const anchor = node.querySelector<HTMLAnchorElement>("h2 a[href]");
      if (!anchor) {
        continue;
      }

      const title = normalizeWhitespace(anchor.textContent ?? "");
      const url = safeNormalizeHttpUrl(anchor.href);
      if (!title || !url) {
        continue;
      }

      const snippet = normalizeWhitespace(
        node.querySelector(".b_caption p")?.textContent
        ?? node.querySelector("p")?.textContent
        ?? "",
      );

      results.push({
        title,
        url,
        snippet,
        siteName: resolveSiteName(url),
      });
    }

    return results;
  } finally {
    dom.window.close();
  }
}

function isHeadlineCandidateText(text: string): boolean {
  if (text.length < 16 || text.length > 180) {
    return false;
  }
  return !/^(home|menu|latest|live tv|watch live|video|videos|sign in|subscribe|newsletter|privacy|terms|cookies?)$/i.test(text);
}

function extractHeadlineCandidates(document: Document, baseUrl: string): FetchHeadlineRecord[] {
  const candidates = new Map<string, { record: FetchHeadlineRecord; score: number }>();
  const anchors = Array.from(
    document.querySelectorAll("main a[href], article a[href], section a[href], h1 a[href], h2 a[href], h3 a[href], a[href]"),
  );

  for (const anchor of anchors) {
    const text = normalizeWhitespace(anchor.textContent ?? "");
    if (!isHeadlineCandidateText(text)) {
      continue;
    }

    const absoluteUrl = toAbsoluteUrl(anchor.getAttribute("href") ?? "", baseUrl);
    if (!absoluteUrl) {
      continue;
    }

    let score = 0;
    if (anchor.closest("h1, h2, h3")) {
      score += 40;
    }
    if (anchor.closest("article, main")) {
      score += 12;
    }
    if (text.length >= 28 && text.length <= 110) {
      score += 14;
    }
    if (absoluteUrl.includes("/202") || absoluteUrl.includes("/news/") || absoluteUrl.includes("/article/")) {
      score += 8;
    }

    const existing = candidates.get(text);
    if (!existing || existing.score < score) {
      candidates.set(text, {
        record: {
          title: text,
          url: absoluteUrl,
        },
        score,
      });
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map((entry) => entry.record);
}

function extractMetaContent(document: Document, names: string[]): string | undefined {
  for (const name of names) {
    const value =
      document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")
      ?? document.querySelector(`meta[property="${name}"]`)?.getAttribute("content");
    if (value) {
      return normalizeWhitespace(value);
    }
  }
  return undefined;
}

function looksBlockedOrTemplate(rawHtml: string, text: string): boolean {
  const combined = `${rawHtml}\n${text}`.toLowerCase();
  return (
    /captcha|access denied|temporarily unavailable|verify you are human|bot detection|enable javascript and cookies/i.test(combined)
    || (text.length < 220 && /breaking news|live updates|latest headlines|watch live|u\.s\. edition|international edition/i.test(combined))
  );
}

function extractMainText(document: Document): string {
  const mainNode =
    document.querySelector("main")
    ?? document.querySelector("article")
    ?? document.querySelector("[role='main']")
    ?? document.body;
  return normalizeWhitespace(mainNode?.textContent ?? "");
}

function renderHeadlineSection(headlines: FetchHeadlineRecord[]): string {
  if (headlines.length === 0) {
    return "";
  }

  return [
    "Top headlines / links:",
    ...headlines.map((headline, index) => `${index + 1}. ${headline.title}\n   ${headline.url}`),
  ].join("\n");
}

function extractElementText(node: Element | null | undefined): string {
  return normalizeWhitespace(node?.textContent ?? "");
}

function isStackOverflowDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "stackoverflow.com" || hostname.endsWith(".stackexchange.com");
  } catch {
    return false;
  }
}

function extractStackOverflowContent(document: Document): FetchExtractionRecord | null {
  const questionTitle = extractElementText(document.querySelector("h1"));
  const description = extractMetaContent(document, ["description", "og:description"]);
  const questionBody = extractElementText(
    document.querySelector("#question .js-post-body, #question .s-prose, .question .js-post-body, .question .s-prose"),
  );
  const answers = Array.from(document.querySelectorAll("#answers .answer, .answer")).slice(0, 3);

  if (!questionBody && answers.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (questionTitle) {
    parts.push(`Title: ${questionTitle}`);
  }
  if (description) {
    parts.push(`Description: ${description}`);
  }
  if (questionBody) {
    parts.push(`Question:\n${questionBody}`);
  }

  const answerSections = answers
    .map((answer, index) => {
      const answerText = extractElementText(answer.querySelector(".js-post-body, .s-prose"));
      if (!answerText) {
        return null;
      }

      const accepted = answer.classList.contains("accepted-answer") || answer.querySelector(".js-accepted-answer-indicator");
      const score = extractElementText(answer.querySelector(".js-vote-count, .vote-count-post"));
      const label = accepted ? `Accepted answer ${index + 1}` : `Answer ${index + 1}`;
      const scoreLine = score ? `Score: ${score}` : "";
      return [label, scoreLine, answerText].filter(Boolean).join("\n");
    })
    .filter((value): value is string => Boolean(value));

  if (answerSections.length > 0) {
    parts.push(answerSections.join("\n\n"));
  }

  return {
    kind: "html",
    title: questionTitle || undefined,
    description,
    blockedLikely: false,
    extractedWith: "stack-overflow",
    content: parts.join("\n\n"),
  };
}

function isGitHubDomain(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function extractGitHubContent(document: Document): FetchExtractionRecord | null {
  const title = normalizeWhitespace(document.title.replace(/\s*·\s*GitHub\s*$/, ""));
  const description = extractMetaContent(document, ["description", "og:description"]);
  const readme = extractElementText(document.querySelector("article.markdown-body"));
  if (readme.length >= 120) {
    return {
      kind: "html",
      title: title || undefined,
      description,
      blockedLikely: false,
      extractedWith: "github",
      content: [
        title ? `Title: ${title}` : "",
        description ? `Description: ${description}` : "",
        `Content:\n${readme}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const comments = Array.from(document.querySelectorAll(".timeline-comment .markdown-body, .js-comment-body"))
    .map((node) => extractElementText(node))
    .filter((text) => text.length >= 40)
    .slice(0, 6);

  if (comments.length === 0) {
    return null;
  }

  return {
    kind: "html",
    title: title || undefined,
    description,
    blockedLikely: false,
    extractedWith: "github",
    content: [
      title ? `Title: ${title}` : "",
      description ? `Description: ${description}` : "",
      "Conversation:",
      ...comments.map((comment, index) => `${index + 1}. ${comment}`),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function extractHtmlContent(url: string, html: string): FetchExtractionRecord {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;

    if (isStackOverflowDomain(url)) {
      const stackOverflow = extractStackOverflowContent(document);
      if (stackOverflow) {
        return stackOverflow;
      }
    }

    if (isGitHubDomain(url)) {
      const github = extractGitHubContent(document);
      if (github) {
        return github;
      }
    }

    const readability = new Readability(document.cloneNode(true) as Document, {
      charThreshold: 140,
    });
    const article = readability.parse();
    const title = normalizeWhitespace(article?.title ?? document.title ?? "");
    const description = extractMetaContent(document, ["description", "og:description", "twitter:description"]);
    const byline = normalizeWhitespace(article?.byline ?? "");
    const excerpt = normalizeWhitespace(article?.excerpt ?? "");
    const articleText = normalizeWhitespace(article?.textContent ?? "");
    const mainText = extractMainText(document);
    const headlines = extractHeadlineCandidates(document, url);
    const blockedLikely = looksBlockedOrTemplate(html, articleText || mainText);

    const parts: string[] = [];
    let extractedWith: FetchExtractionRecord["extractedWith"] = "body-fallback";

    if (title) {
      parts.push(`Title: ${title}`);
    }
    if (description) {
      parts.push(`Description: ${description}`);
    }
    if (byline) {
      parts.push(`Byline: ${byline}`);
    }
    if (excerpt && excerpt !== description) {
      parts.push(`Excerpt: ${excerpt}`);
    }

    if (articleText.length >= 280) {
      extractedWith = "readability";
      parts.push(`Content:\n${articleText}`);
    } else if (headlines.length >= 3) {
      extractedWith = "headline-fallback";
      parts.push(renderHeadlineSection(headlines));
      if (mainText.length >= 220) {
        parts.push(`Page text:\n${mainText}`);
      }
    } else {
      extractedWith = "body-fallback";
      parts.push(`Page text:\n${mainText}`);
    }

    if (blockedLikely) {
      parts.push("Note: this page appears to rely on anti-bot checks or heavy client-side rendering, so the extracted text may be incomplete.");
    }

    return {
      kind: "html",
      title: title || undefined,
      description,
      blockedLikely,
      extractedWith,
      headlines: headlines.length > 0 ? headlines : undefined,
      content: parts.filter(Boolean).join("\n\n"),
    };
  } finally {
    dom.window.close();
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getXmlText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return normalizeWhitespace(value.map((entry) => getXmlText(entry)).join(" "));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["#text"] === "string") {
      return normalizeWhitespace(record["#text"]);
    }
    return normalizeWhitespace(Object.values(record).map((entry) => getXmlText(entry)).join(" "));
  }
  return "";
}

function getAtomLink(entry: Record<string, unknown>): string | undefined {
  const links = toArray(entry.link as Record<string, unknown> | Record<string, unknown>[] | undefined);
  for (const link of links) {
    if (typeof link === "string") {
      return link;
    }
    if (typeof link.href === "string") {
      const rel = typeof link.rel === "string" ? link.rel : "alternate";
      if (rel === "alternate") {
        return link.href;
      }
    }
  }
  return undefined;
}

function extractFeedContent(xmlText: string): FetchExtractionRecord {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    textNodeName: "#text",
  });
  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const parts: string[] = [];

  if (parsed.rss && typeof parsed.rss === "object") {
    const channel = (parsed.rss as Record<string, unknown>).channel as Record<string, unknown> | undefined;
    const title = getXmlText(channel?.title);
    const description = getXmlText(channel?.description);
    const items = toArray(channel?.item as Record<string, unknown> | Record<string, unknown>[] | undefined).slice(0, 10);
    if (title) {
      parts.push(`Feed: ${title}`);
    }
    if (description) {
      parts.push(`Description: ${description}`);
    }
    if (items.length > 0) {
      parts.push(
        [
          "Entries:",
          ...items.map((item, index) => {
            const itemTitle = getXmlText(item.title);
            const link = getXmlText(item.link);
            const summary = getXmlText(item.description);
            const published = getXmlText(item.pubDate);
            return [
              `${index + 1}. ${itemTitle || "Untitled"}`,
              link ? `   ${link}` : "",
              published ? `   Published: ${published}` : "",
              summary ? `   Summary: ${summary}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          }),
        ].join("\n"),
      );
    }

    return {
      kind: "feed",
      title: title || undefined,
      description: description || undefined,
      blockedLikely: false,
      extractedWith: "feed-parser",
      content: parts.join("\n\n"),
    };
  }

  if (parsed.feed && typeof parsed.feed === "object") {
    const feed = parsed.feed as Record<string, unknown>;
    const title = getXmlText(feed.title);
    const subtitle = getXmlText(feed.subtitle);
    const entries = toArray(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined).slice(0, 10);
    if (title) {
      parts.push(`Feed: ${title}`);
    }
    if (subtitle) {
      parts.push(`Description: ${subtitle}`);
    }
    if (entries.length > 0) {
      parts.push(
        [
          "Entries:",
          ...entries.map((entry, index) => {
            const entryTitle = getXmlText(entry.title);
            const link = getAtomLink(entry);
            const summary = getXmlText(entry.summary) || getXmlText(entry.content);
            const published = getXmlText(entry.updated) || getXmlText(entry.published);
            return [
              `${index + 1}. ${entryTitle || "Untitled"}`,
              link ? `   ${link}` : "",
              published ? `   Published: ${published}` : "",
              summary ? `   Summary: ${summary}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          }),
        ].join("\n"),
      );
    }

    return {
      kind: "feed",
      title: title || undefined,
      description: subtitle || undefined,
      blockedLikely: false,
      extractedWith: "feed-parser",
      content: parts.join("\n\n"),
    };
  }

  return {
    kind: "text",
    blockedLikely: false,
    extractedWith: "text",
    content: stripHtml(xmlText),
  };
}

async function fetchAndExtractUrl(
  input: FetchUrlInput,
  options: WebExecutionOptions = {},
): Promise<FetchExtractionResult> {
  emitWebProgress(options, {
    id: "fetch-resolve",
    label: "Resolving URL",
  });
  const requestedUrl = normalizeUrl(input.url);
  const cached = PAGE_CACHE.get(requestedUrl);
  if (cached) {
    emitWebProgress(options, {
      id: "fetch-cache",
      label: "Using cached page",
      tone: "success",
    });
    return {
      record: cached,
      cacheHit: true,
    };
  }

  const fetchUrl = convertGithubBlobUrlToRaw(requestedUrl);
  emitWebProgress(options, {
    id: "fetch-request",
    label: "Requesting page",
  });
  const response = await requestText(fetchUrl, {
    signal: options.signal,
    emitProgress: options.emitProgress,
  });
  if ((response.attempts?.length ?? 0) > 0) {
    emitWebProgress(options, {
      id: "fetch-recovered",
      label: `Recovered after ${response.attempts.length} ${response.attempts.length === 1 ? "retry" : "retries"}`,
      tone: "success",
    });
  }

  if (response.status >= 400) {
    throw new GemmaDesktopError("tool_execution_failed", `Failed to fetch ${requestedUrl}: ${response.status}`);
  }

  emitWebProgress(options, {
    id: "fetch-parse",
    label: buildFetchContentParseLabel(response.contentType, response.body),
  });

  let parsed: FetchExtractionRecord;
  if (isHtmlContentType(response.contentType)) {
    emitWebProgress(options, {
      id: "fetch-extract",
      label: "Extracting readable content",
    });
    parsed = extractHtmlContent(response.url, response.body);
  } else if (isJsonContentType(response.contentType) || looksLikeJson(response.body)) {
    const pretty = JSON.stringify(JSON.parse(response.body), null, 2);
    parsed = {
      kind: "json",
      blockedLikely: false,
      extractedWith: "json",
      content: pretty,
    };
  } else if (isXmlContentType(response.contentType) || looksLikeXml(response.body)) {
    parsed = extractFeedContent(response.body);
  } else {
    parsed = {
      kind: "text",
      blockedLikely: false,
      extractedWith: "text",
      content: response.body.trim(),
    };
  }

  const record: CachedFetchRecord = {
    requestedUrl,
    resolvedUrl: response.url,
    status: response.status,
    contentType: response.contentType,
    parsed,
  };
  PAGE_CACHE.set(requestedUrl, record);
  return {
    record,
    cacheHit: false,
    requestAttempts: response.attempts,
  };
}

function materializeFetchResult(
  record: CachedFetchRecord,
  maxChars: number,
  requestAttempts: RequestAttemptRecord[] = [],
): FetchExecutionResult {
  const truncated = truncateContent(record.parsed.content, maxChars);
  return {
    output: truncated.output,
    structuredOutput: {
      requestedUrl: record.requestedUrl,
      resolvedUrl: record.resolvedUrl,
      status: record.status,
      contentType: record.contentType,
      kind: record.parsed.kind,
      title: record.parsed.title,
      description: record.parsed.description,
      blockedLikely: record.parsed.blockedLikely,
      extractedWith: record.parsed.extractedWith,
      headlines: record.parsed.headlines,
      content: truncated.output,
      contentLength: record.parsed.content.length,
    },
    metadata: {
      truncated: truncated.truncated,
      retryCount: requestAttempts.length,
      recoveredAfterRetry: requestAttempts.length > 0,
      transientRecovery:
        requestAttempts.length > 0 && requestAttempts.every((attempt) => attempt.transientLikely),
      requestAttempts,
    },
  };
}

function normalizeSearchInput(input: SearchWebInput): SearchRequestNormalization {
  const depth = input.depth ?? "standard";
  return {
    query: normalizeWhitespace(input.query),
    depth,
    maxResults: clampInteger(input.maxResults ?? input.limit, 1, 20, DEFAULT_MAX_RESULTS),
    maxPages: clampInteger(
      input.maxPages,
      1,
      8,
      depth === "deep" ? DEFAULT_DEEP_MAX_PAGES : DEFAULT_STANDARD_MAX_PAGES,
    ),
    maxCharsPerPage: clampInteger(input.maxCharsPerPage, 100, 50_000, DEFAULT_MAX_CHARS_PER_PAGE),
    includeDomains: (input.includeDomains ?? []).map(normalizeDomain).filter(Boolean),
    excludeDomains: (input.excludeDomains ?? []).map(normalizeDomain).filter(Boolean),
    engine: input.engine ?? "auto",
    recency: input.recency ?? "any",
  };
}

function cacheKeyForSearch(
  engine: ResolvedSearchEngine,
  input: SearchRequestNormalization,
  searchQuery: string,
  searchUrl: string,
): string {
  return JSON.stringify({
    engine,
    searchUrl,
    searchQuery,
    maxResults: input.maxResults,
    recency: input.recency,
  });
}

function filterSearchResults(results: SearchResultRecord[], input: SearchRequestNormalization): SearchResultRecord[] {
  return results.filter((result) => {
    if (input.includeDomains.length > 0 && !matchesDomain(result.url, input.includeDomains)) {
      return false;
    }
    if (input.excludeDomains.length > 0 && matchesDomain(result.url, input.excludeDomains)) {
      return false;
    }
    return true;
  });
}

async function executeSearchOnEngine(
  engine: ResolvedSearchEngine,
  input: SearchRequestNormalization,
  query: string,
  options: WebExecutionOptions = {},
): Promise<EngineSearchOutcome> {
  const searchQuery = buildSearchQuery(query, input.includeDomains, input.excludeDomains);
  const searchUrl =
    engine === "google"
      ? buildGoogleSearchUrl(input, searchQuery)
      : buildBingSearchUrl(input, searchQuery);
  const cacheKey = cacheKeyForSearch(engine, input, searchQuery, searchUrl);
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    emitWebProgress(options, {
      id: "search-engine-cache",
      label: `Using cached ${formatEngineLabel(engine)} results`,
      tone: "success",
    });
    return cached.outcome;
  }

  try {
    emitWebProgress(options, {
      id: "search-engine",
      label: `Searching ${formatEngineLabel(engine)}`,
    });
    const response = await requestText(searchUrl, {
      signal: options.signal,
      searchRequest: true,
      emitProgress: options.emitProgress,
    });

    const blocked =
      engine === "google"
        ? isGoogleBlocked(response.body, response.status)
        : isBingBlocked(response.body, response.status);

    let parsedResults =
      engine === "google"
        ? parseGoogleHtml(response.body, response.url)
        : parseBingHtml(response.body, response.url);

    parsedResults = filterSearchResults(parsedResults, input)
      .slice(0, input.maxResults)
      .map((result, index) => ({
        ...result,
        engine,
        query,
        rank: index + 1,
      }));

    const outcome: EngineSearchOutcome = {
      engine,
      searchQuery,
      results: parsedResults,
      attemptedUrl: searchUrl,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      blocked,
      parseFailed: !blocked && response.status < 400 && parsedResults.length === 0,
      error:
        response.status >= 400
          ? `Search request failed with status ${response.status}.`
          : blocked
            ? `${engine} blocked the search request.`
            : parsedResults.length === 0
              ? `${engine} returned no parseable search results.`
              : undefined,
    };

    if (outcome.parseFailed) {
      debugWeb("search-parse-failed", {
        engine,
        searchUrl,
        sample: response.body.slice(0, 1_500),
      });
    }

    SEARCH_CACHE.set(cacheKey, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      outcome,
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
    const outcome: EngineSearchOutcome = {
      engine,
      searchQuery,
      results: [],
      attemptedUrl: searchUrl,
      status: 0,
      fetchedAt: new Date().toISOString(),
      error: message,
    };
    debugWeb("search-request-failed", {
      engine,
      searchUrl,
      error: message,
    });
    return outcome;
  }
}

function resolveEngineOrder(engine: SearchEngine): ResolvedSearchEngine[] {
  if (engine === "auto") {
    return ["google", "bing"];
  }
  return [engine];
}

function renderSearchResults(results: SearchResultRecord[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.url,
        result.snippet ? `Snippet: ${result.snippet}` : "",
        result.engine ? `Engine: ${result.engine}` : "",
        result.occurrences && result.occurrences > 1 ? `Seen in ${result.occurrences} searches` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function renderFetchedPages(pages: SearchFetchedPageRecord[]): string {
  if (pages.length === 0) {
    return "";
  }

  return [
    "Fetched pages:",
    ...pages.map((page, index) =>
      [
        `${index + 1}. ${page.title || page.resolvedUrl}`,
        page.resolvedUrl,
        page.relevanceScore ? `Relevance score: ${page.relevanceScore}` : "",
        page.content,
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  ].join("\n\n");
}

function buildZeroResultOutput(
  query: string,
  attempts: EngineSearchOutcome[],
): { output: string; transientFailureLikely: boolean; executionFailure: boolean } {
  const summary = attempts
    .map((attempt) => `${attempt.engine}: ${attempt.error ?? "no results"}`)
    .join("; ");
  const executionFailure =
    attempts.length > 0
    && attempts.some((attempt) => typeof attempt.error === "string" && attempt.error.length > 0)
    && attempts.every((attempt) => attempt.results.length === 0 && Boolean(attempt.error));
  const transientFailureLikely =
    executionFailure
    && attempts.every((attempt) =>
      typeof attempt.error === "string" && isLikelyTransientNetworkMessage(attempt.error),
    );

  if (executionFailure) {
    return {
      output: [
        transientFailureLikely
          ? `Search failed for "${query}" after retrying available engines.`
          : `Search could not produce results for "${query}".`,
        summary,
        transientFailureLikely
          ? "This looks like a transient network or remote-site issue."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      transientFailureLikely,
      executionFailure,
    };
  }

  return {
    output: `No results found for "${query}". ${summary}`.trim(),
    transientFailureLikely: false,
    executionFailure: false,
  };
}

function buildSearchOutput(
  input: SearchRequestNormalization,
  results: SearchResultRecord[],
  pages: SearchFetchedPageRecord[],
  queriesRun: string[],
): string {
  const parts = [
    queriesRun.length > 1 ? `Queries run: ${queriesRun.join(" | ")}` : "",
    renderSearchResults(results),
    input.depth === "quick" ? "" : renderFetchedPages(pages),
  ].filter(Boolean);

  return parts.join("\n\n");
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  worker: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  const runnerCount = Math.min(Math.max(concurrency, 1), values.length);

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= values.length) {
          return;
        }
        results[currentIndex] = await worker(values[currentIndex]!, currentIndex);
      }
    }),
  );

  return results;
}

async function fetchPagesForResults(
  results: SearchResultRecord[],
  maxPages: number,
  maxCharsPerPage: number,
  options: {
    signal?: AbortSignal;
    onPageFetched?: (count: number, total: number) => void;
  } = {},
): Promise<Array<{ result: SearchResultRecord; page: SearchFetchedPageRecord }>> {
  const selected = results.slice(0, maxPages);
  let fetchedCount = 0;
  const fetched = await mapWithConcurrency<
    SearchResultRecord,
    { result: SearchResultRecord; page: SearchFetchedPageRecord } | null
  >(selected, 4, async (result) => {
    try {
      const page = await executeFetchUrl(
        {
          url: result.url,
          maxChars: maxCharsPerPage,
        },
        {
          signal: options.signal,
        },
      );
      fetchedCount += 1;
      options.onPageFetched?.(fetchedCount, selected.length);
      return {
        result,
        page: {
          ...page.structuredOutput,
          relevanceScore: result.relevanceScore,
        },
      };
    } catch (error) {
      debugWeb("page-fetch-skipped", {
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  return fetched.filter(
    (entry): entry is { result: SearchResultRecord; page: SearchFetchedPageRecord } => entry !== null,
  );
}

function generateVariantQueries(query: string): string[] {
  const base = normalizeWhitespace(query);
  const currentYear = String(new Date().getFullYear());
  const candidates = [
    base,
    /\bofficial\b|\bdocs?\b/i.test(base) ? `${base} example` : `${base} official documentation`,
    /\bexample\b/i.test(base) ? `${base} troubleshooting` : `${base} example`,
    new RegExp(`\\b${currentYear}\\b`).test(base) ? base : `${base} ${currentYear}`,
  ];

  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    variants.push(normalized);
    if (variants.length >= 3) {
      break;
    }
  }

  return variants;
}

function rankSearchResults(outcomes: EngineSearchOutcome[]): SearchResultRecord[] {
  const aggregated = new Map<string, SearchResultRecord & { occurrences: number; relevanceScore: number }>();

  for (const outcome of outcomes) {
    for (const [index, result] of outcome.results.entries()) {
      const existing = aggregated.get(result.url);
      const contribution = 100 - index;
      if (!existing) {
        aggregated.set(result.url, {
          ...result,
          occurrences: 1,
          relevanceScore: contribution,
        });
        continue;
      }

      existing.occurrences += 1;
      existing.relevanceScore += contribution;
      if (result.snippet.length > existing.snippet.length) {
        existing.snippet = result.snippet;
      }
      if (!existing.title && result.title) {
        existing.title = result.title;
      }
    }
  }

  return [...aggregated.values()]
    .sort((left, right) => {
      if (right.occurrences !== left.occurrences) {
        return right.occurrences - left.occurrences;
      }
      if ((right.relevanceScore ?? 0) !== (left.relevanceScore ?? 0)) {
        return (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0);
      }
      return left.url.localeCompare(right.url);
    })
    .map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
}

async function _executeQuickOrStandardSearch(
  input: SearchRequestNormalization,
  options: WebExecutionOptions = {},
): Promise<SearchExecutionResult> {
  const attempts: EngineSearchOutcome[] = [];
  const engines = resolveEngineOrder(input.engine);

  for (const [engineIndex, engine] of engines.entries()) {
    const outcome = await executeSearchOnEngine(engine, input, input.query, options);
    attempts.push(outcome);
    if (outcome.results.length > 0) {
      emitWebProgress(options, {
        id: "search-results",
        label: `Found ${formatCountLabel(outcome.results.length, "result")}`,
        tone: "success",
      });
      const shouldFetchPages = input.depth !== "quick" && outcome.results.slice(0, input.maxPages).length > 0;
      if (shouldFetchPages) {
        emitWebProgress(options, {
          id: "search-fetch-pages",
          label: "Fetching top pages",
        });
      }
      const pages =
        input.depth === "quick"
          ? []
          : (await fetchPagesForResults(outcome.results, input.maxPages, input.maxCharsPerPage, {
              signal: options.signal,
              onPageFetched: (count) => {
                emitWebProgress(options, {
                  id: "search-pages-fetched",
                  label: `Fetched ${formatCountLabel(count, "page")}`,
                  tone: "success",
                });
              },
            })).map(
              (entry) => entry.page,
            );
      emitWebProgress(options, {
        id: "search-complete",
        label: "Search complete",
        tone: "success",
      });
      return {
        output: buildSearchOutput(input, outcome.results, pages, [input.query]),
        structuredOutput: {
          provider: outcome.engine,
          engine: outcome.engine,
          query: input.query,
          depth: input.depth,
          searchQuery: outcome.searchQuery,
          queriesRun: [input.query],
          resultCount: outcome.results.length,
          pageCount: pages.length,
          results: outcome.results,
          pages,
          attemptedEngines: attempts.map((attempt) => attempt.engine),
          fetchedAt: new Date().toISOString(),
        },
        metadata: {
          truncated: outcome.results.length >= input.maxResults,
          attemptedEngines: attempts.map((attempt) => attempt.engine),
          failedEngines: attempts.filter((attempt) => attempt.results.length === 0).map((attempt) => ({
            engine: attempt.engine,
            error: attempt.error,
          })),
        },
      };
    }

    if (engineIndex < engines.length - 1) {
      emitWebProgress(options, {
        id: "search-fallback",
        label: "Trying next engine",
        tone: "warning",
      });
    }
  }

  emitWebProgress(options, {
    id: "search-complete",
    label: "Search complete",
    tone: "warning",
  });

  const failureSummary = buildZeroResultOutput(input.query, attempts);

  return {
    output: failureSummary.output,
    structuredOutput: {
      provider: attempts.length > 1 ? "multi" : attempts[0]?.engine ?? "google",
      engine: attempts.length > 1 ? "multi" : attempts[0]?.engine ?? "google",
      query: input.query,
      depth: input.depth,
      searchQuery: buildSearchQuery(input.query, input.includeDomains, input.excludeDomains),
      queriesRun: [input.query],
      resultCount: 0,
      pageCount: 0,
      results: [],
      pages: [],
      attemptedEngines: attempts.map((attempt) => attempt.engine),
      fetchedAt: new Date().toISOString(),
    },
    metadata: {
      attemptedEngines: attempts.map((attempt) => attempt.engine),
      executionFailure: failureSummary.executionFailure,
      transientFailureLikely: failureSummary.transientFailureLikely,
      failedEngines: attempts.map((attempt) => ({
        engine: attempt.engine,
        error: attempt.error,
      })),
    },
  };
}

async function _executeDeepSearch(
  input: SearchRequestNormalization,
  options: WebExecutionOptions = {},
): Promise<SearchExecutionResult> {
  emitWebProgress(options, {
    id: "search-variants",
    label: "Generating variant queries",
  });
  const queriesRun = generateVariantQueries(input.query);
  const engines = resolveEngineOrder(input.engine);
  const tasks = queriesRun.flatMap((query) => engines.map((engine) => ({ query, engine })));
  let completedSearches = 0;

  const outcomes = await mapWithConcurrency(tasks, 2, async (task) => {
    const outcome = await executeSearchOnEngine(task.engine, input, task.query, options);
    completedSearches += 1;
    emitWebProgress(options, {
      id: "search-pass-count",
      label: `Searched ${completedSearches} of ${tasks.length} query/engine passes`,
      tone: "success",
    });
    return outcome;
  });
  const successfulOutcomes = outcomes.filter((outcome) => outcome.results.length > 0);
  emitWebProgress(options, {
    id: "search-ranking",
    label: "Ranking sources",
  });
  const rankedResults = rankSearchResults(successfulOutcomes).slice(0, input.maxResults);
  emitWebProgress(options, {
    id: "search-results",
    label: `Found ${formatCountLabel(rankedResults.length, "result")}`,
    tone: rankedResults.length > 0 ? "success" : "warning",
  });
  const shouldFetchPages = rankedResults.slice(0, input.maxPages).length > 0;
  if (shouldFetchPages) {
    emitWebProgress(options, {
      id: "search-fetch-pages",
      label: "Fetching top pages",
    });
  }
  const pages = (await fetchPagesForResults(rankedResults, input.maxPages, input.maxCharsPerPage, {
    signal: options.signal,
    onPageFetched: (count) => {
      emitWebProgress(options, {
        id: "search-pages-fetched",
        label: `Fetched ${formatCountLabel(count, "page")}`,
        tone: "success",
      });
    },
  })).map(
    (entry) => entry.page,
  );
  const provider: SearchExecutionProvider = successfulOutcomes.length > 1 ? "multi" : successfulOutcomes[0]?.engine ?? "multi";

  emitWebProgress(options, {
    id: "search-complete",
    label: "Search complete",
    tone: rankedResults.length > 0 ? "success" : "warning",
  });

  const failureSummary = buildZeroResultOutput(input.query, outcomes);

  return {
    output:
      rankedResults.length > 0
        ? buildSearchOutput(input, rankedResults, pages, queriesRun)
        : [
            queriesRun.length > 1 ? `Queries run: ${queriesRun.join(" | ")}` : "",
            failureSummary.output,
          ]
            .filter(Boolean)
            .join("\n\n"),
    structuredOutput: {
      provider,
      engine: provider,
      query: input.query,
      depth: input.depth,
      searchQuery: buildSearchQuery(input.query, input.includeDomains, input.excludeDomains),
      queriesRun,
      resultCount: rankedResults.length,
      pageCount: pages.length,
      results: rankedResults,
      pages,
      attemptedEngines: [...new Set(outcomes.map((outcome) => outcome.engine))],
      fetchedAt: new Date().toISOString(),
    },
    metadata: {
      attemptedEngines: [...new Set(outcomes.map((outcome) => outcome.engine))],
      executionFailure: failureSummary.executionFailure,
      transientFailureLikely: failureSummary.transientFailureLikely,
      failedSearches: outcomes
        .filter((outcome) => outcome.results.length === 0)
        .map((outcome) => ({
          engine: outcome.engine,
          error: outcome.error,
          searchQuery: outcome.searchQuery,
        })),
    },
  };
}

export async function executeSearchWeb(
  input: SearchWebInput,
  options: WebExecutionOptions = {},
): Promise<SearchExecutionResult> {
  emitWebProgress(options, {
    id: "search-prepare",
    label: "Preparing search query",
  });
  const normalized = normalizeSearchInput(input);
  if (normalized.query.length === 0) {
    throw new GemmaDesktopError("invalid_tool_input", "Search query must not be empty.");
  }

  const apiKeyFromOptions = options.geminiApiKey?.trim();
  const apiKeyFromEnv = process.env.GEMINI_API_KEY?.trim();
  const apiKey = apiKeyFromOptions || apiKeyFromEnv || "";
  const override = searchProviderOverride;

  if (!override && apiKey.length === 0) {
    emitWebProgress(options, {
      id: "search-complete",
      label: "Search unavailable",
      tone: "warning",
    });
    throw new GemmaDesktopError(
      "tool_execution_failed",
      "No Gemini API key is configured, so web search cannot run. Tell the user to open Gemma Desktop -> Settings -> Integrations and paste a Gemini API key from https://aistudio.google.com/app/apikey. Web search will stay unavailable until a key is set.",
      {
        details: {
          provider: "gemini-api",
          errorKind: "missing_key",
        },
      },
    );
  }

  const geminiInput: GeminiApiSearchInput = {
    query: normalized.query,
    maxResults: normalized.maxResults,
    includeDomains: normalized.includeDomains,
    excludeDomains: normalized.excludeDomains,
    apiKey,
    model: options.geminiApiModel,
  };

  emitWebProgress(options, {
    id: "search-gemini",
    label: "Running Gemini google_search grounding",
  });

  let geminiResult: GeminiApiSearchResponse;
  try {
    geminiResult = override
      ? await override(geminiInput, options)
      : await executeGeminiApiSearch(geminiInput, undefined, { signal: options.signal });
  } catch (error) {
    emitWebProgress(options, {
      id: "search-complete",
      label: "Search failed",
      tone: "warning",
    });
    throw error;
  }

  const mappedResults: SearchResultRecord[] = geminiResult.sources.map((source, index) => ({
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    siteName: resolveSiteName(source.url),
    rank: index + 1,
    query: normalized.query,
  }));
  const filteredResults = filterSearchResults(mappedResults, normalized).slice(0, normalized.maxResults);

  emitWebProgress(options, {
    id: "search-results",
    label: `Found ${formatCountLabel(filteredResults.length, "result")}`,
    tone: filteredResults.length > 0 ? "success" : "warning",
  });

  const shouldFetchPages = normalized.depth !== "quick" && filteredResults.slice(0, normalized.maxPages).length > 0;
  if (shouldFetchPages) {
    emitWebProgress(options, {
      id: "search-fetch-pages",
      label: "Fetching top pages",
    });
  }

  const pages = normalized.depth === "quick"
    ? []
    : (await fetchPagesForResults(filteredResults, normalized.maxPages, normalized.maxCharsPerPage, {
        signal: options.signal,
        onPageFetched: (count) => {
          emitWebProgress(options, {
            id: "search-pages-fetched",
            label: `Fetched ${formatCountLabel(count, "page")}`,
            tone: "success",
          });
        },
      })).map((entry) => entry.page);

  emitWebProgress(options, {
    id: "search-complete",
    label: "Search complete",
    tone: "success",
  });

  const queriesRun = geminiResult.webSearchQueries.length > 0
    ? geminiResult.webSearchQueries
    : [normalized.query];
  const searchQuery = buildSearchQuery(
    normalized.query,
    normalized.includeDomains,
    normalized.excludeDomains,
  );

  return {
    output: [
      geminiResult.summary ? `Summary: ${geminiResult.summary}` : "",
      renderSearchResults(filteredResults),
      normalized.depth === "quick" ? "" : renderFetchedPages(pages),
    ].filter(Boolean).join("\n\n"),
    structuredOutput: {
      provider: "gemini-api",
      engine: "gemini-api",
      query: normalized.query,
      depth: normalized.depth,
      searchQuery,
      queriesRun,
      resultCount: filteredResults.length,
      pageCount: pages.length,
      results: filteredResults,
      pages,
      attemptedEngines: ["gemini-api"],
      fetchedAt: new Date().toISOString(),
      summary: geminiResult.summary,
    },
    metadata: {
      provider: "gemini-api",
      model: geminiResult.model,
      durationMs: geminiResult.durationMs,
      summary: geminiResult.summary,
      warnings: geminiResult.warnings,
      webSearchQueries: geminiResult.webSearchQueries,
      truncated: filteredResults.length >= normalized.maxResults,
    },
  };
}

export async function executeFetchUrl(
  input: FetchUrlInput,
  options: WebExecutionOptions = {},
): Promise<FetchExecutionResult> {
  const { record, requestAttempts } = await fetchAndExtractUrl(input, options);
  const result = materializeFetchResult(
    record,
    clampInteger(input.maxChars, 100, 50_000, 12_000),
    requestAttempts,
  );
  emitWebProgress(options, {
    id: "fetch-complete",
    label: "Fetched page",
    tone: "success",
  });
  return result;
}

export const __testing = {
  buildRequestFailureMessage,
  buildSearchQuery,
  buildZeroResultOutput,
  convertGithubBlobUrlToRaw,
  extractFeedContent,
  extractHtmlContent,
  generateVariantQueries,
  isAbortError,
  isLikelyTransientNetworkError,
  isLikelyTransientNetworkMessage,
  parseBingHtml,
  parseGoogleHtml,
  rankSearchResults,
  shouldFallbackToNativeFetch,
};
