import { GemmaDesktopError } from "@gemma-desktop/sdk-core";
import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";

export const GEMINI_API_SEARCH_DEFAULT_MODEL = "gemini-3-flash-preview";
export const GEMINI_API_SEARCH_TIMEOUT_MS = 45_000;

export type GeminiApiSearchErrorKind =
  | "missing_key"
  | "auth_invalid"
  | "quota_exhausted"
  | "capacity_exhausted"
  | "timeout"
  | "network_error"
  | "safety_blocked"
  | "no_results"
  | "api_error";

export interface GeminiApiSearchInput {
  query: string;
  maxResults: number;
  includeDomains: string[];
  excludeDomains: string[];
  apiKey: string;
  model?: string;
}

export interface GeminiApiSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface GeminiApiSearchResponse {
  summary: string;
  sources: GeminiApiSearchSource[];
  model: string;
  durationMs: number;
  webSearchQueries: string[];
  searchEntryPointHtml?: string;
  warnings?: string[];
}

type GenerateContentFn = (args: {
  model: string;
  contents: string;
  config: {
    tools: Array<{ googleSearch: Record<string, never> }>;
  };
}) => Promise<GenerateContentResponse>;

export interface GeminiApiSearchDeps {
  generateContent?: GenerateContentFn;
  now?: () => number;
  createClient?: (apiKey: string) => { models: { generateContent: GenerateContentFn } };
}

export async function executeGeminiApiSearch(
  input: GeminiApiSearchInput,
  deps: GeminiApiSearchDeps = {},
  options: { signal?: AbortSignal } = {},
): Promise<GeminiApiSearchResponse> {
  const query = input.query.trim();
  if (query.length === 0) {
    throw new GemmaDesktopError("invalid_tool_input", "Search query must not be empty.");
  }

  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw buildApiSearchError({
      kind: "missing_key",
      reason:
        "No Gemini API key is configured, so web search cannot run. Tell the user to open Gemma Desktop -> Settings -> Integrations and paste a Gemini API key from https://aistudio.google.com/app/apikey before retrying the search.",
    });
  }

  const model = input.model?.trim() || GEMINI_API_SEARCH_DEFAULT_MODEL;
  const prompt = buildGeminiApiSearchPrompt({ ...input, query });
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  let generateContent: GenerateContentFn;
  if (deps.generateContent) {
    generateContent = deps.generateContent;
  } else {
    const client = deps.createClient?.(apiKey) ?? new GoogleGenAI({ apiKey });
    generateContent = client.models.generateContent.bind(client.models);
  }

  let response: GenerateContentResponse;
  try {
    response = await withTimeout(
      generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      }),
      GEMINI_API_SEARCH_TIMEOUT_MS,
      options.signal,
    );
  } catch (error) {
    throw classifyApiSearchFailure(error, {
      durationMs: Math.max(now() - startedAt, 1),
      model,
    });
  }

  const durationMs = Math.max(now() - startedAt, 1);
  return mapResponseToSearchResult(response, { ...input, query, model }, durationMs);
}

export function buildGeminiApiSearchPrompt(input: GeminiApiSearchInput): string {
  const constraints: string[] = [];
  if (input.includeDomains.length > 0) {
    constraints.push(
      `Constrain results to these domains: ${input.includeDomains.join(", ")}.`,
    );
  }
  if (input.excludeDomains.length > 0) {
    constraints.push(
      `Avoid these domains: ${input.excludeDomains.join(", ")}.`,
    );
  }
  const constraintLine = constraints.length > 0 ? `\n${constraints.join(" ")}` : "";
  return [
    "You are a web research backend for another AI agent. Use the googleSearch tool to find current, relevant information for this query:",
    "",
    `Query: ${input.query}`,
    constraintLine,
    "",
    "Write a 2-4 sentence synthesis of what the search returned. Cite specific facts. Do not refuse; if the search surfaced anything, summarize it.",
    `Target at most ${input.maxResults} sources. Structured source URLs will be attached automatically from grounding metadata; do not invent URLs in your prose.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function mapResponseToSearchResult(
  response: GenerateContentResponse,
  input: GeminiApiSearchInput & { model: string },
  durationMs: number,
): GeminiApiSearchResponse {
  const candidate = response.candidates?.[0];
  const summary = (response.text ?? "").trim();
  const grounding = candidate?.groundingMetadata;
  const webSearchQueries = grounding?.webSearchQueries ?? [];
  const chunks = grounding?.groundingChunks ?? [];
  const supports = grounding?.groundingSupports ?? [];

  const chunkSnippets = new Map<number, string>();
  for (const support of supports) {
    const text = support.segment?.text?.trim();
    if (!text) {
      continue;
    }
    for (const chunkIndex of support.groundingChunkIndices ?? []) {
      if (chunkSnippets.has(chunkIndex)) {
        continue;
      }
      chunkSnippets.set(chunkIndex, text);
    }
  }

  const rawSources: GeminiApiSearchSource[] = [];
  const seenUrls = new Set<string>();
  chunks.forEach((chunk, index) => {
    const uri = chunk.web?.uri?.trim();
    if (!uri || !/^https?:\/\//i.test(uri)) {
      return;
    }
    if (seenUrls.has(uri)) {
      return;
    }
    seenUrls.add(uri);
    const title = chunk.web?.title?.trim() || uri;
    const snippet = chunkSnippets.get(index) ?? "";
    rawSources.push({ title, url: uri, snippet });
  });

  const filtered = filterSourcesByDomains(rawSources, input);
  const sources = filtered.slice(0, input.maxResults);

  const warnings: string[] = [];
  if (candidate?.finishReason && String(candidate.finishReason) !== "STOP") {
    warnings.push(`Gemini finished with reason ${candidate.finishReason}.`);
  }

  if (summary.length === 0 && sources.length === 0) {
    throw buildApiSearchError({
      kind: "no_results",
      reason: `Gemini Search returned no usable summary or sources for "${input.query}". Tell the user the search backend produced nothing and suggest rephrasing the query.`,
      details: {
        durationMs,
        model: input.model,
        webSearchQueries,
      },
    });
  }

  return {
    summary: summary || `No summary returned. Grounding surfaced ${sources.length} source(s).`,
    sources,
    model: input.model,
    durationMs,
    webSearchQueries,
    searchEntryPointHtml: grounding?.searchEntryPoint?.renderedContent,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function filterSourcesByDomains(
  sources: GeminiApiSearchSource[],
  input: GeminiApiSearchInput,
): GeminiApiSearchSource[] {
  if (input.includeDomains.length === 0 && input.excludeDomains.length === 0) {
    return sources;
  }
  const include = input.includeDomains.map((domain) => domain.toLowerCase());
  const exclude = input.excludeDomains.map((domain) => domain.toLowerCase());
  return sources.filter((source) => {
    let hostname: string;
    try {
      hostname = new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return false;
    }
    if (include.length > 0 && !include.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return false;
    }
    if (exclude.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return false;
    }
    return true;
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Gemini API request timed out after ${timeoutMs}ms.`);
      (error as Error & { code?: string }).code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new Error("Gemini API request was aborted.");
      (error as Error & { name: string }).name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function classifyApiSearchFailure(
  error: unknown,
  context: { durationMs: number; model: string },
): GemmaDesktopError {
  const message = error instanceof Error ? error.message : String(error);
  const providerError = parseProviderErrorMessage(message);
  const status = providerError?.code
    ?? (error as { status?: number; code?: number | string })?.status
    ?? (error as { status?: number; code?: number | string })?.code;
  const providerStatus = providerError?.status;
  const providerMessage = providerError?.message ?? message;
  const lowered = `${providerMessage}\n${message}`.toLowerCase();
  const details = {
    ...context,
    status,
    providerStatus,
    errorMessage: providerMessage,
    rawErrorMessage: message,
  };

  if (error instanceof Error && error.name === "AbortError") {
    return buildApiSearchError({
      kind: "timeout",
      reason: "Gemini API web search was aborted before returning. Tell the user the search was cancelled and suggest retrying.",
      details,
    });
  }

  if ((error as { code?: string })?.code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) {
    return buildApiSearchError({
      kind: "timeout",
      reason: `Gemini API did not return a search result within ${Math.round(GEMINI_API_SEARCH_TIMEOUT_MS / 1000)} seconds. Tell the user the web search timed out and suggest they retry or rephrase the query.`,
      details,
    });
  }

  if (
    status === 401
    || status === 403
    || /api key|unauthorized|permission denied|invalid authentication|forbidden/i.test(lowered)
  ) {
    return buildApiSearchError({
      kind: "auth_invalid",
      reason:
        "The Gemini API key was rejected. Tell the user to open Gemma Desktop -> Settings -> Integrations and paste a working Gemini API key from https://aistudio.google.com/app/apikey. Web search will stay broken until the key is fixed.",
      details,
    });
  }

  if (
    /quota exceeded|exceeded your current quota|check your plan and billing|requests per day|tokens per minute|requests per minute|quotametric|quota metric/i.test(
      lowered,
    )
  ) {
    return buildApiSearchError({
      kind: "quota_exhausted",
      reason:
        "The Gemini API rejected the search because the configured project's quota or rate limit appears to be exhausted. Tell the user to check the AI Studio project quota/billing or wait for the quota window to reset.",
      details,
    });
  }

  if (
    status === 429
    || status === 502
    || status === 503
    || status === 504
    || providerStatus === "RESOURCE_EXHAUSTED"
    || providerStatus === "UNAVAILABLE"
    || /resource.?exhausted|capacity|high demand|temporar(?:y|ily) unavailable|unavailable|overloaded|try again later/i.test(
      lowered,
    )
  ) {
    return buildApiSearchError({
      kind: "capacity_exhausted",
      reason:
        "Gemini search appears to be down or out of capacity. Tell the user this looks like provider capacity pressure, not a bad API key or clearly exhausted project quota.",
      details,
    });
  }

  if (/rate.?limit|too many requests/i.test(lowered)) {
    return buildApiSearchError({
      kind: "quota_exhausted",
      reason:
        "The Gemini API rejected the search with a rate-limit response. Tell the user the configured project is being throttled and they may need to wait for the rate-limit window to reset.",
      details,
    });
  }

  if (/fetch failed|network|enotfound|econnrefused|econnreset|socket hang up/i.test(lowered)) {
    return buildApiSearchError({
      kind: "network_error",
      reason: "Gemini API search failed because the network request could not complete. Tell the user the device may be offline or blocked from reaching generativelanguage.googleapis.com, and include the underlying error detail.",
      details,
    });
  }

  return buildApiSearchError({
    kind: "api_error",
    reason: `Gemini API web search failed: ${providerMessage}. Tell the user the Gemini Search backend returned an error and share the message if it helps.`,
    details,
  });
}

function parseProviderErrorMessage(message: string): { code?: number; message?: string; status?: string } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: {
        code?: number;
        message?: string;
        status?: string;
      };
    };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

function buildApiSearchError(input: {
  kind: GeminiApiSearchErrorKind;
  reason: string;
  details?: Record<string, unknown>;
}): GemmaDesktopError {
  return new GemmaDesktopError("tool_execution_failed", input.reason, {
    details: {
      provider: "gemini-api",
      errorKind: input.kind,
      ...(input.details ?? {}),
    },
  });
}

export const __testing = {
  buildGeminiApiSearchPrompt,
  classifyApiSearchFailure,
  filterSourcesByDomains,
  mapResponseToSearchResult,
};
