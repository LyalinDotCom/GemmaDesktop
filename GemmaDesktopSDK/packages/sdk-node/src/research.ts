import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GemmaDesktopError,
  renderTrace,
  type ModeSelection,
  type SessionInput,
  type SessionSnapshot,
  type StructuredOutputSpec,
  type ToolSubsessionRequest,
  type ToolSubsessionResult,
} from "@gemma-desktop/sdk-core";
import {
  ParallelHostExecutor,
  type BatchTaskResult,
  type FetchUrlInput,
  type FetchExecutionResult,
  type SearchExecutionResult,
} from "@gemma-desktop/sdk-tools";

const DEFAULT_ARTIFACT_RELATIVE_DIRECTORY = path.join(".gemma", "research");
const DEFAULT_MAX_CONCURRENT_MODEL_WORKERS = 1;
const MAX_ALLOWED_CONCURRENT_MODEL_WORKERS = 2;
const DEFAULT_MAX_CONCURRENT_WEB_SEARCHES = 2;
const DEFAULT_MAX_CONCURRENT_WEB_FETCHES = 6;
const DEFAULT_MAX_CONCURRENT_WORKSPACE_READS = 8;
const DEFAULT_FETCHES_PER_TOPIC = 3;
const DEFAULT_SEARCH_RESULTS_PER_QUERY = 5;
const DEFAULT_DEEP_MAX_PASSES = 3;
const DEFAULT_QUICK_MAX_PASSES = 2;
const DEFAULT_DEEP_TARGET_SOURCES = 18;
const DEFAULT_QUICK_TARGET_SOURCES = 8;
const DEFAULT_DEEP_TARGET_DOMAINS = 5;
const DEFAULT_QUICK_TARGET_DOMAINS = 3;
const DEFAULT_DEEP_NEWS_FRONT_PAGE_TARGET = 4;
const DEFAULT_DEEP_NEWS_ARTICLE_TARGET = 5;
const DEFAULT_DEEP_NEWS_MIN_ARTICLE_OUTLETS = 3;
const NEWS_DOSSIER_SOURCE_LIMIT = 8;
const NEWS_COLLECTOR_SOURCE_CHUNK_SIZE = 5;
const NEWS_DOSSIER_FINDING_PREVIEW_CHARS = 360;
const MAX_TOPIC_WORKER_ATTEMPTS = 2;
const DEFAULT_RESEARCH_PLANNING_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_RESEARCH_TOPIC_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_RESEARCH_SYNTHESIS_IDLE_TIMEOUT_MS = 3 * 60_000;
const MAX_PLANNING_ASSISTANT_CHARS = 12_000;
const MAX_DEPTH_SCOUT_ASSISTANT_CHARS = 12_000;
const MAX_TOPIC_ASSISTANT_CHARS = 16_000;
const MAX_SYNTHESIS_ASSISTANT_CHARS = 24_000;
const STRUCTURED_OUTPUT_BUDGET_FAILURE_PATTERN = /structured-output budget|structured-output progress|time budget|idle-progress budget|timed out|timeout/i;
const TOPIC_EVIDENCE_CARD_LIMIT = 10;
const SYNTHESIS_EVIDENCE_CARD_LIMIT = 18;
const TOPIC_EVIDENCE_EXCERPT_CHARS = 700;
const SYNTHESIS_EVIDENCE_EXCERPT_CHARS = 420;
const EVIDENCE_SENTENCE_LIMIT = 3;
const RESEARCH_REPORT_FORMATTING_RULES = [
  "# Research Report Formatting Rules",
  "",
  "You are producing a research report. Follow this structure and these rules exactly.",
  "",
  "## Required structure (in order)",
  "",
  "1. **Title + dateline** — `# Topic` then a single italic line: *Location · Date · Scope of report*",
  "",
  "2. **TL;DR box** — A blockquote (`>`) with 2–4 sentences. Bold the 3–5 most important facts. This must answer the user's question on its own.",
  "",
  "3. **Key facts table** — A markdown table of the most important quantitative or categorical data points (numbers, dates, names, status). Skip only if the topic is purely qualitative.",
  "",
  "4. **What's happening** — Themed sections with `## H2` headers. Each section opens with a one-sentence takeaway in bold, then supporting bullets. No wall-of-text paragraphs longer than 3 sentences.",
  "",
  "5. **Timeline** — Required if the topic has 3+ dated events. Use a table: `Date | Event | Significance`.",
  "",
  "6. **Players & positions** — Required if 3+ named actors have stated views. Table: `Actor | Position | Source #`.",
  "",
  "7. **Consensus vs. disputed** — Two subsections under one `## H2`. List what sources agree on, then where they diverge. Be specific about who claims what.",
  "",
  "8. **Sources** — Numbered list at the bottom. Format: `[1] Publication — \"Article title\" — URL`",
  "",
  "## Citation rules (strict)",
  "",
  "- **Never** embed link titles inline. Use bracketed numbers: `[1]`, `[2,3]`.",
  "- Each source gets ONE number, reused throughout.",
  "- Maximum 2 citations per claim. If you have more, the claim is a consensus point — say \"multiple wire services [1,2,3]\" or move it to the consensus section.",
  "- Sources list at end is the only place full titles + URLs appear.",
  "",
  "## Visual hierarchy rules",
  "",
  "- **Bold** proper nouns, organizations, and key facts on first mention only.",
  "- Use tables for any comparison, 3+ data points, or actor/position mapping. Never use prose for this.",
  "- Use status markers at the start of bullets when relevant: `🔴 Breaking` / `✅ Confirmed` / `⚠️ Disputed` / `🟡 Developing` / `📊 Data`",
  "- Use blockquotes (`>`) for: the TL;DR, direct quotes under 15 words, and breaking developments worth highlighting.",
  "- Bullets should be scannable: lead with the noun/event, not \"The fact that…\"",
  "",
  "## Prose rules",
  "",
  "- No paragraph longer than 3 sentences anywhere in the report.",
  "- Lead every section and bullet with the conclusion, then evidence.",
  "- Cut hedging language (\"it appears that\", \"reports suggest\") unless the source itself is uncertain — then say \"unconfirmed:\" explicitly.",
  "- Numbers are written as digits and bolded when they're the point of the sentence (**660 drones**, not \"six hundred and sixty drones\").",
  "",
  "## What to cut",
  "",
  "- Don't repeat the same fact across sections.",
  "- Don't include sources that only confirm what 3+ others already said — pick the most authoritative.",
  "- Don't write transition sentences between sections. Headers do that work.",
  "- Don't editorialize (\"notably\", \"significantly\", \"interestingly\").",
].join("\n");

function isStructuredOutputBudgetFailure(message: string | undefined): boolean {
  return typeof message === "string" && STRUCTURED_OUTPUT_BUDGET_FAILURE_PATTERN.test(message);
}

function isMissingSearchConfigurationError(message: string | undefined): boolean {
  return typeof message === "string" && /No Gemini API key is configured, so web search cannot run/i.test(message);
}

export type ResearchProfile = "quick" | "deep";
export type ResearchTaskType =
  | "news-sweep"
  | "comparison"
  | "catalog-status"
  | "validation-explainer";
export type ResearchSourceFamily =
  | "mainstream_front_page"
  | "mainstream_article"
  | "wire"
  | "local_news"
  | "blogs_analysis"
  | "official"
  | "community"
  | "reference_github_docs";

export interface ResearchRunOptions {
  profile?: ResearchProfile;
  artifactDirectory?: string;
  maxConcurrentModelWorkers?: number;
  maxConcurrentWebSearches?: number;
  maxConcurrentWebFetches?: number;
  maxConcurrentWorkspaceReads?: number;
  allowWorkspaceReads?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: ResearchRunStatus) => void | Promise<void>;
}

export interface ResearchTopicPlan {
  id: string;
  title: string;
  goal: string;
  priority: number;
  searchQueries: string[];
}

export interface ResearchPlan {
  objective: string;
  scopeSummary?: string;
  topics: ResearchTopicPlan[];
  risks: string[];
  stopConditions: string[];
}

export interface ResearchSourceRecord {
  id: string;
  requestedUrl: string;
  resolvedUrl: string;
  sourceDepth?: number;
  discoveryMethod?: "seed" | "search" | "one_hop";
  parentSourceId?: string;
  parentResolvedUrl?: string;
  title?: string;
  description?: string;
  kind: string;
  extractedWith: string;
  blockedLikely: boolean;
  fetchedAt: string;
  topicIds: string[];
  domain?: string;
  sourceFamily?: ResearchSourceFamily;
  pageRole?: "front_page" | "article" | "reference" | "community" | "other";
  contentPreview: string;
  contentLength?: number;
  lowQualityContent?: boolean;
  offTopic?: boolean;
  snippetMerged?: boolean;
}

interface ResearchEvidenceCard {
  sourceId: string;
  title: string;
  url: string;
  domain?: string;
  sourceFamily?: ResearchSourceFamily;
  pageRole?: ResearchSourceRecord["pageRole"];
  sourceDepth: number;
  discoveryMethod: ResearchSourceRecord["discoveryMethod"];
  parentSourceId?: string;
  parentResolvedUrl?: string;
  relevanceScore: number;
  signals: string[];
  excerpt: string;
}

export interface ResearchDossier {
  id: string;
  topicId: string;
  title: string;
  summary: string;
  findings: string[];
  contradictions: string[];
  openQuestions: string[];
  sourceIds: string[];
  unresolvedSourceRefs: string[];
  confidence: number;
  workerSessionId: string;
}

export interface ResearchRunResult {
  runId: string;
  profile: ResearchProfile;
  artifactDirectory: string;
  runtimeId: string;
  modelId: string;
  plan: ResearchPlan;
  sources: ResearchSourceRecord[];
  dossiers: ResearchDossier[];
  finalReport: string;
  summary: string;
  sourceIds: string[];
  confidence: number;
  completedAt: string;
  taskType?: ResearchTaskType;
  passCount?: number;
  coverage?: ResearchCoverageSnapshot;
  gapsRemaining?: string[];
  sourceFamilies?: ResearchSourceFamily[];
  warnings?: string[];
}

interface ResearchRunnerOptions {
  snapshot: SessionSnapshot;
  runSubsession: (request: ToolSubsessionRequest, parentToolCallId: string) => Promise<ToolSubsessionResult>;
  geminiApiKey?: string | (() => string | undefined);
  geminiApiModel?: string | (() => string | undefined);
}

interface DiscoveryRecord {
  searches: Array<{
    passNumber: number;
    query: string;
    result: SearchExecutionResult;
  }>;
  seedUrls: string[];
  fetchedSourceIds: string[];
  searchErrors: Array<{
    passNumber: number;
    query: string;
    error: string;
  }>;
  fetchErrors: Array<{
    passNumber: number;
    url: string;
    error: string;
  }>;
}

interface SearchSnippetSourceCandidate {
  topicId: string;
  query: string;
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  sourceFamily?: ResearchSourceFamily;
  passNumber?: number;
}

interface DepthScoutCandidate {
  id: string;
  url: string;
  parentSourceId: string;
  parentTitle?: string;
  parentResolvedUrl: string;
  topicIds: string[];
  sourceFamily: ResearchSourceFamily;
  reason: string;
}

interface DepthScoutRecord {
  selectedUrls: string[];
  rationale: string;
  openQuestions: string[];
  confidence: number;
}

interface NormalizedResearchOptions {
  profile: ResearchProfile;
  artifactDirectory: string;
  maxConcurrentModelWorkers: number;
  maxConcurrentWebSearches: number;
  maxConcurrentWebFetches: number;
  maxConcurrentWorkspaceReads: number;
  allowWorkspaceReads: boolean;
  signal?: AbortSignal;
  onStatus?: (status: ResearchRunStatus) => void | Promise<void>;
}

export type ResearchWorkerTimelineTone = "info" | "success" | "warning";

export interface ResearchWorkerTimelineEntry {
  id: string;
  label: string;
  detail?: string;
  timestamp: string;
  tone?: ResearchWorkerTimelineTone;
}

export interface ResearchWorkerSnapshot {
  kind: "planning" | "discovery" | "depth" | "topic" | "synthesis";
  label: string;
  goal?: string;
  childSessionId?: string;
  childTurnId?: string;
  currentAction?: string;
  assistantDeltaCount: number;
  reasoningDeltaCount: number;
  lifecycleCount: number;
  toolCallCount: number;
  toolResultCount: number;
  searchCount?: number;
  fetchCount?: number;
  sourceCount?: number;
  timeline: ResearchWorkerTimelineEntry[];
  resultSummary?: string;
  traceText?: string;
}

export interface ResearchRunStatus {
  runId: string;
  parentSessionId: string;
  runtimeId: string;
  modelId: string;
  profile: ResearchProfile;
  status: "running" | "completed" | "failed" | "cancelled";
  stage: "planning" | "discovery" | "depth" | "workers" | "synthesis" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  artifactDirectory: string;
  stages: {
    planning: ResearchStageStatus;
    discovery: ResearchStageStatus;
    depth: ResearchStageStatus;
    workers: ResearchStageStatus;
    synthesis: ResearchStageStatus;
  };
  taskType?: ResearchTaskType;
  passCount?: number;
  currentPass?: number;
  coverage?: ResearchCoverageSnapshot;
  gapsRemaining?: string[];
  sourceFamilies?: ResearchSourceFamily[];
  passes?: ResearchPassStatus[];
  topicStatuses: Array<{
    topicId: string;
    title: string;
    goal?: string;
    status: "pending" | "running" | "completed" | "failed";
    startedAt?: string;
    completedAt?: string;
    summary?: string;
    searchCount?: number;
    searchErrorCount?: number;
    fetchCount?: number;
    fetchErrorCount?: number;
    sourceCount?: number;
    lastError?: string;
    worker?: ResearchWorkerSnapshot;
  }>;
  activities?: RunActivityRecord[];
  warnings?: string[];
  error?: string;
}

interface ResearchStageStatus {
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  worker?: ResearchWorkerSnapshot;
}

interface RunActivityRecord {
  phase: "planning" | "depth" | "topic" | "synthesis";
  attempt: number;
  topicId?: string;
  topicTitle?: string;
  startedAt: string;
  lastEventAt?: string;
  firstTokenAt?: string;
  lastEventType?: string;
  label: string;
  goal?: string;
  childSessionId?: string;
  childTurnId?: string;
  currentAction?: string;
  assistantDeltaCount: number;
  reasoningDeltaCount: number;
  lifecycleCount: number;
  toolCallCount: number;
  toolResultCount: number;
  searchCount?: number;
  fetchCount?: number;
  sourceCount?: number;
  timeline: ResearchWorkerTimelineEntry[];
  resultSummary?: string;
  traceText?: string;
}

interface FinalSynthesisRecord {
  summary: string;
  reportMarkdown: string;
  openQuestions: string[];
  sourceIds: string[];
  confidence: number;
}

interface ResearchBrief {
  objective: string;
  scopeSummary: string;
  taskType: ResearchTaskType;
  focusQuery: string;
  subject?: string;
  requiredSourceFamilies: ResearchSourceFamily[];
  optionalSourceFamilies: ResearchSourceFamily[];
  reportRequirements: string[];
}

interface CoverageQueryGroup {
  id: string;
  topicId: string;
  title: string;
  goal: string;
  priority: number;
  sourceFamily: ResearchSourceFamily;
  required: boolean;
  searchQueries: string[];
  seedUrls: string[];
  targetSources: number;
}

interface CoveragePlan {
  taskType: ResearchTaskType;
  targetSources: number;
  targetDomains: number;
  maxPasses: number;
  requiredSourceFamilies: ResearchSourceFamily[];
  optionalSourceFamilies: ResearchSourceFamily[];
  queryGroups: CoverageQueryGroup[];
  stopConditions: string[];
}

interface ResearchPassRecord {
  passNumber: number;
  startedAt: string;
  completedAt?: string;
  queryCount: number;
  fetchCount: number;
  fetchedSourceIds: string[];
  searchErrors: number;
  fetchErrors: number;
  sourceCount: number;
  domainCount: number;
  summary?: string;
  gaps?: string[];
}

export interface ResearchPassStatus {
  passNumber: number;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  queryCount?: number;
  fetchCount?: number;
  sourceCount?: number;
  gaps?: string[];
}

interface CoverageAssessment {
  sufficient: boolean;
  summary: string;
  gaps: string[];
  missingSourceFamilies: ResearchSourceFamily[];
  missingTopicIds: string[];
  targetDomainGap: number;
  followUpQueriesByTopic: Map<string, string[]>;
  followUpSeedUrlsByTopic: Map<string, string[]>;
}

export interface ResearchCoverageSnapshot {
  targetSources: number;
  sourcesGathered: number;
  targetDomains: number;
  distinctDomains: number;
  families: Array<{
    id: ResearchSourceFamily;
    label: string;
    required: boolean;
    sourceCount: number;
    covered: boolean;
  }>;
  topDomains: Array<{ domain: string; count: number }>;
}

type ProviderId = "official" | "ollama" | "lm-studio" | "hugging-face";
type ResearchDimensionId = "versions" | "types" | "sources";
type ResearchSurfaceId = "official" | "news" | "ecosystem" | "community";

const KNOWN_MODEL_FAMILIES = [
  "Gemma",
  "Llama",
  "Qwen",
  "Mistral",
  "Phi",
  "DeepSeek",
  "Mixtral",
];

const PROVIDER_DEFINITIONS: Array<{
  id: ProviderId;
  label: string;
  pattern: RegExp;
}> = [
  {
    id: "official",
    label: "Official",
    pattern: /\b(?:official|google|deepmind)\b/i,
  },
  {
    id: "ollama",
    label: "Ollama",
    pattern: /\bollama\b/i,
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    pattern: /\b(?:lm studio|lmstudio)\b/i,
  },
  {
    id: "hugging-face",
    label: "Hugging Face",
    pattern: /\b(?:hugging face|huggingface)\b/i,
  },
];

const RESEARCH_DIMENSION_DEFINITIONS: Array<{
  id: ResearchDimensionId;
  pattern: RegExp;
}> = [
  {
    id: "versions",
    pattern: /\b(?:version|versions|release|releases|generation|generations|timeline|history|iteration|iterations)\b/i,
  },
  {
    id: "types",
    pattern: /\b(?:type|types|variant|variants|family|families|size|sizes|architecture|architectures|modality|modalities|base|instruct(?:ion)?(?:-tuned)?|pre[- ]?trained|dense|moe|multimodal|vision|code|medical)\b/i,
  },
  {
    id: "sources",
    pattern: /\b(?:source|sources|download|downloads|availability|distribution|registry|registries|hugging\s*face|ollama|lm\s*studio|model\s*cards?|docs|documentation)\b/i,
  },
];

const RESEARCH_SURFACE_DEFINITIONS: Array<{
  id: ResearchSurfaceId;
  pattern: RegExp;
}> = [
  {
    id: "official",
    pattern: /\b(?:official|docs?|documentation|spec|specification|developer(?:\s+docs?)?|release notes?|first[- ]party)\b/i,
  },
  {
    id: "news",
    pattern: /\b(?:news|coverage|reporting|reports?|review|reviews|hands[- ]on|mainstream|press)\b/i,
  },
  {
    id: "ecosystem",
    pattern: /\b(?:ecosystem|tooling|toolchain|github|issue|issues|blog|blogs|blog posts?|framework|frameworks|vendor|implementation|implementations|announcement|announcements|migration|adoption|crate|crates)\b/i,
  },
  {
    id: "community",
    pattern: /\b(?:reddit|community|communities|discussion|discussions|forum|forums|sentiment|reaction|reactions|hacker news|hn|owner impressions?)\b/i,
  },
];

const SOURCE_FAMILY_LABELS: Record<ResearchSourceFamily, string> = {
  mainstream_front_page: "Mainstream front pages",
  mainstream_article: "Mainstream articles",
  wire: "Wire services",
  local_news: "Local / specialized sources",
  blogs_analysis: "Blogs / analysis",
  official: "Official sources",
  community: "Community discussion",
  reference_github_docs: "Reference / GitHub / docs",
};

const MAINSTREAM_NEWS_OUTLETS = [
  { label: "CNN", domain: "cnn.com", homeUrl: "https://www.cnn.com/" },
  { label: "Fox News", domain: "foxnews.com", homeUrl: "https://www.foxnews.com/" },
  { label: "BBC News", domain: "bbc.com", homeUrl: "https://www.bbc.com/news" },
  { label: "AP News", domain: "apnews.com", homeUrl: "https://apnews.com/" },
  { label: "Reuters", domain: "reuters.com", homeUrl: "https://www.reuters.com/" },
  { label: "ABC News", domain: "abcnews.com", homeUrl: "https://abcnews.go.com/" },
  { label: "CBS News", domain: "cbsnews.com", homeUrl: "https://www.cbsnews.com/" },
  { label: "NPR", domain: "npr.org", homeUrl: "https://www.npr.org/" },
] as const;

const WIRE_NEWS_OUTLETS = [
  { label: "Reuters", domain: "reuters.com", homeUrl: "https://www.reuters.com/" },
  { label: "AP News", domain: "apnews.com", homeUrl: "https://apnews.com/" },
] as const;

const COMMUNITY_DOMAINS = [
  "reddit.com",
  "redditmedia.com",
  "news.ycombinator.com",
  "hn.algolia.com",
  "lobste.rs",
] as const;

const OFFICIAL_SOURCE_DOMAINS = [
  "apple.com",
  "developer.apple.com",
  "react.dev",
  "reactjs.org",
  "rust-lang.org",
  "blog.rust-lang.org",
  "pytorch.org",
  "modelcontextprotocol.io",
  "docs.anthropic.com",
  "anthropic.com",
  "deepmind.google",
  "ai.google.dev",
  "ollama.com",
  "lmstudio.ai",
  "nextjs.org",
  "vercel.com",
  "vite.dev",
  "remix.run",
  "qwenlm.github.io",
] as const;

const REFERENCE_DOC_DOMAINS = [
  "github.com",
  "docs.github.com",
  "docs.rs",
  "tokio.rs",
  "huggingface.co",
] as const;

const RESEARCH_FOCUS_STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "against",
  "analysis",
  "and",
  "around",
  "article",
  "articles",
  "check",
  "compare",
  "coverage",
  "current",
  "currently",
  "date",
  "dates",
  "difference",
  "differences",
  "differ",
  "front",
  "give",
  "headline",
  "headlines",
  "latest",
  "look",
  "mainstream",
  "news",
  "official",
  "outlet",
  "outlets",
  "page",
  "pages",
  "pick",
  "please",
  "read",
  "recent",
  "report",
  "research",
  "see",
  "site",
  "source",
  "sources",
  "stories",
  "story",
  "there",
  "today",
  "top",
  "update",
  "updates",
  "website",
  "websites",
  "what",
  "with",
]);

function normalizeResearchOptions(
  snapshot: SessionSnapshot,
  options: ResearchRunOptions,
): NormalizedResearchOptions {
  return {
    profile: options.profile ?? "deep",
    artifactDirectory: path.resolve(
      options.artifactDirectory
      ?? path.join(snapshot.workingDirectory, DEFAULT_ARTIFACT_RELATIVE_DIRECTORY),
    ),
    maxConcurrentModelWorkers: Math.min(
      Math.max(1, Math.floor(options.maxConcurrentModelWorkers ?? DEFAULT_MAX_CONCURRENT_MODEL_WORKERS)),
      MAX_ALLOWED_CONCURRENT_MODEL_WORKERS,
    ),
    maxConcurrentWebSearches: Math.max(1, Math.floor(options.maxConcurrentWebSearches ?? DEFAULT_MAX_CONCURRENT_WEB_SEARCHES)),
    maxConcurrentWebFetches: Math.max(1, Math.floor(options.maxConcurrentWebFetches ?? DEFAULT_MAX_CONCURRENT_WEB_FETCHES)),
    maxConcurrentWorkspaceReads: Math.max(
      1,
      Math.floor(options.maxConcurrentWorkspaceReads ?? DEFAULT_MAX_CONCURRENT_WORKSPACE_READS),
    ),
    allowWorkspaceReads: options.allowWorkspaceReads ?? true,
    signal: options.signal,
    onStatus: options.onStatus,
  };
}

function contentPartsToText(input: SessionInput): string {
  if (typeof input === "string") {
    return input.trim();
  }

  return input
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[image: ${part.url}]`;
    })
    .join("\n")
    .trim();
}

function makeStructuredResponseFormat(
  name: string,
  properties: Record<string, unknown>,
  required: string[],
): StructuredOutputSpec {
  return {
    name,
    strict: false,
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: true,
    },
  };
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length > 0 ? normalized : "topic";
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}

function truncateInlineText(value: string, limit: number): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

const LOW_QUALITY_CONTENT_THRESHOLD = 280;
const LOW_QUALITY_WORD_COUNT_THRESHOLD = 30;
const MIN_MEANINGFUL_WORD_RATIO = 0.35;
const JWT_LIKE_PATTERN = /\beyJ[A-Za-z0-9_-]{40,}\b/;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_-]{40,}/g;

function countMeaningfulWords(text: string): { total: number; meaningful: number } {
  const normalized = text.replace(/[\s\n\r\t]+/g, " ").trim();
  if (normalized.length === 0) {
    return { total: 0, meaningful: 0 };
  }
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const meaningful = tokens.filter((token) => /^[A-Za-z][A-Za-z'-]{2,}$/.test(token));
  return { total: tokens.length, meaningful: meaningful.length };
}

function assessContentQuality(
  contentText: string,
  contentLength: number | undefined,
): { lowQuality: boolean; reason?: string } {
  const effectiveLength = contentLength ?? contentText.length;
  if (effectiveLength < LOW_QUALITY_CONTENT_THRESHOLD) {
    return { lowQuality: true, reason: "too-short" };
  }
  const { total, meaningful } = countMeaningfulWords(contentText);
  if (total < LOW_QUALITY_WORD_COUNT_THRESHOLD) {
    return { lowQuality: true, reason: "too-few-words" };
  }
  if (total > 0 && meaningful / total < MIN_MEANINGFUL_WORD_RATIO) {
    return { lowQuality: true, reason: "low-word-ratio" };
  }
  if (JWT_LIKE_PATTERN.test(contentText)) {
    const longTokens = contentText.match(LONG_TOKEN_PATTERN) ?? [];
    const longTokenChars = longTokens.reduce((sum, token) => sum + token.length, 0);
    if (longTokenChars / Math.max(1, contentText.length) > 0.25) {
      return { lowQuality: true, reason: "token-heavy" };
    }
  }
  return { lowQuality: false };
}

function extractRelevanceKeywords(
  values: Array<string | undefined>,
  limit = 12,
): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "onto", "that", "this", "these", "those",
    "what", "when", "where", "which", "about", "over", "under", "your", "their", "them",
    "are", "was", "were", "will", "would", "could", "should", "have", "has", "had",
    "but", "not", "just", "list", "some", "each", "there", "here", "also", "more",
    "them", "then", "than", "they", "you", "yours", "ours", "its", "whose", "who",
    "full", "details", "detail", "show", "tell", "know", "want", "need", "find",
    "give", "make", "made", "take", "get", "got", "can", "using", "use", "used",
    "session", "sessions", "catalog", "list", "lists", "schedule", "agenda", "event",
  ]);
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (!raw) {
      continue;
    }
    const tokens = raw
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !stopwords.has(token));
    for (const token of tokens) {
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      collected.push(token);
      if (collected.length >= limit) {
        return collected;
      }
    }
  }
  return collected;
}

function sourceMatchesKeywords(
  source: { title?: string; description?: string; contentPreview: string },
  keywords: string[],
): boolean {
  if (keywords.length === 0) {
    return true;
  }
  const haystack = `${source.title ?? ""}\n${source.description ?? ""}\n${source.contentPreview}`.toLowerCase();
  if (haystack.trim().length === 0) {
    return false;
  }
  let hits = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) {
      hits += 1;
    }
    if (hits >= 2 || hits >= Math.min(2, keywords.length)) {
      return true;
    }
  }
  return false;
}

function isUsableResearchSource(
  source: Pick<ResearchSourceRecord, "lowQualityContent" | "offTopic">,
): boolean {
  return !source.lowQualityContent && !source.offTopic;
}

function buildEvidenceKeywords(
  brief: ResearchBrief,
  topic?: Pick<ResearchTopicPlan, "title" | "goal" | "searchQueries">,
): string[] {
  return extractRelevanceKeywords(
    [
      brief.subject,
      brief.focusQuery,
      brief.objective,
      brief.scopeSummary,
      topic?.title,
      topic?.goal,
      ...(topic?.searchQueries ?? []),
    ],
    18,
  );
}

function countKeywordHits(value: string, keywords: string[]): number {
  const normalized = value.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) {
      hits += 1;
    }
  }
  return hits;
}

function splitEvidenceSentences(value: string): string[] {
  const seen = new Set<string>();
  return value
    .replace(/\r/g, "\n")
    .split(/(?:\n+|(?<=[.!?])\s+|\s+[|•]\s+)/g)
    .map((entry) => normalizeInlineText(entry))
    .filter((entry) => entry.length >= 24)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 120);
}

function scoreEvidenceSentence(sentence: string, keywords: string[]): number {
  const normalized = sentence.toLowerCase();
  let score = countKeywordHits(normalized, keywords) * 12;
  if (/\b(?:released?|available|availability|download|source|license|runtime|catalog|model|models?|version|sizes?|parameters?|architecture|official|docs?|documentation|ollama|hugging\s?face|gguf|mxfp|nvfp)\b/i.test(sentence)) {
    score += 10;
  }
  if (/\b(?:\d{4}|\d+(?:\.\d+)?\s?(?:b|m|k)\b|\d+b\b|[a-z]?\d+b-[a-z0-9-]+)\b/i.test(sentence)) {
    score += 8;
  }
  if (sentence.length >= 60 && sentence.length <= 360) {
    score += 4;
  }
  if (/^(?:cookie|privacy|terms|subscribe|sign in|log in|javascript|enable)/i.test(normalized)) {
    score -= 25;
  }
  return score;
}

function extractBestEvidenceExcerpt(
  source: ResearchSourceRecord,
  keywords: string[],
  limit: number,
): string {
  const evidenceText = [
    source.description,
    source.contentPreview,
  ]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join("\n");
  const sentences = splitEvidenceSentences(evidenceText);
  const selected = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreEvidenceSentence(sentence, keywords),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, EVIDENCE_SENTENCE_LIMIT)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.sentence);

  const excerpt = selected.length > 0
    ? selected.join(" ")
    : normalizeInlineText(evidenceText);
  return truncateInlineText(excerpt, limit);
}

function scoreResearchEvidenceSource(
  source: ResearchSourceRecord,
  keywords: string[],
): number {
  if (!isUsableResearchSource(source)) {
    return -10_000;
  }
  const title = source.title ?? "";
  const description = source.description ?? "";
  const haystack = `${title}\n${description}\n${source.contentPreview}`;
  let score = countKeywordHits(haystack, keywords) * 14;
  score += countKeywordHits(`${title}\n${description}`, keywords) * 8;
  const firstPartyDomain = isLikelyFirstPartyDomain(source.domain);
  const runtimeCatalogDomain = isLikelyRuntimeCatalogDomain(source.domain);
  if (source.sourceFamily === "official" && firstPartyDomain) {
    score += 34;
  } else if (source.sourceFamily === "official") {
    score += 4;
  } else if (source.sourceFamily === "reference_github_docs") {
    score += 24;
  } else if (source.sourceFamily === "wire") {
    score += 18;
  } else if (source.sourceFamily === "blogs_analysis") {
    score += 12;
  }
  if (runtimeCatalogDomain) {
    score += 18;
  }
  if (/^ollama\.com$/i.test(source.domain ?? "") && /\/library\/gemma4(?::|$)/i.test(source.resolvedUrl)) {
    score += 46;
  }
  if (/^huggingface\.co$/i.test(source.domain ?? "") && /\/(?:google\/gemma-4|collections\/google\/gemma-4)/i.test(source.resolvedUrl)) {
    score += 36;
  }
  if (/^lmstudio\.ai$/i.test(source.domain ?? "") && /\/models\/gemma-4/i.test(source.resolvedUrl)) {
    score += 28;
  }
  if (source.pageRole === "reference" || source.pageRole === "article") {
    score += 14;
  } else if (source.pageRole === "community") {
    score += 8;
  }
  if ((source.sourceDepth ?? 0) > 0 || source.discoveryMethod === "one_hop") {
    score += 16;
  }
  if (source.blockedLikely) {
    score -= 42;
  }
  if (source.kind === "search-result") {
    score -= 24;
  }
  if ((source.contentLength ?? source.contentPreview.length) >= 900) {
    score += 6;
  }
  if (/\b(?:\d{4}|\d+b\b|available|download|license|runtime|official|catalog)\b/i.test(haystack)) {
    score += 8;
  }
  return score;
}

function isLikelyFirstPartyDomain(domain: string | undefined): boolean {
  if (!domain) {
    return false;
  }
  return /(?:^|\.)google$|(?:^|\.)google\.com$|(?:^|\.)google\.dev$|(?:^|\.)blog\.google$|(?:^|\.)deepmind\.google$|(?:^|\.)developers\.googleblog\.com$|(?:^|\.)cloud\.google\.com$|(?:^|\.)ai\.google\.dev$/i
    .test(domain);
}

function isLikelyRuntimeCatalogDomain(domain: string | undefined): boolean {
  if (!domain) {
    return false;
  }
  return /(?:^|\.)ollama\.com$|(?:^|\.)lmstudio\.ai$|(?:^|\.)huggingface\.co$|(?:^|\.)github\.com$/i
    .test(domain);
}

function buildResearchEvidenceCardFromKeywords(
  source: ResearchSourceRecord,
  keywords: string[],
  excerptLimit: number,
): ResearchEvidenceCard {
  const signals: string[] = [];
  if (source.sourceFamily) {
    signals.push(
      source.sourceFamily === "official" && !isLikelyFirstPartyDomain(source.domain)
        ? "official-query candidate"
        : SOURCE_FAMILY_LABELS[source.sourceFamily],
    );
  }
  if (source.pageRole) {
    signals.push(`${source.pageRole.replace(/_/g, " ")} page`);
  }
  if ((source.sourceDepth ?? 0) > 0 || source.discoveryMethod === "one_hop") {
    signals.push("one-hop detail page");
  }
  if (source.blockedLikely || source.kind === "search-result") {
    signals.push("snippet-only fallback");
  }
  return {
    sourceId: source.id,
    title: formatResearchSourceTitle(source),
    url: source.resolvedUrl,
    domain: source.domain,
    sourceFamily: source.sourceFamily,
    pageRole: source.pageRole,
    sourceDepth: source.sourceDepth ?? 0,
    discoveryMethod: source.discoveryMethod,
    parentSourceId: source.parentSourceId,
    parentResolvedUrl: source.parentResolvedUrl,
    relevanceScore: scoreResearchEvidenceSource(source, keywords),
    signals: dedupeStrings(signals),
    excerpt: extractBestEvidenceExcerpt(source, keywords, excerptLimit),
  };
}

function buildResearchEvidenceCards(
  brief: ResearchBrief,
  topic: Pick<ResearchTopicPlan, "title" | "goal" | "searchQueries"> | undefined,
  sources: ResearchSourceRecord[],
  limit = TOPIC_EVIDENCE_CARD_LIMIT,
  excerptLimit = TOPIC_EVIDENCE_EXCERPT_CHARS,
): ResearchEvidenceCard[] {
  const keywords = buildEvidenceKeywords(brief, topic);
  return sources
    .filter((source) => isUsableResearchSource(source))
    .map((source) => buildResearchEvidenceCardFromKeywords(source, keywords, excerptLimit))
    .sort((left, right) =>
      right.relevanceScore - left.relevanceScore
      || left.sourceDepth - right.sourceDepth
      || left.sourceId.localeCompare(right.sourceId),
    )
    .slice(0, limit);
}

function buildSynthesisEvidenceCards(
  brief: ResearchBrief,
  plan: ResearchPlan,
  dossiers: ResearchDossier[],
  sources: ResearchSourceRecord[],
): ResearchEvidenceCard[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const citedSourceIds = dedupeStrings(dossiers.flatMap((dossier) => dossier.sourceIds));
  const citedSources = citedSourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is ResearchSourceRecord => Boolean(source))
    .filter((source) => isUsableResearchSource(source));
  const citedSet = new Set(citedSources.map((source) => source.id));
  const keywords = extractRelevanceKeywords(
    [
      brief.subject,
      brief.focusQuery,
      brief.objective,
      brief.scopeSummary,
      plan.objective,
      plan.scopeSummary,
      ...plan.topics.flatMap((topic) => [topic.title, topic.goal, ...topic.searchQueries]),
    ],
    24,
  );
  const fillSources = sources
    .filter((source) => !citedSet.has(source.id))
    .filter((source) => isUsableResearchSource(source))
    .sort((left, right) =>
      scoreResearchEvidenceSource(right, keywords) - scoreResearchEvidenceSource(left, keywords)
      || left.id.localeCompare(right.id),
    );
  return [...citedSources, ...fillSources]
    .slice(0, SYNTHESIS_EVIDENCE_CARD_LIMIT)
    .map((source) => buildResearchEvidenceCardFromKeywords(source, keywords, SYNTHESIS_EVIDENCE_EXCERPT_CHARS));
}

function formatEvidenceCard(card: ResearchEvidenceCard): string {
  return [
    `[${card.sourceId}] ${card.title}`,
    `URL: ${card.url}`,
    card.domain ? `Domain: ${card.domain}` : "",
    card.signals.length > 0 ? `Signals: ${card.signals.join(", ")}` : "",
    card.sourceDepth > 0 && card.parentSourceId
      ? `Depth: ${card.sourceDepth} from ${card.parentSourceId}`
      : `Depth: ${card.sourceDepth}`,
    `Relevance score: ${card.relevanceScore}`,
    `Evidence: ${card.excerpt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNumberedSynthesisEvidenceCard(card: ResearchEvidenceCard, index: number): string {
  return [
    `[${index + 1}] ${card.title}`,
    `Source ID: ${card.sourceId}`,
    `URL: ${card.url}`,
    card.domain ? `Domain: ${card.domain}` : "",
    card.signals.length > 0 ? `Signals: ${card.signals.join(", ")}` : "",
    card.sourceDepth > 0 && card.parentSourceId
      ? `Depth: ${card.sourceDepth} from ${card.parentSourceId}`
      : `Depth: ${card.sourceDepth}`,
    `Relevance score: ${card.relevanceScore}`,
    `Evidence: ${card.excerpt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function isCatalogStyleRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const enumerables =
    "sessions?|talks?|events?|products?|releases?|models?|speakers?|announcements?|updates?|papers?|posts?|articles?|blog(?:\\s?posts)?|episodes?|videos?";
  const enumerablesSingular =
    "session|talk|event|product|release|model|speaker|announcement|update|paper|post|article|blog(?:\\s?post)?|episode|video";
  if (
    /\b(?:catalog|catalogue|agenda|schedule|lineup|line-up|programme|program|roster)\b/.test(normalized)
  ) {
    return true;
  }
  if (new RegExp(`\\ball\\s+(?:the\\s+)?(?:${enumerables})\\b`).test(normalized)) {
    return true;
  }
  if (new RegExp(`\\blist\\s+of\\s+(?:all\\s+)?(?:${enumerables})\\b`).test(normalized)) {
    return true;
  }
  if (
    /\blist\s+(?:every|each|all|the)\s+\w+/.test(normalized)
    && new RegExp(`\\b(?:${enumerables})\\b`).test(normalized)
  ) {
    return true;
  }
  if (new RegExp(`\\bevery\\s+(?:${enumerablesSingular})\\b`).test(normalized)) {
    return true;
  }
  if (
    /\b(?:what (?:are|were)|which)\s+(?:all\s+)?(?:the\s+)?\w+/.test(normalized)
    && new RegExp(`\\b(?:${enumerables})\\b`).test(normalized)
  ) {
    return true;
  }
  return false;
}

function formatResearchSourcePublication(source: ResearchSourceRecord): string {
  const domain = source.domain ?? parseUrlDomain(source.resolvedUrl);
  const outlet = [...MAINSTREAM_NEWS_OUTLETS, ...WIRE_NEWS_OUTLETS]
    .find((candidate) => domain === candidate.domain || domain?.endsWith(`.${candidate.domain}`));
  return outlet?.label ?? domain ?? "Source";
}

function formatResearchSourceListTitle(source: ResearchSourceRecord): string {
  return normalizeInlineText((source.title ?? "").trim() || source.resolvedUrl).replace(/"/g, "'");
}

function selectReportCitationSources(
  sources: ResearchSourceRecord[],
  citedSourceIds: string[],
): ResearchSourceRecord[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return dedupeStrings(citedSourceIds)
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is ResearchSourceRecord => Boolean(source));
}

function formatResearchSourcesSection(citationSources: ResearchSourceRecord[]): string {
  return [
    "## Sources",
    "",
    ...citationSources.map((source, index) =>
      `[${index + 1}] ${formatResearchSourcePublication(source)} — "${formatResearchSourceListTitle(source)}" — ${source.resolvedUrl}`
    ),
  ].join("\n");
}

function stripExistingResearchSourcesSection(reportMarkdown: string): string {
  return reportMarkdown
    .replace(/\n{0,2}##\s+(?:Sources|References)\b[\s\S]*$/i, "")
    .trimEnd();
}

function normalizeResearchSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function enhanceReportWithSourceLinks(
  reportMarkdown: string,
  sources: ResearchSourceRecord[],
  citedSourceIds: string[],
): string {
  const citationSources = selectReportCitationSources(sources, citedSourceIds);
  const sourceNumberById = new Map(citationSources.map((source, index) => [source.id, index + 1]));
  const sourceNumberByUrl = new Map<string, number>();
  for (const source of citationSources) {
    const sourceNumber = sourceNumberById.get(source.id);
    if (!sourceNumber) {
      continue;
    }
    for (const url of [source.resolvedUrl, source.requestedUrl]) {
      const normalizedUrl = normalizeResearchSourceUrl(url);
      if (normalizedUrl) {
        sourceNumberByUrl.set(normalizedUrl, sourceNumber);
      }
    }
  }
  const citationFor = (sourceId: string): string | undefined => {
    const sourceNumber = sourceNumberById.get(sourceId);
    return sourceNumber ? `[${sourceNumber}]` : undefined;
  };
  const citationForGroup = (inner: string): string | undefined => {
    const ids = inner
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => /^source-\d+$/u.test(segment));
    const sourceNumbers = ids.map((id) => sourceNumberById.get(id));
    if (sourceNumbers.length === 0 || sourceNumbers.some((sourceNumber) => sourceNumber === undefined)) {
      return undefined;
    }
    return `[${sourceNumbers.join(",")}]`;
  };
  const citationForUrl = (url: string): string | undefined => {
    const normalizedUrl = normalizeResearchSourceUrl(url);
    if (!normalizedUrl) {
      return undefined;
    }
    const sourceNumber = sourceNumberByUrl.get(normalizedUrl);
    return sourceNumber ? `[${sourceNumber}]` : undefined;
  };

  let result = stripExistingResearchSourcesSection(reportMarkdown).replace(
    /\[((?:\s*source-\d+\s*,\s*)+\s*source-\d+\s*)\](?!\()/g,
    (match, inner: string) => {
      return citationForGroup(inner) ?? match;
    },
  );

  result = result.replace(
    /\[(source-\d+)\](?!\()/g,
    (match, sourceId: string) => citationFor(sourceId) ?? match,
  );

  result = result.replace(
    /\[(source-\d+)\]\([^)]*\)/g,
    (match, sourceId: string) => citationFor(sourceId) ?? match,
  );

  result = result.replace(
    /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g,
    (match, url: string) => citationForUrl(url) ?? match,
  );

  return citationSources.length > 0
    ? `${result.trimEnd()}\n\n${formatResearchSourcesSection(citationSources)}`
    : result;
}

function extractCatalogDomainHints(text: string): string[] {
  const hints = new Set<string>();
  const domainMatches = text.match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+){1,3}\b/gi) ?? [];
  for (const match of domainMatches) {
    const normalized = match.toLowerCase();
    if (normalized.includes(".") && !normalized.endsWith(".") && !/^\d+\.\d+$/.test(normalized)) {
      hints.add(normalized);
    }
    if (hints.size >= 3) {
      break;
    }
  }
  return [...hints];
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(Math.max(value, 0), 1);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeInlineText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

function stripUserFacingResearchScaffoldSections(reportMarkdown: string): string {
  const scaffoldSectionPattern =
    /(?:^|\n{2,})#{2,6}\s+(?:Open Questions|Source Context|Evidence Context|Internal Notes)\s*\n[\s\S]*?(?=\n{2,}#{2,6}\s+|\s*$)/gi;
  return reportMarkdown
    .replace(scaffoldSectionPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatCriticalResearchWarning(message: string): string {
  const cleaned = normalizeInlineText(message).replace(/[.]+$/g, "");
  return `Final model synthesis did not complete: ${cleaned}. A source-backed fallback report was generated from fetched sources instead.`;
}

function normalizePlanText(value: string): string {
  return normalizeInlineText(
    cleanNarrativeLine(value)
      .replace(/^(?:title|goal|objective|topic)\s*:\s*/i, "")
      .replace(/^['"`]+|['"`]+$/g, ""),
  );
}

function normalizeTopicTitle(value: string): string {
  return normalizePlanText(value)
    .replace(/\s*(?:[.;-]?\s*)Goal\s*:\s.*$/i, "")
    .replace(/\s*(?:[.;-]?\s*)Priority\b.*$/i, "")
    .replace(/\s*(?:[.;-]?\s*)(?:Search\s+)?Queries?\s*:\s.*$/i, "")
    .replace(/[.;:\s]+$/g, "")
    .trim();
}

function containsSuspiciousOutputArtifacts(value: string): boolean {
  return (
    value.includes("<channel|>")
    || value.includes("```")
    || /(?:^|\W)jsonset(?:\W|$)/i.test(value)
    || /\bthought:\s/i.test(value)
    || /\breasoning:\s/i.test(value)
  );
}

function normalizeStringArray(value: unknown): string[] {
  return toStringArray(value)
    .map((entry) => normalizeInlineText(entry))
    .filter((entry) => entry.length > 0);
}

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizeInlineText(value);
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringLeaves(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectStringLeaves(entry));
  }
  return [];
}

function stripNarrativeAfterArrayClosures(candidate: string): string {
  let repaired = "";

  for (let index = 0; index < candidate.length; index += 1) {
    const current = candidate[index]!;
    repaired += current;

    if (current !== "]") {
      continue;
    }

    let lookahead = index + 1;
    while (lookahead < candidate.length && /\s/.test(candidate[lookahead]!)) {
      lookahead += 1;
    }

    const next = candidate[lookahead];
    if (!next || next === "," || next === "]" || next === "}") {
      continue;
    }
    if (!/[A-Za-z"'`]/.test(next)) {
      continue;
    }

    while (lookahead < candidate.length && candidate[lookahead] !== "}" && candidate[lookahead] !== ",") {
      lookahead += 1;
    }
    index = lookahead - 1;
  }

  return repaired;
}

function tryParseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  const unfenced = trimmed.startsWith("```")
    ? trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()
    : trimmed;

  const candidates = [unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }

  const seen = new Set<string>();
  const repairCandidates = (candidate: string): string[] => {
    const variants = [
      candidate,
      stripNarrativeAfterArrayClosures(candidate),
      candidate.replace(/,\s*([}\]])/g, "$1"),
      candidate.replace(/(\])\s+[A-Za-z][A-Za-z0-9 _-]*\s*\](\})/g, "$1$2"),
      candidate.replace(/(\})\s+[A-Za-z][A-Za-z0-9 _-]*\s*\}(\])/g, "$1$2"),
      candidate.replace(/(\]|\}|")\s+[A-Za-z][A-Za-z0-9 _-]*\s*(?=,\s*")/g, "$1"),
    ];
    return variants.filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
  };

  for (const candidate of candidates.flatMap((entry) => repairCandidates(entry))) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse failures and continue to the next candidate.
    }
  }

  return undefined;
}

function extractStructuredObjectCandidate(
  result: Pick<ToolSubsessionResult, "structuredOutput" | "outputText">,
): Record<string, unknown> | undefined {
  if (result.structuredOutput && typeof result.structuredOutput === "object" && !Array.isArray(result.structuredOutput)) {
    return result.structuredOutput as Record<string, unknown>;
  }
  return tryParseJsonObject(result.outputText);
}

function extractNarrativeCandidates(result: Pick<ToolSubsessionResult, "events" | "outputText">): string[] {
  const candidates: string[] = [];
  if (result.outputText.trim().length > 0) {
    candidates.push(result.outputText);
  }

  for (const event of result.events) {
    if (event.type !== "content.completed") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const text = toNonEmptyString(payload.text);
    const reasoning = toNonEmptyString(payload.reasoning);
    if (text) {
      candidates.push(text);
    }
    if (reasoning) {
      candidates.push(reasoning);
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return false;
    }
    seen.add(trimmed);
    return true;
  });
}

function cleanNarrativeLine(value: string): string {
  return value
    .replace(/^[\s>*-]+/, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQueryValues(value: string): string[] {
  const quoted = [...value.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((entry) => entry.length > 0);
  if (quoted.length > 0) {
    return quoted;
  }

  return value
    .split(/[|,;]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizePlanRecord(
  raw: Record<string, unknown>,
  fallbackRequest: string,
  profile: ResearchProfile,
): ResearchPlan | undefined {
  const rawTopics = Array.isArray(raw.topics) ? raw.topics as Array<Record<string, unknown>> : [];
  const maxTopics = profile === "quick" ? 2 : 5;
  const topics = rawTopics
    .slice(0, maxTopics)
    .map((topic, index) => {
      const title =
        typeof topic.title === "string" && topic.title.trim().length > 0
          ? normalizeTopicTitle(topic.title)
          : `Topic ${index + 1}`;
      const goal =
        typeof topic.goal === "string" && topic.goal.trim().length > 0
          ? normalizePlanText(topic.goal)
          : title;
      const searchQueries = normalizeStringArray(topic.searchQueries);
      return {
        id: `${slugify(title)}-${index + 1}`,
        title,
        goal,
        priority:
          typeof topic.priority === "number" && Number.isFinite(topic.priority)
            ? Math.max(1, Math.floor(topic.priority))
            : index + 1,
        searchQueries: searchQueries.length > 0 ? searchQueries : [goal],
      } satisfies ResearchTopicPlan;
    });

  const placeholderOnlyTopics = topics.filter((topic) =>
    /^Topic\s+\d+$/i.test(topic.title)
    && topic.goal === topic.title
    && topic.searchQueries.length === 1
    && topic.searchQueries[0] === topic.goal,
  );
  const filteredTopics = topics.filter((topic) =>
    topic.title.length > 0
    && topic.goal.length > 0
    && (placeholderOnlyTopics.length === topics.length || !placeholderOnlyTopics.includes(topic)),
  );
  if (filteredTopics.length === 0) {
    return undefined;
  }

  return {
    objective:
      (typeof raw.objective === "string" ? normalizePlanText(raw.objective) : undefined)
      ?? fallbackRequest,
    scopeSummary:
      typeof raw.scopeSummary === "string"
        ? normalizeInlineText(raw.scopeSummary)
        : undefined,
    topics: filteredTopics,
    risks: normalizeStringArray(raw.risks),
    stopConditions: normalizeStringArray(raw.stopConditions),
  };
}

function recoverPlanFromNarrative(
  narrative: string,
  fallbackRequest: string,
  profile: ResearchProfile,
): ResearchPlan | undefined {
  const lines = narrative
    .split(/\r?\n/)
    .map(cleanNarrativeLine)
    .filter((line) => line.length > 0);

  const topicsByIndex = new Map<number, {
    title: string;
    goal?: string;
    priority?: number;
    searchQueries: string[];
  }>();
  let activeTopicIndex: number | null = null;

  for (const line of lines) {
    const topicMatch = /^Topic\s+(\d+)\s*:\s*(.+)$/i.exec(line);
    if (topicMatch) {
      const topicIndex = Number.parseInt(topicMatch[1] ?? "", 10);
      if (Number.isNaN(topicIndex)) {
        continue;
      }
      const title = normalizeTopicTitle(topicMatch[2]?.trim().replace(/\.$/, "") ?? `Topic ${topicIndex}`);
      const existing = topicsByIndex.get(topicIndex) ?? {
        title,
        goal: title,
        priority: topicIndex,
        searchQueries: [],
      };
      existing.title = title;
      existing.goal ??= title;
      existing.priority ??= topicIndex;
      topicsByIndex.set(topicIndex, existing);
      activeTopicIndex = topicIndex;
      continue;
    }

    if (activeTopicIndex == null) {
      continue;
    }

    const activeTopic = topicsByIndex.get(activeTopicIndex);
    if (!activeTopic) {
      continue;
    }

    const goalMatch = /^Goal\s*:\s*(.+)$/i.exec(line);
    if (goalMatch) {
      activeTopic.goal = normalizePlanText(goalMatch[1]?.trim().replace(/\.$/, "") ?? activeTopic.goal ?? "");
      continue;
    }

    const priorityMatch = /^Priority\s*:\s*(\d+)/i.exec(line);
    if (priorityMatch) {
      activeTopic.priority = Number.parseInt(priorityMatch[1] ?? "", 10);
      continue;
    }

    const queriesMatch = /^(?:Queries|Query|Search Queries|SearchQueries)\s*:\s*(.+)$/i.exec(line);
    if (queriesMatch) {
      activeTopic.searchQueries = extractQueryValues(queriesMatch[1] ?? "")
        .map((entry) => normalizeInlineText(entry))
        .filter((entry) => entry.length > 0);
      continue;
    }
  }

  const maxTopics = profile === "quick" ? 2 : 5;
  const topics = [...topicsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .slice(0, maxTopics)
    .map(([index, topic]) => {
      const title = topic.title.trim();
      const goal = normalizePlanText((topic.goal ?? topic.title).trim());
      const searchQueries = topic.searchQueries.length > 0 ? topic.searchQueries : [goal];
      return {
        id: `${slugify(title)}-${index}`,
        title,
        goal,
        priority: topic.priority ?? index,
        searchQueries,
      } satisfies ResearchTopicPlan;
    })
    .filter((topic) => topic.title.length > 0 && topic.goal.length > 0);

  if (topics.length === 0) {
    return undefined;
  }

  return {
    objective: fallbackRequest,
    topics,
    risks: [],
    stopConditions: [],
  };
}

function recoverPlan(
  result: Pick<ToolSubsessionResult, "structuredOutput" | "outputText" | "events">,
  fallbackRequest: string,
  profile: ResearchProfile,
): ResearchPlan | undefined {
  const structured = extractStructuredObjectCandidate(result);
  if (structured) {
    const normalized = normalizePlanRecord(structured, fallbackRequest, profile);
    if (normalized) {
      return normalized;
    }
  }

  for (const narrative of extractNarrativeCandidates(result)) {
    const recovered = recoverPlanFromNarrative(narrative, fallbackRequest, profile);
    if (recovered) {
      return recovered;
    }
  }

  return undefined;
}

function buildDeterministicResearchPlan(
  requestText: string,
  profile: ResearchProfile,
  reason?: string,
): ResearchPlan {
  const focus = inferResearchFocusQuery(requestText);
  const subject = inferResearchSubject(requestText) ?? focus;
  const isNewsRequest =
    /\b(?:news|headlines|front page|front-page|latest stories?|latest articles?|breaking news|latest)\b/i
      .test(requestText);
  const maxTopics = profile === "quick" ? 2 : 4;
  const risks = [
    reason ? `Model planner fallback used: ${reason}` : "Model planner fallback used.",
    "The deterministic plan may be less nuanced than a model-generated plan, so discovery should compensate with broad source coverage.",
  ];

  if (isNewsRequest) {
    const newsTopics: ResearchTopicPlan[] = [
      {
        id: "front-page-emphasis-1",
        title: "Front Page Emphasis",
        goal: `Find what major news outlets are prominently reporting about ${focus}.`,
        priority: 1,
        searchQueries: [
          `${focus} top headlines`,
          `${focus} front page coverage`,
          `${focus} breaking news`,
        ],
      },
      {
        id: "latest-story-coverage-2",
        title: "Latest Story Coverage",
        goal: `Read current article coverage and live updates about ${focus}.`,
        priority: 2,
        searchQueries: [
          `${focus} latest news`,
          `${focus} latest live updates`,
          `${focus} latest story`,
        ],
      },
      {
        id: "local-and-specialized-sources-3",
        title: "Local and Specialized Sources",
        goal: `Find local, regional, and specialized reporting that may add detail on ${focus}.`,
        priority: 3,
        searchQueries: [
          `${focus} local news`,
          `${focus} regional media`,
          `${focus} independent news`,
        ],
      },
      {
        id: "analysis-and-situation-reports-4",
        title: "Analysis and Situation Reports",
        goal: `Find active blogs, trackers, and analysis pages that add chronology or context for ${focus}.`,
        priority: 4,
        searchQueries: [
          `${focus} live blog`,
          `${focus} situation report`,
          `${focus} expert analysis`,
        ],
      },
    ];
    return {
      objective: requestText,
      scopeSummary: `Gather current news coverage about ${focus} with broad source diversity, one-hop source depth, and explicit dates when available.`,
      topics: newsTopics.slice(0, maxTopics),
      risks,
      stopConditions: [
        "Stop once major, wire, local, and active-analysis coverage have enough fetched source diversity for a grounded report.",
      ],
    };
  }

  const generalTopics: ResearchTopicPlan[] = [
    {
      id: "primary-evidence-1",
      title: `${subject} Primary Evidence`,
      goal: `Find authoritative and high-signal sources for ${subject}.`,
      priority: 1,
      searchQueries: [
        `${focus} official`,
        `${focus} documentation`,
        `${focus} latest`,
      ],
    },
    {
      id: "independent-coverage-2",
      title: `${subject} Independent Coverage`,
      goal: `Find independent reporting, analysis, or reference material for ${subject}.`,
      priority: 2,
      searchQueries: [
        `${focus} analysis`,
        `${focus} report`,
        `${focus} comparison`,
      ],
    },
    {
      id: "current-status-3",
      title: `${subject} Current Status`,
      goal: `Verify the current status, availability, and unresolved questions for ${subject}.`,
      priority: 3,
      searchQueries: [
        `${focus} current status`,
        `${focus} availability`,
        `${focus} update`,
      ],
    },
  ];
  return {
    objective: requestText,
    scopeSummary: `Research ${subject} using a deterministic fallback plan with broad discovery and source-depth checks.`,
    topics: generalTopics.slice(0, maxTopics),
    risks,
    stopConditions: [
      "Stop once the gathered evidence covers authoritative sources, independent coverage, and current status.",
    ],
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferResearchSubject(requestText: string): string | undefined {
  for (const family of KNOWN_MODEL_FAMILIES) {
    const match = new RegExp(`\\b(${family})(?:\\s+([0-9][a-z0-9.-]*))?\\b`, "i").exec(requestText);
    if (match?.[1]) {
      return [match[1], match[2]].filter(Boolean).join(" ");
    }
  }

  const patterns = [
    /\b(?:news|coverage|stories?|headlines?)\s+from\s+([a-z0-9+_.:-]+(?:\s+[a-z0-9+_.:-]+){0,4}?)(?=\s+(?:across|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
    /\b(?:news|coverage|stories?|headlines?)\s+(?:on|about|regarding)\s+([a-z0-9+_.:-]+(?:\s+[a-z0-9+_.:-]+){0,4}?)(?=\s+(?:across|from|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
    /\b(?:about|regarding)\s+([a-z0-9+_.:-]+(?:\s+[a-z0-9+_.:-]+){0,4}?)(?=\s+(?:across|from|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
    /\b(?:variations|versions|types|models|releases)\s+of\s+([a-z0-9+_.:-]+(?:\s+[a-z0-9+_.:-]+){0,4}?)(?=\s+(?:on|in|across|available|that|for)\b|[,.!?]|$)/i,
    /\b(?:understand|map|research|inspect|catalog|compare)\s+([a-z0-9+_.:-]+(?:\s+[a-z0-9+_.:-]+){0,4}?)(?=\s+(?:on|in|across|available|that|for)\b|[,.!?]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(requestText);
    const candidate = match?.[1]
      ?.replace(/\b(?:all|the|local)\b/gi, "")
      .replace(/\bmodels?\b$/i, "")
      .replace(/\bfamily\b$/i, "")
      .replace(/\b(?:news|coverage|headlines|stories?)\b$/i, "")
      .replace(/\b(?:capital|city)\b$/i, "")
      .replace(/\b(?:taht|that)\b.*$/i, "")
      .replace(/\b(?:exists|exist|available)\b.*$/i, "")
      .replace(/\betc\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (candidate && candidate.length > 0) {
      return toTitleCase(candidate);
    }
  }

  return undefined;
}

function detectMentionedProviders(value: string): ProviderId[] {
  const matches = PROVIDER_DEFINITIONS
    .map((provider, index) => {
      const match = provider.pattern.exec(value);
      if (!match) {
        return undefined;
      }
      return {
        id: provider.id,
        index: match.index,
        order: index,
      };
    })
    .filter((entry): entry is { id: ProviderId; index: number; order: number } => Boolean(entry))
    .sort((left, right) => left.index - right.index || left.order - right.order);

  const seen = new Set<ProviderId>();
  const providers: ProviderId[] = [];
  for (const match of matches) {
    if (seen.has(match.id)) {
      continue;
    }
    seen.add(match.id);
    providers.push(match.id);
  }
  return providers;
}

function detectRequestedDimensions(value: string): ResearchDimensionId[] {
  return RESEARCH_DIMENSION_DEFINITIONS
    .filter((dimension) => dimension.pattern.test(value))
    .map((dimension) => dimension.id);
}

function detectRequestedSurfaces(value: string): ResearchSurfaceId[] {
  return RESEARCH_SURFACE_DEFINITIONS
    .filter((surface) => surface.pattern.test(value))
    .map((surface) => surface.id);
}

function isModelCatalogResearchRequest(value: string): boolean {
  const mentionsCatalogLanguage = /\b(?:catalog|catalogue|version|versions|release|releases|type|types|variant|variants|variation|variations|family|families|source|sources|availability|packaging|package|distribution|download|downloads|registry|registries|model cards?)\b/i
    .test(value);
  if (!mentionsCatalogLanguage) {
    return false;
  }

  if (/\b(?:model|models|checkpoint|checkpoints|weights?|gguf|quant(?:ization)?s?)\b/i.test(value)) {
    return true;
  }

  return KNOWN_MODEL_FAMILIES.some((family) => new RegExp(`\\b${family}\\b`, "i").test(value));
}

function inferResearchFocusQuery(requestText: string): string {
  const subjectPatterns = [
    /\b(?:news|coverage|stories?|headlines?)\s+from\s+(.+?)(?=\s+(?:across|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
    /\b(?:news|coverage|stories?|headlines?)\s+(?:on|about|regarding)\s+(.+?)(?=\s+(?:across|from|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
    /\b(?:about|regarding)\s+(.+?)(?=\s+(?:across|from|and|with|for|plus|read|give|report|call|compare|see|using)\b|[,.!?]|$)/i,
  ];
  for (const pattern of subjectPatterns) {
    const match = pattern.exec(requestText);
    if (match?.[1]) {
      const focused = match[1]
        .replace(/^(?:what\s+)?(?:there\s+is\s+|there\s+are\s+)/i, "")
        .replace(/^(?:about|regarding)\s+/i, "")
        .replace(/\b(?:news|coverage|headlines|stories?)\b$/i, "")
        .replace(/\b(?:capital|city)\b$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (focused.length > 0) {
        return focused.slice(0, 120);
      }
    }
  }

  const firstSentence = requestText.split(/[.!?]/, 1)[0] ?? requestText;
  const patterns = [
    /\b(?:go\s+)?(?:research|check|assess|compare|investigate|summarize|map|review|cover|analyze|analyse|explore|inspect|study)\s+(.+)$/i,
    /\b(?:i want|give me|find)\s+(.+)$/i,
  ];

  let candidate = firstSentence.trim();
  for (const pattern of patterns) {
    const match = pattern.exec(firstSentence);
    if (match?.[1]) {
      candidate = match[1];
      break;
    }
  }

  const normalized = candidate
    .replace(/\b(?:top|major|mainstream)\s+news\s+(?:websites?|sites?|outlets?)(?:\s+like\s+[^,.!?]+)?/gi, " ")
    .replace(/\b(?:and\s+give\s+me\b.*|include\b.*|check\b.*|focus\s+on\b.*|call\s+out\b.*)$/i, "")
    .replace(/\b(?:today|currently|current)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 0 ? normalized.slice(0, 120) : normalizeInlineText(requestText).slice(0, 120);
}

function makeDimensionTopic(
  dimension: ResearchDimensionId,
  subject: string,
  priority: number,
): ResearchTopicPlan {
  const lowerSubject = subject.toLowerCase();
  const topicByDimension: Record<ResearchDimensionId, Omit<ResearchTopicPlan, "id" | "priority">> = {
    versions: {
      title: `${subject} Release Lineage`,
      goal: `Map official ${lowerSubject} generations, release dates, and core sizes.`,
      searchQueries: [
        `${subject} releases`,
        `${subject} model family versions`,
        `official ${subject} release notes`,
      ],
    },
    types: {
      title: `${subject} Types`,
      goal: `Catalog ${lowerSubject} variants, modalities, and size classes.`,
      searchQueries: [
        `${subject} model variants`,
        `${subject} model family architectures`,
        `${subject} model sizes and types`,
      ],
    },
    sources: {
      title: `${subject} Sources`,
      goal: `Identify official and packaging sources for ${lowerSubject} models.`,
      searchQueries: [
        `${subject} official docs`,
        `${subject} Hugging Face models`,
        `${subject} Ollama library`,
      ],
    },
  };

  const topic = topicByDimension[dimension];
  return {
    id: `${slugify(topic.title)}-${priority}`,
    title: topic.title,
    goal: topic.goal,
    priority,
    searchQueries: topic.searchQueries,
  };
}

function makeProviderTopic(
  provider: ProviderId,
  subject: string,
  priority: number,
): ResearchTopicPlan {
  const lowerSubject = subject.toLowerCase();
  const topicByProvider: Record<ProviderId, Omit<ResearchTopicPlan, "id" | "priority">> = {
    official: {
      title: `Official ${subject} Models`,
      goal: `Catalog official ${lowerSubject} generations, sizes, and naming.`,
      searchQueries: [
        `official ${lowerSubject} models`,
        `google ${lowerSubject} model family`,
      ],
    },
    ollama: {
      title: `${subject} on Ollama`,
      goal: `Map ${lowerSubject} variants and tags available in Ollama.`,
      searchQueries: [
        `ollama ${lowerSubject} library`,
        `ollama ${lowerSubject} tags`,
      ],
    },
    "lm-studio": {
      title: `${subject} on LM Studio`,
      goal: `Map ${lowerSubject} variants and GGUF packaging in LM Studio.`,
      searchQueries: [
        `LM Studio ${lowerSubject} models`,
        `${lowerSubject} GGUF LM Studio`,
      ],
    },
    "hugging-face": {
      title: `${subject} on Hugging Face`,
      goal: `Map ${lowerSubject} checkpoints and naming on Hugging Face.`,
      searchQueries: [
        `Hugging Face ${lowerSubject} models`,
        `${lowerSubject} transformers Hugging Face`,
      ],
    },
  };

  const topic = topicByProvider[provider];
  return {
    id: `${slugify(topic.title)}-${priority}`,
    title: topic.title,
    goal: topic.goal,
    priority,
    searchQueries: topic.searchQueries,
  };
}

function makeSurfaceTopic(
  surface: ResearchSurfaceId,
  requestText: string,
  priority: number,
): ResearchTopicPlan {
  const focus = inferResearchFocusQuery(requestText);
  const prefersReviews = /\breview|reviews|hands[- ]on\b/i.test(requestText);
  const topicBySurface: Record<ResearchSurfaceId, Omit<ResearchTopicPlan, "id" | "priority">> = {
    official: {
      title: "Official sources",
      goal: "Ground the research in official docs, specs, and first-party updates.",
      searchQueries: [
        `${focus} official docs`,
        `${focus} release notes`,
      ],
    },
    news: {
      title: prefersReviews ? "Review coverage" : "Recent coverage",
      goal: prefersReviews
        ? "Gather reputable review coverage with current outside perspective."
        : "Gather recent reporting and coverage with current outside perspective.",
      searchQueries: prefersReviews
        ? [`${focus} reviews`, `${focus} coverage`]
        : [`${focus} news`, `${focus} coverage`],
    },
    ecosystem: {
      title: "Ecosystem updates",
      goal: "Track tooling, release-note, vendor, and GitHub implementation updates.",
      searchQueries: [
        `${focus} tooling updates`,
        `${focus} GitHub issues`,
        `${focus} blog posts`,
      ],
    },
    community: {
      title: "Community discussion",
      goal: "Capture Reddit, HN, forum, and owner-community reaction.",
      searchQueries: [
        `${focus} reddit discussion`,
        `${focus} hacker news`,
        `${focus} community reaction`,
      ],
    },
  };

  const topic = topicBySurface[surface];
  return {
    id: `${slugify(topic.title)}-${priority}`,
    title: topic.title,
    goal: topic.goal,
    priority,
    searchQueries: topic.searchQueries,
  };
}

function appendCoverageTopics(
  plan: ResearchPlan,
  topicFactory: (priority: number) => ResearchTopicPlan,
  missingCount: number,
  maxTopics: number,
): ResearchPlan {
  if (missingCount <= 0 || plan.topics.length >= maxTopics) {
    return plan;
  }

  const topics = [...plan.topics];
  let nextPriority = topics.reduce((highest, topic) => Math.max(highest, topic.priority), 0) + 1;
  let remaining = missingCount;

  while (remaining > 0 && topics.length < maxTopics) {
    topics.push(topicFactory(nextPriority));
    nextPriority += 1;
    remaining -= 1;
  }

  return topics.length === plan.topics.length ? plan : { ...plan, topics };
}

function buildProviderCoverageFallbackPlan(
  requestText: string,
  profile: ResearchProfile,
  requestedProviders: ProviderId[],
  existingPlan?: ResearchPlan,
): ResearchPlan {
  const maxTopics = profile === "quick" ? 2 : 5;
  const subject = inferResearchSubject(requestText) ?? "Requested Model";
  const topics: ResearchTopicPlan[] = [];
  let priority = 1;

  if (maxTopics > requestedProviders.length) {
    topics.push(makeProviderTopic("official", subject, priority));
    priority += 1;
  }

  for (const provider of requestedProviders) {
    if (topics.length >= maxTopics) {
      break;
    }
    topics.push(makeProviderTopic(provider, subject, priority));
    priority += 1;
  }

  return {
    objective: existingPlan?.objective ?? normalizePlanText(requestText),
    scopeSummary:
      existingPlan?.scopeSummary
      ?? `Cover ${subject} variations across ${topics.map((topic) => topic.title).join(", ")}.`,
    topics,
    risks: existingPlan?.risks ?? [],
    stopConditions:
      existingPlan?.stopConditions.length
        ? existingPlan.stopConditions
        : ["Stop when each requested platform has at least one cited source."],
  };
}

function ensureProviderCoverage(
  requestText: string,
  plan: ResearchPlan,
  profile: ResearchProfile,
): ResearchPlan {
  const requestedProviders = detectMentionedProviders(requestText)
    .filter((provider) => provider !== "official");
  const requestedProviderSet = new Set<ProviderId>(requestedProviders);
  if (requestedProviders.length < 2) {
    return plan;
  }

  const coveredTopics = plan.topics.filter((topic) => {
    const haystack = [topic.title, topic.goal, ...topic.searchQueries].join(" ");
    return detectMentionedProviders(haystack)
      .some((provider) => requestedProviderSet.has(provider));
  });
  const coveredProviders = new Set(
    detectMentionedProviders(
      [
        plan.objective,
        plan.scopeSummary ?? "",
        ...plan.topics.flatMap((topic) => [topic.title, topic.goal, ...topic.searchQueries]),
      ].join(" "),
    ),
  );
  const missingProviders = requestedProviders.filter((provider) => !coveredProviders.has(provider));
  const expectedProviderTopics = Math.min(requestedProviders.length, profile === "quick" ? 2 : 5);
  const underScoped = missingProviders.length > 0 || coveredTopics.length < expectedProviderTopics;

  if (!underScoped) {
    return plan;
  }

  return buildProviderCoverageFallbackPlan(requestText, profile, requestedProviders, plan);
}

function buildDimensionCoverageFallbackPlan(
  requestText: string,
  profile: ResearchProfile,
  requestedDimensions: ResearchDimensionId[],
  existingPlan?: ResearchPlan,
): ResearchPlan {
  const maxTopics = profile === "quick" ? 2 : 5;
  const subject = inferResearchSubject(requestText) ?? "Requested Model";
  const topics = requestedDimensions
    .slice(0, maxTopics)
    .map((dimension, index) => makeDimensionTopic(dimension, subject, index + 1));

  return {
    objective: existingPlan?.objective ?? normalizePlanText(requestText),
    scopeSummary:
      existingPlan?.scopeSummary
      ?? `Cover ${subject} release lineage, model types, and sources.`,
    topics,
    risks: existingPlan?.risks ?? [],
    stopConditions:
      existingPlan?.stopConditions.length
        ? existingPlan.stopConditions
        : ["Stop when releases, model types, and source surfaces each have cited coverage."],
  };
}

function ensureDimensionCoverage(
  requestText: string,
  plan: ResearchPlan,
  profile: ResearchProfile,
): ResearchPlan {
  if (!isModelCatalogResearchRequest(requestText)) {
    return plan;
  }

  const requestedDimensions = detectRequestedDimensions(requestText);
  if (requestedDimensions.length < 2) {
    return plan;
  }

  const maxTopics = profile === "quick" ? 2 : 5;
  const expectedTopicCount = Math.min(requestedDimensions.length, maxTopics);
  const coveredDimensions = new Set<ResearchDimensionId>();
  for (const topic of plan.topics) {
    const haystack = [topic.title, topic.goal, ...topic.searchQueries].join(" ");
    for (const dimension of detectRequestedDimensions(haystack)) {
      coveredDimensions.add(dimension);
    }
  }

  const missingDimensions = requestedDimensions.filter((dimension) => !coveredDimensions.has(dimension));
  const underScoped = plan.topics.length < expectedTopicCount || missingDimensions.length > 0;
  if (!underScoped) {
    return plan;
  }

  return buildDimensionCoverageFallbackPlan(requestText, profile, requestedDimensions, plan);
}

function ensureSurfaceCoverage(
  requestText: string,
  plan: ResearchPlan,
  profile: ResearchProfile,
): ResearchPlan {
  const requestedSurfaces = detectRequestedSurfaces(requestText);
  if (requestedSurfaces.length < 2) {
    return plan;
  }

  const coveredSurfaces = new Set<ResearchSurfaceId>();
  const planHaystacks = [
    [plan.objective, plan.scopeSummary ?? ""].join(" "),
    ...plan.topics.map((topic) => [topic.title, topic.goal, ...topic.searchQueries].join(" ")),
  ];
  for (const haystack of planHaystacks) {
    for (const surface of detectRequestedSurfaces(haystack)) {
      coveredSurfaces.add(surface);
    }
  }

  const missingSurfaces = requestedSurfaces.filter((surface) => !coveredSurfaces.has(surface));
  if (missingSurfaces.length === 0) {
    return plan;
  }

  const missingQueue = [...missingSurfaces];
  return appendCoverageTopics(
    plan,
    (priority) => makeSurfaceTopic(missingQueue.shift() ?? "official", requestText, priority),
    missingSurfaces.length,
    profile === "quick" ? 2 : 5,
  );
}

function ensurePlanCoverage(
  requestText: string,
  plan: ResearchPlan,
  profile: ResearchProfile,
): ResearchPlan {
  if (isModelCatalogResearchRequest(requestText)) {
    return ensureDimensionCoverage(
      requestText,
      ensureProviderCoverage(requestText, plan, profile),
      profile,
    );
  }

  return ensureSurfaceCoverage(requestText, plan, profile);
}

function extractSourceRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const stack: unknown[] = [value];

  const collectEmbeddedRefs = (text: string): void => {
    const matches = text.matchAll(/https?:\/\/[^\s"'`,\]]+|source-\d+/gi);
    for (const match of matches) {
      const candidate = match[0]?.trim().replace(/[.,;:]+$/g, "");
      if (candidate) {
        refs.add(candidate);
      }
    }
  };

  const collectStructuredSourceEntries = (candidate: unknown): void => {
    const queue: unknown[] = [candidate];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      if (typeof current === "string") {
        collectEmbeddedRefs(current);
        continue;
      }
      if (Array.isArray(current)) {
        for (const entry of current) {
          queue.push(entry);
        }
        continue;
      }
      if (typeof current !== "object") {
        continue;
      }

      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
        if (
          normalizedKey === "id"
          || normalizedKey === "sourceid"
          || normalizedKey === "sourceref"
          || normalizedKey === "ref"
          || normalizedKey === "url"
          || normalizedKey === "href"
        ) {
          for (const value of collectStringLeaves(entry)) {
            collectEmbeddedRefs(value);
          }
        } else if (normalizedKey === "items" || normalizedKey === "entries" || normalizedKey === "sources") {
          queue.push(entry);
        }
      }
    }
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }

    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (normalizedKey.includes("sourceref")) {
        collectEmbeddedRefs(key);
        for (const candidate of collectStringLeaves(entry)) {
          refs.add(candidate);
        }
        continue;
      }
      if (
        normalizedKey === "sources"
        || normalizedKey.endsWith("sources")
        || normalizedKey === "citations"
        || normalizedKey.endsWith("citations")
        || normalizedKey === "references"
        || normalizedKey.endsWith("references")
      ) {
        collectStructuredSourceEntries(entry);
        continue;
      }
      stack.push(entry);
    }
  }

  return [...refs];
}

function normalizeFinalSynthesisRecord(raw: Record<string, unknown>): FinalSynthesisRecord | undefined {
  const summary = toNonEmptyString(raw.summary);
  const reportMarkdown = toNonEmptyString(raw.reportMarkdown);
  if (!summary || !reportMarkdown) {
    return undefined;
  }
  const cleanedReportMarkdown = stripUserFacingResearchScaffoldSections(reportMarkdown);
  if (containsSuspiciousOutputArtifacts(summary) || containsSuspiciousOutputArtifacts(cleanedReportMarkdown)) {
    return undefined;
  }

  return {
    summary: normalizeInlineText(summary),
    reportMarkdown: cleanedReportMarkdown,
    openQuestions: normalizeStringArray(raw.openQuestions),
    sourceIds: normalizeStringArray(raw.sourceIds),
    confidence: clampConfidence(raw.confidence),
  };
}

interface NormalizedDossierRecord {
  summary: string;
  findings: string[];
  contradictions: string[];
  openQuestions: string[];
  sourceRefs: string[];
  confidence: number;
}

interface SynthesisSelfCheckRecord {
  ok: boolean;
  issues: string[];
  needsRetry: boolean;
}

function normalizeDossierRecord(raw: Record<string, unknown>): NormalizedDossierRecord | undefined {
  const summary = toNonEmptyString(raw.summary);
  if (!summary || containsSuspiciousOutputArtifacts(summary)) {
    return undefined;
  }

  const findings = normalizeStringArray(raw.findings);
  const contradictions = normalizeStringArray(raw.contradictions);
  const openQuestions = normalizeStringArray(raw.openQuestions);
  if ([...findings, ...contradictions, ...openQuestions].some((entry) => containsSuspiciousOutputArtifacts(entry))) {
    return undefined;
  }

  return {
    summary: normalizeInlineText(summary),
    findings,
    contradictions,
    openQuestions,
    sourceRefs: extractSourceRefs(raw),
    confidence: clampConfidence(raw.confidence),
  };
}

function _normalizeSynthesisSelfCheckRecord(
  raw: Record<string, unknown>,
): SynthesisSelfCheckRecord | undefined {
  if (typeof raw.ok !== "boolean") {
    return undefined;
  }
  return {
    ok: raw.ok,
    issues: normalizeStringArray(raw.issues),
    needsRetry: raw.ok ? false : Boolean(raw.needsRetry ?? true),
  };
}

function buildHeuristicSynthesisSelfCheckRecord(
  brief: ResearchBrief,
  finalSynthesis: FinalSynthesisRecord,
  sources: ResearchSourceRecord[],
): SynthesisSelfCheckRecord {
  const issues: string[] = [];
  const reportText = `${finalSynthesis.summary}\n${finalSynthesis.reportMarkdown}`;
  if (containsSuspiciousOutputArtifacts(finalSynthesis.summary) || containsSuspiciousOutputArtifacts(finalSynthesis.reportMarkdown)) {
    issues.push("Report contained suspicious structured-output leakage.")
  }
  if (finalSynthesis.reportMarkdown.trim().length === 0) {
    issues.push("Report body was empty.")
  }
  if (brief.taskType === "news-sweep") {
    const hasFrontPageEvidence = sources.some((source) => source.pageRole === "front_page");
    const hasArticleEvidence = sources.some((source) => source.sourceFamily === "mainstream_article");
    const hasDateEvidence = sources.some((source) =>
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|202[4-9]|\d{1,2}\s+(?:minutes?|mins?|hours?|days?)\s+ago|yesterday|today)\b/i
        .test(source.contentPreview),
    );
    if (hasFrontPageEvidence && !/\b(?:front page|headline)\b/i.test(reportText)) {
      issues.push("News synthesis did not describe front-page emphasis.");
    }
    if (hasArticleEvidence && !/\b(?:latest story|live update)\b/i.test(reportText)) {
      issues.push("News synthesis did not call out the latest specific stories.");
    }
    if (hasDateEvidence && !/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|202[4-9])\b/.test(reportText)) {
      issues.push("News synthesis did not include concrete dates even though the evidence had time cues.");
    }
    if (!/\b(?:agree|agreed|disagree|disagreed|consensus|divergence|differ|difference)\b/i.test(reportText)) {
      issues.push("News synthesis did not summarize where outlets agreed or diverged.");
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    needsRetry: issues.length > 0,
  };
}

function topicRequestsCommunityCoverage(topic: ResearchTopicPlan): boolean {
  return /\b(?:reddit|community|communities|social|forum|forums|discussion|discussions|sentiment|hacker news|hn)\b/i
    .test([topic.title, topic.goal, ...topic.searchQueries].join(" "));
}

function topicRequestsOfficialCoverage(topic: ResearchTopicPlan): boolean {
  return /\b(?:official|docs?|documentation|spec|specification|newsroom|first[- ]party)\b/i
    .test([topic.title, topic.goal, ...topic.searchQueries].join(" "));
}

function topicRequestsReferenceCoverage(topic: ResearchTopicPlan): boolean {
  return /\b(?:github|repo|repository|releases?|changelog|framework|frameworks|tooling|toolchain|ecosystem|library|libraries|package|packages|compatibility|integration|vendor|implementation|migration)\b/i
    .test([topic.title, topic.goal, ...topic.searchQueries].join(" "));
}

function topicRequestsReviewCoverage(topic: ResearchTopicPlan): boolean {
  return /\b(?:review|reviews|benchmark|benchmarks|coverage|hands[- ]on|performance|battery)\b/i
    .test([topic.title, topic.goal, ...topic.searchQueries].join(" "));
}

function isCommunitySearchCandidate(candidate: SearchSnippetSourceCandidate): boolean {
  return /\b(?:reddit(?:media)?|news\.ycombinator|lobste\.rs|forum|forums|discuss|community|communities)\b/i
    .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" "));
}

function isOfficialSearchCandidate(candidate: SearchSnippetSourceCandidate): boolean {
  return /\b(?:official|support|developer|docs?|documentation|spec|specification|newsroom)\b/i
    .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" "))
    || /\.gov(?:\/|$)/i.test(candidate.url)
    || /\b(?:apple\.com|nasa\.gov|rust-lang\.org|react\.dev|reactjs\.org|pytorch\.org|modelcontextprotocol\.io|anthropic\.com|deepmind\.google|ai\.google\.dev|ollama\.com|lmstudio\.ai|nextjs\.org|vercel\.com|vite\.dev|remix\.run|qwenlm\.github\.io)\b/i
      .test([candidate.url, candidate.siteName ?? ""].join(" "));
}

function isReviewSearchCandidate(candidate: SearchSnippetSourceCandidate): boolean {
  return /\b(?:theverge\.com|arstechnica\.com|anandtech\.com|tomshardware\.com|engadget\.com|wired\.com|cnet\.com|macworld\.com|appleinsider\.com|macrumors\.com|macobserver\.com|pcmag\.com|techradar\.com|review|reviews|benchmark|benchmarks|hands[- ]on)\b/i
    .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" "));
}

function shouldPreserveBlockedSearchSnippet(
  topic: ResearchTopicPlan,
  candidate: SearchSnippetSourceCandidate,
): boolean {
  return (
    topicRequestsCommunityCoverage(topic)
    || isCommunitySearchCandidate(candidate)
    || (topicRequestsReferenceCoverage(topic) && /(?:github\.com|docs?|documentation|release|releases|changelog|nextjs\.org|vite\.dev|remix\.run|docs\.rs|tokio\.rs)/i
      .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" ")))
    || (topicRequestsOfficialCoverage(topic) && isOfficialSearchCandidate(candidate))
  );
}

function _rankDiscoveryCandidatesForTopic(
  topic: ResearchTopicPlan,
  query: string,
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    siteName?: string;
  }>,
): SearchSnippetSourceCandidate[] {
  return results
    .map((result, index) => ({
      topicId: topic.id,
      query,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      siteName: result.siteName,
      index,
    }))
    .sort((left, right) => {
      const score = (candidate: SearchSnippetSourceCandidate): number => {
        let value = 0;
        if (topicRequestsOfficialCoverage(topic) && isOfficialSearchCandidate(candidate)) {
          value += 100;
        }
        if (topicRequestsCommunityCoverage(topic) && isCommunitySearchCandidate(candidate)) {
          value += 80;
        }
        if (topicRequestsReviewCoverage(topic) && isReviewSearchCandidate(candidate)) {
          value += 40;
        }
        if (/wikipedia\.org/i.test(candidate.url)) {
          value -= 20;
        }
        return value;
      };
      return score(right) - score(left) || left.index - right.index;
    })
    .map(({ index: _index, ...candidate }) => candidate);
}

function buildCommunityFallbackQuery(plan: ResearchPlan, topic: ResearchTopicPlan): string | undefined {
  const candidate =
    topic.searchQueries.find((query) =>
      /\b(?:reddit|hacker news|hn|discussion|discussions|sentiment|community|communities|forum|forums)\b/i
        .test(query))
    ?? `${plan.objective} ${topic.title} ${topic.goal}`;
  const normalized = candidate
    .replace(/\br\/[a-z0-9_+-]+\b/gi, " ")
    .replace(/\b(?:reddit|hacker news|hn|discussion|discussions|sentiment|community|communities|forum|forums|github|issues?|adoption|migration|challenges?)\b/gi, " ")
    .replace(/[^a-z0-9.+-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.slice(0, 120);
}

function buildFallbackSeedUrls(
  plan: ResearchPlan,
  topic: ResearchTopicPlan,
  sourceFamily?: ResearchSourceFamily,
): string[] {
  if (process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS === "1") {
    return [];
  }

  const topicHaystack = [
    topic.title,
    topic.goal,
    ...topic.searchQueries,
  ]
    .join(" ")
    .toLowerCase();
  const hasTopicSpecificRuntimeHint = /\b(?:lm studio|lmstudio|ollama|hugging face|huggingface|google|official|llama(?:\.| )?cpp)\b/
    .test(topicHaystack);
  const haystack = hasTopicSpecificRuntimeHint
    ? topicHaystack
    : `${topicHaystack} ${plan.objective.toLowerCase()}`;
  const urls = new Set<string>();
  const mentionsGemma = /\bgemma\b/.test(`${topicHaystack} ${plan.objective.toLowerCase()}`);
  const mentionsQwen = /\bqwen\b/.test(`${topicHaystack} ${plan.objective.toLowerCase()}`);
  const mentionsReact = /\breact(?:\s*19)?\b/.test(haystack);
  const mentionsRust = /\brust(?:\s*2024)?\b/.test(haystack);
  const mentionsMcp = /\b(?:model context protocol|mcp)\b/.test(haystack);
  const mentionsPyTorch = /\bpytorch\b/.test(haystack);
  const mentionsAppleSilicon = /\b(?:apple silicon|macos|mps)\b/.test(haystack);
  const mentionsAppleM5 = /\bapple\b/.test(haystack) && /\bm5\b/.test(haystack);
  const mentionsGithub = /\b(?:github|issue|issues|release|releases|release notes|community|reddit|hacker news|hn|discussion|discussions)\b/
    .test(haystack);
  const mentionsLlamaCpp = /\bllama(?:\.| )?cpp\b/.test(haystack);
  const mentionsFrameworks = /\b(?:next(?:\.| )?js|vite|remix|framework|frameworks|tooling|ecosystem|integration|compatibility)\b/
    .test(haystack);

  if (sourceFamily === "official" && mentionsReact) {
    urls.add("https://react.dev/");
    urls.add("https://react.dev/blog");
    urls.add("https://react.dev/reference/react");
  }

  if (sourceFamily === "reference_github_docs" && mentionsReact) {
    urls.add("https://github.com/facebook/react/releases");
    urls.add("https://raw.githubusercontent.com/facebook/react/main/CHANGELOG.md");
    if (mentionsFrameworks) {
      urls.add("https://nextjs.org/blog");
      urls.add("https://vite.dev/guide/");
      urls.add("https://remix.run/docs");
    }
  }

  if (sourceFamily === "official" && mentionsRust) {
    urls.add("https://www.rust-lang.org/");
    urls.add("https://blog.rust-lang.org/");
    urls.add("https://doc.rust-lang.org/edition-guide/rust-2024/index.html");
  }

  if (sourceFamily === "reference_github_docs" && mentionsRust) {
    urls.add("https://github.com/rust-lang/rust/releases");
    urls.add("https://docs.rs/");
    urls.add("https://tokio.rs/blog");
  }

  if (sourceFamily === "official" && mentionsMcp) {
    urls.add("https://modelcontextprotocol.io/introduction");
    urls.add("https://modelcontextprotocol.io/docs");
    urls.add("https://spec.modelcontextprotocol.io/");
  }

  if (sourceFamily === "reference_github_docs" && mentionsMcp) {
    urls.add("https://github.com/modelcontextprotocol");
    urls.add("https://github.com/modelcontextprotocol/servers");
    urls.add("https://docs.anthropic.com/en/docs/agents-and-tools/mcp");
  }

  if (sourceFamily === "official" && mentionsPyTorch && mentionsAppleSilicon) {
    urls.add("https://pytorch.org/docs/stable/notes/mps.html");
    urls.add("https://developer.apple.com/metal/pytorch/");
    urls.add("https://pytorch.org/");
  }

  if (sourceFamily === "reference_github_docs" && mentionsPyTorch && mentionsAppleSilicon) {
    urls.add("https://github.com/pytorch/pytorch/issues?q=is%3Aissue+mps+is%3Aopen");
    urls.add("https://github.com/pytorch/pytorch/issues?q=is%3Aissue+apple+silicon");
  }

  if (sourceFamily === "official" && mentionsAppleM5) {
    urls.add("https://www.apple.com/macbook-pro/");
    urls.add("https://www.apple.com/newsroom/");
  }

  if (sourceFamily === "mainstream_article" && mentionsAppleM5) {
    urls.add("https://www.theverge.com/tech");
    urls.add("https://arstechnica.com/gadgets/");
    urls.add("https://www.macrumors.com/roundup/macbook-pro/");
  }

  if (/(lm studio|lmstudio)/.test(haystack)) {
    urls.add("https://lmstudio.ai/models");
    urls.add("https://lmstudio.ai/docs");
    urls.add("https://lmstudio.ai/docs/app");
    if (mentionsGemma) {
      urls.add("https://lmstudio.ai/models/gemma-4");
    }
  }

  if (/\bollama\b/.test(haystack)) {
    urls.add("https://github.com/ollama/ollama");
    if (mentionsGemma) {
      urls.add("https://ollama.com/library/gemma4/tags");
      urls.add("https://ollama.com/library/gemma");
    } else {
      urls.add("https://ollama.com/library");
    }
    if (mentionsGithub) {
      urls.add("https://github.com/ollama/ollama/issues");
      urls.add("https://ollama.com/blog");
    }
  }

  if (/(hugging face|huggingface)/.test(haystack)) {
    urls.add(mentionsGemma ? "https://huggingface.co/models?search=gemma" : "https://huggingface.co/models");
    if (mentionsGemma) {
      urls.add("https://huggingface.co/docs/transformers/model_doc/gemma");
    }
  }

  if (/(google|official)/.test(haystack) && mentionsGemma) {
    urls.add("https://deepmind.google/models/gemma/gemma-4");
    urls.add("https://github.com/google-deepmind/gemma");
  }

  if (sourceFamily === "official" && mentionsQwen) {
    urls.add("https://qwenlm.github.io/");
    urls.add("https://github.com/QwenLM");
  }

  if (mentionsLlamaCpp) {
    urls.add("https://github.com/ggml-org/llama.cpp");
    if (mentionsGithub) {
      urls.add("https://github.com/ggml-org/llama.cpp/issues");
    }
  }

  if (topicRequestsCommunityCoverage(topic)) {
    const communityQuery = buildCommunityFallbackQuery(plan, topic);
    if (communityQuery) {
      urls.add(`https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(communityQuery)}`);
    }
  }

  return [...urls].slice(0, DEFAULT_FETCHES_PER_TOPIC * 2);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function dedupeSourceFamilies(values: ResearchSourceFamily[]): ResearchSourceFamily[] {
  const seen = new Set<ResearchSourceFamily>();
  const result: ResearchSourceFamily[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function formatResearchCurrentDate(value = new Date()): string {
  return value.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function parseUrlDomain(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isLikelyFrontPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" || /^\/(?:news)?\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isLikelyArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.length > 1 && !isLikelyFrontPageUrl(url);
  } catch {
    return false;
  }
}

function isKnownMainstreamNewsDomain(domain: string | undefined): boolean {
  if (!domain) {
    return false;
  }
  return (
    MAINSTREAM_NEWS_OUTLETS.some((candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`))
    || domain === "news.google.com"
  );
}

function isLikelyNewsMetaPage(url: string, title = "", snippet = ""): boolean {
  return /\b(?:top\s+\d+|best\s+news\s+sites?|most\s+popular\s+websites?|news\s+websites?|media\s+metrics|traffic|similarweb|rankings?)\b/i
    .test([url, title, snippet].join(" "));
}

function buildResearchFocusTerms(brief: ResearchBrief): string[] {
  return dedupeStrings(
    [brief.subject ?? "", brief.focusQuery]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((value) => value.trim())
      .filter((value) => value.length >= 4 && !RESEARCH_FOCUS_STOPWORDS.has(value)),
  );
}

function extractExplicitUrlsFromText(value: string): string[] {
  return dedupeStrings(
    [...value.matchAll(/https?:\/\/[^\s)\]]+/gi)]
      .map((match) => match[0]?.replace(/[),.;]+$/g, "") ?? "")
      .filter((entry) => entry.length > 0),
  );
}

function extractFocusedArticleSeedUrlsFromPreview(
  source: ResearchSourceRecord,
  brief: ResearchBrief,
): string[] {
  if (source.pageRole !== "front_page") {
    return [];
  }

  const focusTerms = buildResearchFocusTerms(brief);
  if (focusTerms.length === 0) {
    return [];
  }

  return extractExplicitUrlsFromText(source.contentPreview)
    .filter((url) => isLikelyArticleUrl(url))
    .filter((url) => {
      const domain = parseUrlDomain(url);
      if (!domain || isLikelyNewsMetaPage(url)) {
        return false;
      }
      if (source.domain && domain !== source.domain && !domain.endsWith(`.${source.domain}`) && !source.domain.endsWith(`.${domain}`)) {
        return false;
      }
      const loweredUrl = url.toLowerCase();
      return focusTerms.some((term) => loweredUrl.includes(term));
    })
    .slice(0, 4);
}

function extractOneHopNewsUrlsFromSource(
  source: ResearchSourceRecord,
  brief: ResearchBrief,
): string[] {
  if (brief.taskType !== "news-sweep") {
    return [];
  }
  if (
    source.pageRole !== "front_page"
    && source.sourceFamily !== "mainstream_article"
    && source.sourceFamily !== "wire"
    && source.sourceFamily !== "local_news"
    && source.sourceFamily !== "blogs_analysis"
  ) {
    return [];
  }

  const focusTerms = buildResearchFocusTerms(brief);
  const extractedUrls = extractExplicitUrlsFromText(source.contentPreview);
  if (extractedUrls.length === 0) {
    return [];
  }

  return dedupeStrings(extractedUrls)
    .filter((url) => url !== source.resolvedUrl && url !== source.requestedUrl)
    .filter((url) => isLikelyArticleUrl(url))
    .filter((url) => {
      const domain = parseUrlDomain(url);
      if (!domain || isLikelyNewsMetaPage(url)) {
        return false;
      }
      if (
        source.domain
        && domain !== source.domain
        && !domain.endsWith(`.${source.domain}`)
        && !source.domain.endsWith(`.${domain}`)
      ) {
        return false;
      }
      if (focusTerms.length === 0) {
        return true;
      }
      const loweredUrl = url.toLowerCase();
      return focusTerms.some((term) => loweredUrl.includes(term));
    })
    .slice(0, 5);
}

function isLikelyResearchDetailUrl(url: string, source: ResearchSourceRecord, brief: ResearchBrief): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    if (parsed.hash) {
      parsed.hash = "";
    }
    if (parsed.pathname === "/" || isLikelyNewsMetaPage(url)) {
      return false;
    }
    if (/^\/(?:about|careers?|contact|privacy|terms|team|people|press|legal)\/?$/i.test(parsed.pathname)) {
      return false;
    }
    if (/\.(?:avif|gif|ico|jpe?g|mp4|png|svg|webm|webp)(?:$|\?)/i.test(parsed.pathname)) {
      return false;
    }
    const domain = parseUrlDomain(url);
    if (!domain || !source.domain) {
      return false;
    }
    if (
      domain !== source.domain
      && !domain.endsWith(`.${source.domain}`)
      && !source.domain.endsWith(`.${domain}`)
    ) {
      return false;
    }
    const focusTerms = buildResearchFocusTerms(brief);
    const compactSubject = (brief.subject ?? brief.focusQuery)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const loweredUrl = url.toLowerCase();
    const compactUrl = loweredUrl.replace(/[^a-z0-9]+/g, "");
    const detailPathHint = /\b(?:blog|docs?|model|models|card|cards|library|tags?|release|releases|announcement|announcements|guide|guides|reference|research|paper|papers|download|downloads|catalog|api)\b/i
      .test(parsed.pathname);
    return (
      (compactSubject.length >= 4 && compactUrl.includes(compactSubject))
      || focusTerms.some((term) => term.length >= 4 && loweredUrl.includes(term))
      || (detailPathHint && sourceMatchesKeywords(source, focusTerms))
    );
  } catch {
    return false;
  }
}

function extractOneHopResearchUrlsFromSource(
  source: ResearchSourceRecord,
  brief: ResearchBrief,
): string[] {
  if ((source.sourceDepth ?? 0) >= 1 || !isUsableResearchSource(source)) {
    return [];
  }
  if (brief.taskType === "news-sweep") {
    return extractOneHopNewsUrlsFromSource(source, brief);
  }

  const extractedUrls = extractExplicitUrlsFromText(source.contentPreview);
  if (extractedUrls.length === 0) {
    return [];
  }

  return dedupeStrings(extractedUrls)
    .filter((url) => url !== source.resolvedUrl && url !== source.requestedUrl)
    .filter((url) => isLikelyResearchDetailUrl(url, source, brief))
    .slice(0, 5);
}

function buildDepthScoutPrompt(
  brief: ResearchBrief,
  passNumber: number,
  candidates: DepthScoutCandidate[],
): string {
  return [
    "You are the source-depth scout for a deep research run.",
    "The first pass already fetched search results, seeds, or hub/front pages. Your job is to select the second-level pages that should be fetched next.",
    "Pick pages likely to contain primary facts, model cards, article bodies, release notes, docs, tags, product details, or other concrete data. Avoid generic home pages, unrelated pages, image assets, navigation-only pages, and duplicates.",
    "Use only the candidate URLs provided. Do not invent URLs.",
    `Current date: ${formatResearchCurrentDate()}.`,
    `Task type: ${brief.taskType}.`,
    `Focus query: ${brief.focusQuery}.`,
    brief.subject ? `Subject: ${brief.subject}.` : "",
    `Gather pass: ${passNumber}.`,
    [
      "Candidate second-level pages:",
      ...candidates.map((candidate) =>
        [
          `ID: ${candidate.id}`,
          `URL: ${candidate.url}`,
          `Parent: ${candidate.parentSourceId} ${candidate.parentTitle ?? candidate.parentResolvedUrl}`,
          `Family: ${SOURCE_FAMILY_LABELS[candidate.sourceFamily]}`,
          `Reason: ${candidate.reason}`,
        ].join("\n"),
      ),
    ].join("\n\n"),
    "Use this exact shape:",
    "{\"selectedUrls\":[\"https://example.com/detail\"],\"rationale\":\"...\",\"openQuestions\":[\"...\"],\"confidence\":0.0}",
    "Allowed keys are only: selectedUrls, rationale, openQuestions, confidence.",
    "Return only a JSON object that matches the requested schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizeDepthScoutRecord(
  raw: Record<string, unknown>,
  candidates: DepthScoutCandidate[],
): DepthScoutRecord | undefined {
  const candidateUrls = new Set(candidates.map((candidate) => candidate.url));
  const selectedUrls = normalizeStringArray(raw.selectedUrls)
    .map((url) => normalizeSourceLookupUrl(url) ?? url)
    .filter((url) => candidateUrls.has(url));
  const rationale = toNonEmptyString(raw.rationale);
  if (selectedUrls.length === 0 || !rationale) {
    return undefined;
  }
  return {
    selectedUrls: dedupeStrings(selectedUrls),
    rationale: normalizeInlineText(rationale),
    openQuestions: normalizeStringArray(raw.openQuestions),
    confidence: clampConfidence(raw.confidence),
  };
}

function recoverDepthScoutRecord(
  result: ToolSubsessionResult,
  candidates: DepthScoutCandidate[],
): DepthScoutRecord | undefined {
  const rawSelection = extractStructuredObjectCandidate(result);
  if (rawSelection) {
    const normalized = normalizeDepthScoutRecord(rawSelection, candidates);
    if (normalized) {
      return normalized;
    }
  }

  const selectedUrlsMatch = /"selectedUrls"\s*:\s*\[([\s\S]*?)\]/i.exec(result.outputText);
  if (!selectedUrlsMatch?.[1]) {
    return undefined;
  }
  const selectedUrls = [...selectedUrlsMatch[1].matchAll(/"([^"]+)"/g)]
    .map((match) => normalizeSourceLookupUrl(match[1] ?? "") ?? (match[1] ?? ""))
    .filter(Boolean);
  if (selectedUrls.length === 0) {
    return undefined;
  }
  return normalizeDepthScoutRecord(
    {
      selectedUrls,
      rationale: "Recovered candidate URL selection from malformed source-depth scout output.",
      openQuestions: ["The source-depth scout returned malformed structured output, so only its candidate URL list was recovered."],
      confidence: 0.55,
    },
    candidates,
  );
}

function inferTaskType(requestText: string, plan: ResearchPlan): ResearchTaskType {
  const haystack = `${requestText} ${plan.objective} ${plan.scopeSummary ?? ""} ${plan.topics.map((topic) => `${topic.title} ${topic.goal}`).join(" ")}`;
  if (/\b(?:news|headlines|front page|front-page|latest stories?|latest articles?|breaking news|mainstream outlets?|what['’]s on the front page)\b/i.test(haystack)) {
    return "news-sweep";
  }
  if (isModelCatalogResearchRequest(haystack)) {
    return "catalog-status";
  }
  if (/\b(?:compare|comparison|versus|vs\.?)\b/i.test(haystack)) {
    return "comparison";
  }
  return "validation-explainer";
}

function buildResearchBrief(requestText: string, plan: ResearchPlan): ResearchBrief {
  const taskType = inferTaskType(requestText, plan);
  const requestedSurfaces = new Set(detectRequestedSurfaces(requestText));
  const requestedCommunity = requestedSurfaces.has("community");
  const requestedOfficial =
    requestedSurfaces.has("official")
    || /\b(?:nasa|official|first[- ]party|support|developer|docs?|documentation|gov(?:\.|ernment)|newsroom)\b/i
      .test(requestText);
  const subject = inferResearchSubject(requestText);
  const focusQuery = taskType === "news-sweep" && subject
    ? subject
    : inferResearchFocusQuery(requestText);
  const reportRequirements = dedupeStrings([
    /\b(?:latest|today|current|front page|front-page|recent|concrete dates?)\b/i.test(requestText)
      ? "Include concrete dates whenever the sources provide them."
      : "",
    /\b(?:compare|versus|vs\.?)\b/i.test(requestText)
      ? "Call out the most important differences and tradeoffs explicitly."
      : "",
    taskType === "news-sweep"
      ? "Summarize both consensus across outlets and meaningful disagreements."
      : "",
    requestedCommunity
      ? "Include community or owner reactions when they materially add context."
      : "",
  ]);

  switch (taskType) {
    case "news-sweep":
      return {
        objective: plan.objective,
        scopeSummary: plan.scopeSummary ?? "Gather current news coverage with enough breadth to compare outlets.",
        taskType,
        focusQuery,
        subject,
        requiredSourceFamilies: dedupeSourceFamilies([
          "mainstream_front_page",
          "mainstream_article",
          "wire",
          "local_news",
          "blogs_analysis",
          requestedCommunity ? "community" : undefined,
          requestedOfficial ? "official" : undefined,
        ].filter((value): value is ResearchSourceFamily => Boolean(value))),
        optionalSourceFamilies: dedupeSourceFamilies([
          requestedOfficial ? "official" : undefined,
        ].filter((value): value is ResearchSourceFamily => Boolean(value))),
        reportRequirements,
      };
    case "catalog-status":
      return {
        objective: plan.objective,
        scopeSummary: plan.scopeSummary ?? "Map official and packaging surfaces clearly.",
        taskType,
        focusQuery,
        subject,
        requiredSourceFamilies: dedupeSourceFamilies([
          "official",
          "reference_github_docs",
        ]),
        optionalSourceFamilies: dedupeSourceFamilies([
          requestedCommunity ? "community" : undefined,
        ].filter((value): value is ResearchSourceFamily => Boolean(value))),
        reportRequirements,
      };
    case "comparison":
      return {
        objective: plan.objective,
        scopeSummary: plan.scopeSummary ?? "Gather enough direct evidence to compare the requested options fairly.",
        taskType,
        focusQuery,
        subject,
        requiredSourceFamilies: dedupeSourceFamilies([
          requestedOfficial ? "official" : "reference_github_docs",
          "reference_github_docs",
        ]),
        optionalSourceFamilies: dedupeSourceFamilies([
          requestedCommunity ? "community" : undefined,
          requestedOfficial ? "official" : undefined,
        ].filter((value): value is ResearchSourceFamily => Boolean(value))),
        reportRequirements,
      };
    case "validation-explainer":
    default:
      return {
        objective: plan.objective,
        scopeSummary: plan.scopeSummary ?? "Gather grounded evidence and preserve open questions.",
        taskType: "validation-explainer",
        focusQuery,
        subject,
        requiredSourceFamilies: dedupeSourceFamilies([
          requestedOfficial ? "official" : "reference_github_docs",
        ]),
        optionalSourceFamilies: dedupeSourceFamilies([
          requestedOfficial ? "reference_github_docs" : "official",
          requestedCommunity ? "community" : undefined,
          requestedSurfaces.has("news") ? "mainstream_article" : undefined,
        ].filter((value): value is ResearchSourceFamily => Boolean(value))),
        reportRequirements,
      };
  }
}

function inferSourceFamilyForTopic(
  brief: ResearchBrief,
  topic: ResearchTopicPlan,
): ResearchSourceFamily {
  const haystack = [topic.title, topic.goal, ...topic.searchQueries].join(" ");
  if (brief.taskType === "news-sweep") {
    if (/\bfront page|headlines\b/i.test(haystack)) {
      return "mainstream_front_page";
    }
    if (topicRequestsCommunityCoverage(topic)) {
      return "community";
    }
    if (topicRequestsOfficialCoverage(topic)) {
      return "official";
    }
    if (/\b(?:reuters|ap\b|ap news|wire)\b/i.test(haystack)) {
      return "wire";
    }
    return "mainstream_article";
  }

  if (topicRequestsCommunityCoverage(topic)) {
    return "community";
  }
  if (topicRequestsOfficialCoverage(topic)) {
    return "official";
  }
  if (topicRequestsReferenceCoverage(topic)) {
    return "reference_github_docs";
  }
  if (topicRequestsReviewCoverage(topic) || /\b(?:news|coverage|reporting)\b/i.test(haystack)) {
    return "mainstream_article";
  }
  return "reference_github_docs";
}

function buildNewsSeedUrls(
  sourceFamily: ResearchSourceFamily,
  brief: ResearchBrief,
): string[] {
  const focus = encodeURIComponent(brief.subject ?? brief.focusQuery);
  switch (sourceFamily) {
    case "mainstream_front_page":
      return MAINSTREAM_NEWS_OUTLETS.map((outlet) => outlet.homeUrl);
    case "mainstream_article":
      return [];
    case "wire":
      return WIRE_NEWS_OUTLETS.map((outlet) => outlet.homeUrl);
    case "local_news":
    case "blogs_analysis":
      return [];
    case "official": {
      const haystack = `${brief.subject ?? ""} ${brief.focusQuery} ${brief.objective} ${brief.scopeSummary}`.toLowerCase();
      if (/\b(?:artemis|nasa)\b/.test(haystack)) {
        return [
          "https://www.nasa.gov/news/",
          "https://www.nasa.gov/mission/artemis/",
          "https://www.nasa.gov/mission/artemis-ii/",
        ];
      }
      return [];
    }
    case "community":
      return [
        `https://hn.algolia.com/api/v1/search?tags=story&query=${focus}`,
        `https://www.reddit.com/search/?q=${focus}`,
      ];
    case "reference_github_docs":
      return [];
  }
}

function buildNewsQueries(
  brief: ResearchBrief,
  sourceFamily: ResearchSourceFamily,
): string[] {
  const focus = brief.subject ?? brief.focusQuery;
  const broadOutletSweep =
    brief.requiredSourceFamilies.includes("mainstream_front_page")
    || brief.optionalSourceFamilies.includes("mainstream_front_page");
  const articleOutlets = broadOutletSweep
    ? MAINSTREAM_NEWS_OUTLETS
      .filter((outlet) => !WIRE_NEWS_OUTLETS.some((wire) => wire.domain === outlet.domain))
      .slice(0, 4)
    : [];
  switch (sourceFamily) {
    case "mainstream_front_page":
      return [
        `${focus} top headlines`,
        `${focus} front page coverage`,
      ];
    case "wire":
      return [
        `${focus} Reuters latest`,
        `${focus} AP latest`,
      ];
    case "local_news":
      return [
        `${focus} local news`,
        `${focus} regional media`,
        `${focus} independent news`,
        `${focus} city updates`,
      ];
    case "blogs_analysis":
      return [
        `${focus} live blog`,
        `${focus} analysis blog`,
        `${focus} situation report`,
        `${focus} expert analysis`,
      ];
    case "community":
      return [
        `${focus} reddit`,
        `${focus} hacker news`,
      ];
    case "official":
      return [
        `${focus} official update`,
        `${focus} official statement`,
      ];
    case "mainstream_article":
      return dedupeStrings([
        `${focus} latest story`,
        `${focus} latest live updates`,
        `${focus} latest article coverage`,
        ...articleOutlets.map((outlet) => `${outlet.label} ${focus}`),
      ]);
    case "reference_github_docs":
      return [];
  }
}

function buildCoverageGroupsForNews(
  plan: ResearchPlan,
  brief: ResearchBrief,
  profile: ResearchProfile,
): CoverageQueryGroup[] {
  const deep = profile === "deep";
  const groups: CoverageQueryGroup[] = [];
  const pushGroup = (
    title: string,
    goal: string,
    sourceFamily: ResearchSourceFamily,
    required: boolean,
    priority: number,
    targetSources: number,
  ): void => {
    const topicId = `${slugify(title)}-${priority}`;
    groups.push({
      id: topicId,
      topicId,
      title,
      goal,
      priority,
      sourceFamily,
      required,
      searchQueries: buildNewsQueries(brief, sourceFamily),
      seedUrls: buildNewsSeedUrls(sourceFamily, brief),
      targetSources,
    });
  };

  let nextPriority = 1;
  if (
    brief.requiredSourceFamilies.includes("mainstream_front_page")
    || brief.optionalSourceFamilies.includes("mainstream_front_page")
  ) {
    pushGroup(
      "Mainstream front pages",
      `Capture what major outlets are placing prominently on their front pages about ${brief.focusQuery}.`,
      "mainstream_front_page",
      brief.requiredSourceFamilies.includes("mainstream_front_page"),
      nextPriority,
      deep ? DEFAULT_DEEP_NEWS_FRONT_PAGE_TARGET : 2,
    );
    nextPriority += 1;
  }
  pushGroup(
    "Mainstream article coverage",
    `Read recent mainstream reporting on ${brief.focusQuery} across multiple outlets.`,
    "mainstream_article",
    true,
    nextPriority,
    deep ? DEFAULT_DEEP_NEWS_ARTICLE_TARGET : 3,
  );
  nextPriority += 1;

  if (brief.requiredSourceFamilies.includes("wire") || brief.optionalSourceFamilies.includes("wire")) {
    pushGroup(
      "Wire coverage",
      `Add wire-service coverage that sharpens recency or factual grounding for ${brief.focusQuery}.`,
      "wire",
      brief.requiredSourceFamilies.includes("wire"),
      nextPriority,
      deep ? 2 : 1,
    );
    nextPriority += 1;
  }
  if (brief.requiredSourceFamilies.includes("local_news") || brief.optionalSourceFamilies.includes("local_news")) {
    pushGroup(
      "Local and specialized sources",
      `Find local, regional, or subject-specialized sources that may have details major outlets miss for ${brief.focusQuery}.`,
      "local_news",
      brief.requiredSourceFamilies.includes("local_news"),
      nextPriority,
      deep ? 4 : 2,
    );
    nextPriority += 1;
  }
  if (brief.requiredSourceFamilies.includes("blogs_analysis") || brief.optionalSourceFamilies.includes("blogs_analysis")) {
    pushGroup(
      "Blogs and active analysis",
      `Find active blogs, trackers, or analysis pages that add depth or chronology for ${brief.focusQuery}.`,
      "blogs_analysis",
      brief.requiredSourceFamilies.includes("blogs_analysis"),
      nextPriority,
      deep ? 4 : 2,
    );
    nextPriority += 1;
  }
  if (brief.requiredSourceFamilies.includes("official") || brief.optionalSourceFamilies.includes("official")) {
    pushGroup(
      "Official statements",
      `Check for official statements or first-party updates relevant to ${brief.focusQuery}.`,
      "official",
      brief.requiredSourceFamilies.includes("official"),
      nextPriority,
      2,
    );
    nextPriority += 1;
  }
  if (brief.requiredSourceFamilies.includes("community") || brief.optionalSourceFamilies.includes("community")) {
    pushGroup(
      "Community reaction",
      `Capture meaningful community reaction or owner discussion relevant to ${brief.focusQuery}.`,
      "community",
      brief.requiredSourceFamilies.includes("community"),
      nextPriority,
      deep ? 2 : 1,
    );
  }

  return groups.slice(0, profile === "quick" ? 5 : 8);
}

function buildCoveragePlan(
  requestText: string,
  plan: ResearchPlan,
  brief: ResearchBrief,
  profile: ResearchProfile,
): { effectivePlan: ResearchPlan; coveragePlan: CoveragePlan } {
  const deep = profile === "deep";
  const maxPasses = deep ? DEFAULT_DEEP_MAX_PASSES : DEFAULT_QUICK_MAX_PASSES;
  let queryGroups: CoverageQueryGroup[];

  if (brief.taskType === "news-sweep") {
    queryGroups = buildCoverageGroupsForNews(plan, brief, profile);
  } else {
    queryGroups = plan.topics.map((topic) => {
      const sourceFamily = inferSourceFamilyForTopic(brief, topic);
      return {
        id: topic.id,
        topicId: topic.id,
        title: topic.title,
        goal: topic.goal,
        priority: topic.priority,
        sourceFamily,
        required: brief.requiredSourceFamilies.includes(sourceFamily),
        searchQueries: topic.searchQueries,
        seedUrls: buildFallbackSeedUrls(plan, topic, sourceFamily),
        targetSources:
          sourceFamily === "official" || sourceFamily === "reference_github_docs"
            ? (deep ? 4 : 2)
            : (deep ? 3 : 2),
      } satisfies CoverageQueryGroup;
    });
  }

  const effectivePlan: ResearchPlan = {
    ...plan,
    topics: queryGroups.map((group) => ({
      id: group.topicId,
      title: group.title,
      goal: group.goal,
      priority: group.priority,
      searchQueries: group.searchQueries,
    })),
    stopConditions:
      plan.stopConditions.length > 0
        ? plan.stopConditions
        : [
          `Stop after ${maxPasses} passes or once the evidence covers the required source families with enough domain diversity.`,
        ],
  };

  const queryGroupTargetSources = queryGroups.reduce((sum, group) => sum + group.targetSources, 0);
  const targetSources = Math.max(
    queryGroupTargetSources,
    deep ? DEFAULT_DEEP_TARGET_SOURCES : DEFAULT_QUICK_TARGET_SOURCES,
  );
  const targetDomains = deep ? DEFAULT_DEEP_TARGET_DOMAINS : DEFAULT_QUICK_TARGET_DOMAINS;

  return {
    effectivePlan,
    coveragePlan: {
      taskType: brief.taskType,
      targetSources,
      targetDomains,
      maxPasses,
      requiredSourceFamilies: brief.requiredSourceFamilies,
      optionalSourceFamilies: brief.optionalSourceFamilies,
      queryGroups,
      stopConditions: effectivePlan.stopConditions,
    },
  };
}

function classifySourceFamily(
  url: string,
  fallbackFamily?: ResearchSourceFamily,
  hints?: { title?: string; description?: string },
): ResearchSourceFamily {
  const domain = parseUrlDomain(url) ?? "";
  if (isLikelyNewsMetaPage(url, hints?.title, hints?.description)) {
    return "reference_github_docs";
  }
  if (COMMUNITY_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) {
    return "community";
  }
  if (WIRE_NEWS_OUTLETS.some((candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`))) {
    return "wire";
  }
  if (OFFICIAL_SOURCE_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) {
    return "official";
  }
  if (REFERENCE_DOC_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) {
    return "reference_github_docs";
  }
  if (/\.gov$/i.test(domain)) {
    return "official";
  }
  if (MAINSTREAM_NEWS_OUTLETS.some((candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`))) {
    return isLikelyFrontPageUrl(url) ? "mainstream_front_page" : "mainstream_article";
  }
  if (fallbackFamily === "wire") {
    return "reference_github_docs";
  }
  if (fallbackFamily === "mainstream_front_page" || fallbackFamily === "mainstream_article") {
    return isLikelyFrontPageUrl(url) ? "mainstream_front_page" : "mainstream_article";
  }
  if (fallbackFamily === "local_news" || fallbackFamily === "blogs_analysis") {
    return fallbackFamily;
  }
  if (fallbackFamily === "official" || fallbackFamily === "community") {
    return fallbackFamily;
  }
  if (isKnownMainstreamNewsDomain(domain)) {
    return isLikelyFrontPageUrl(url) ? "mainstream_front_page" : "mainstream_article";
  }
  return isLikelyFrontPageUrl(url) ? "mainstream_front_page" : "reference_github_docs";
}

function classifyPageRole(
  url: string,
  sourceFamily: ResearchSourceFamily,
): "front_page" | "article" | "reference" | "community" | "other" {
  if (sourceFamily === "community") {
    return "community";
  }
  if (sourceFamily === "reference_github_docs" || sourceFamily === "official") {
    return "reference";
  }
  if (sourceFamily === "mainstream_front_page" || isLikelyFrontPageUrl(url)) {
    return "front_page";
  }
  if (
    sourceFamily === "mainstream_article"
    || sourceFamily === "wire"
    || sourceFamily === "local_news"
    || sourceFamily === "blogs_analysis"
  ) {
    return "article";
  }
  if (isLikelyArticleUrl(url)) {
    return "article";
  }
  return "other";
}

function buildCoverageSnapshot(
  coveragePlan: CoveragePlan,
  sources: ResearchSourceRecord[],
): ResearchCoverageSnapshot {
  const usableSources = sources.filter((source) => isUsableResearchSource(source));
  const counts = new Map<ResearchSourceFamily, number>();
  const domains = new Set<string>();
  const domainCounts = new Map<string, number>();
  for (const source of usableSources) {
    if (source.domain) {
      domains.add(source.domain);
      domainCounts.set(source.domain, (domainCounts.get(source.domain) ?? 0) + 1);
    }
    if (source.sourceFamily) {
      counts.set(source.sourceFamily, (counts.get(source.sourceFamily) ?? 0) + 1);
    }
  }

  const families = dedupeSourceFamilies([
    ...coveragePlan.requiredSourceFamilies,
    ...coveragePlan.optionalSourceFamilies,
    ...coveragePlan.queryGroups.map((group) => group.sourceFamily),
  ]).map((family) => {
    const sourceCount = counts.get(family) ?? 0;
    return {
      id: family,
      label: SOURCE_FAMILY_LABELS[family],
      required: coveragePlan.requiredSourceFamilies.includes(family),
      sourceCount,
      covered: sourceCount > 0,
    };
  });

  const topDomains = [...domainCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([domain, count]) => ({ domain, count }));

  return {
    targetSources: coveragePlan.targetSources,
    sourcesGathered: usableSources.length,
    targetDomains: coveragePlan.targetDomains,
    distinctDomains: domains.size,
    families,
    topDomains,
  };
}

function buildCoverageAssessment(
  brief: ResearchBrief,
  coveragePlan: CoveragePlan,
  sources: ResearchSourceRecord[],
  _passNumber: number,
): CoverageAssessment {
  const snapshot = buildCoverageSnapshot(coveragePlan, sources);
  const gaps: string[] = [];
  const missingSourceFamilies = snapshot.families
    .filter((family) => family.required && !family.covered)
    .map((family) => family.id);
  const missingTopicIds: string[] = [];
  const followUpQueriesByTopic = new Map<string, string[]>();
  const followUpSeedUrlsByTopic = new Map<string, string[]>();
  const sourcesByTopicId = new Map<string, ResearchSourceRecord[]>();

  for (const source of sources) {
    for (const topicId of source.topicIds) {
      sourcesByTopicId.set(topicId, [...(sourcesByTopicId.get(topicId) ?? []), source]);
    }
  }

  for (const family of missingSourceFamilies) {
    gaps.push(`Missing required source family: ${SOURCE_FAMILY_LABELS[family]}.`);
  }

  const briefHaystack = `${brief.focusQuery}\n${brief.objective}\n${brief.scopeSummary}`;
  const catalogRequest = isCatalogStyleRequest(briefHaystack);
  const catalogDomainHints = catalogRequest
    ? extractCatalogDomainHints(briefHaystack).filter((hint) => !/^(?:www\.|https?:\/\/)/i.test(hint))
    : [];

  for (const group of coveragePlan.queryGroups) {
    const sourcesForTopic = sourcesByTopicId.get(group.topicId) ?? [];
    if (group.required && sourcesForTopic.length < Math.max(1, Math.min(group.targetSources, coveragePlan.targetSources))) {
      missingTopicIds.push(group.topicId);
      gaps.push(`${group.title} is still thin at ${sourcesForTopic.length}/${group.targetSources} sources.`);
      followUpQueriesByTopic.set(group.topicId, group.searchQueries.slice(0, 2));
      followUpSeedUrlsByTopic.set(group.topicId, group.seedUrls.slice(0, 4));
    }
    const usableForTopic = sourcesForTopic.filter((source) => !source.lowQualityContent && !source.offTopic);
    const lowQualityForTopic = sourcesForTopic.filter((source) => source.lowQualityContent).length;
    const offTopicForTopic = sourcesForTopic.filter((source) => source.offTopic).length;
    if (sourcesForTopic.length >= 3 && usableForTopic.length === 0) {
      if (!missingTopicIds.includes(group.topicId)) {
        missingTopicIds.push(group.topicId);
      }
      gaps.push(`${group.title} has no usable source after filtering ${lowQualityForTopic} low-quality and ${offTopicForTopic} off-topic hits.`);
      const extraQueries: string[] = [];
      if (catalogRequest) {
        for (const hint of catalogDomainHints) {
          extraQueries.push(`site:${hint} ${brief.subject ?? brief.focusQuery}`);
        }
      }
      for (const existingQuery of group.searchQueries.slice(0, 2)) {
        if (brief.subject && !existingQuery.toLowerCase().includes(brief.subject.toLowerCase())) {
          extraQueries.push(`${existingQuery} ${brief.subject}`);
        } else {
          extraQueries.push(existingQuery);
        }
      }
      followUpQueriesByTopic.set(
        group.topicId,
        dedupeStrings([...(followUpQueriesByTopic.get(group.topicId) ?? []), ...extraQueries]).slice(0, 4),
      );
    }
  }

  const totalSources = sources.length;
  const lowQualityTotal = sources.filter((source) => source.lowQualityContent).length;
  const offTopicTotal = sources.filter((source) => source.offTopic).length;
  if (totalSources >= 4 && lowQualityTotal / totalSources >= 0.5) {
    gaps.push(`Half or more of fetched sources returned low-quality content (${lowQualityTotal}/${totalSources}); fallback queries scheduled.`);
  }
  if (totalSources >= 4 && offTopicTotal / totalSources >= 0.4) {
    gaps.push(`Too many off-topic sources landed in the pool (${offTopicTotal}/${totalSources}); refining queries with the subject term.`);
  }

  if (catalogRequest) {
    const officialHubSources = sources.filter(
      (source) =>
        source.sourceFamily === "official"
        && source.pageRole === "reference"
        && !source.lowQualityContent
        && typeof source.domain === "string"
        && source.domain.length > 0,
    );
    if (officialHubSources.length > 0) {
      const oneHopSourcesByDomain = new Map<string, ResearchSourceRecord[]>();
      for (const source of sources) {
        if (!source.domain) continue;
        if ((source.sourceDepth ?? 0) >= 1 || source.parentSourceId) {
          oneHopSourcesByDomain.set(source.domain, [...(oneHopSourcesByDomain.get(source.domain) ?? []), source]);
        }
      }
      const hubDomains = dedupeStrings(
        officialHubSources.map((source) => source.domain!).filter(Boolean),
      );
      const underExploredHosts = hubDomains.filter(
        (domain) => (oneHopSourcesByDomain.get(domain)?.length ?? 0) === 0,
      );
      if (underExploredHosts.length > 0) {
        gaps.push(
          `Official hub page(s) fetched on ${underExploredHosts.join(", ")} but subpages not yet enumerated; scheduling follow-up queries.`,
        );
        const primaryGroup = coveragePlan.queryGroups.find((group) => group.required) ?? coveragePlan.queryGroups[0];
        if (primaryGroup) {
          const subject = brief.subject ?? brief.focusQuery;
          const hubQueries = underExploredHosts.flatMap((host) => [
            `site:${host} ${subject}`,
            `site:${host}/blog ${subject}`,
            `site:${host} model card`,
          ]);
          const hubSeeds = underExploredHosts.flatMap((host) => [
            `https://${host}/blog/`,
            `https://${host}/models/`,
            `https://${host}/research/`,
          ]);
          followUpQueriesByTopic.set(
            primaryGroup.topicId,
            dedupeStrings([...(followUpQueriesByTopic.get(primaryGroup.topicId) ?? []), ...hubQueries]).slice(0, 6),
          );
          followUpSeedUrlsByTopic.set(
            primaryGroup.topicId,
            dedupeStrings([...(followUpSeedUrlsByTopic.get(primaryGroup.topicId) ?? []), ...hubSeeds]).slice(0, 8),
          );
        }
      }
    }
  }

  if (brief.taskType === "news-sweep") {
    const frontPageCount = sources.filter((source) => source.sourceFamily === "mainstream_front_page").length;
    const articleCount = sources.filter((source) => source.sourceFamily === "mainstream_article").length;
    const articleGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "mainstream_article");
    const frontPageGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "mainstream_front_page");
    const frontPageSources = sources.filter((source) => source.pageRole === "front_page");
    if (frontPageGroup && frontPageCount < frontPageGroup.targetSources) {
      gaps.push(`Need more front-page sampling (${frontPageCount}/${frontPageGroup.targetSources}).`);
    }
    if (articleGroup && articleCount < articleGroup.targetSources) {
      gaps.push(`Need more mainstream article coverage (${articleCount}/${articleGroup.targetSources}).`);
      if (articleGroup) {
        const followUpArticleSeeds = dedupeStrings(
          frontPageSources.flatMap((source) => extractFocusedArticleSeedUrlsFromPreview(source, brief)),
        );
        if (followUpArticleSeeds.length > 0) {
          followUpSeedUrlsByTopic.set(
            articleGroup.topicId,
            dedupeStrings([
              ...(followUpSeedUrlsByTopic.get(articleGroup.topicId) ?? []),
              ...followUpArticleSeeds,
            ]),
          );
        }
      }
    }
    const mainstreamDomains = new Set(
      sources
        .filter((source) =>
          source.sourceFamily === "mainstream_front_page"
          || source.sourceFamily === "mainstream_article"
          || source.sourceFamily === "wire"
          || source.sourceFamily === "local_news"
          || source.sourceFamily === "blogs_analysis"
        )
        .map((source) => source.domain)
        .filter((value): value is string => Boolean(value)),
    );
    if (mainstreamDomains.size < DEFAULT_DEEP_NEWS_MIN_ARTICLE_OUTLETS) {
      gaps.push(`Need more outlet diversity (${mainstreamDomains.size}/${DEFAULT_DEEP_NEWS_MIN_ARTICLE_OUTLETS}).`);
      const unusedOutlets = MAINSTREAM_NEWS_OUTLETS
        .filter((outlet) => !mainstreamDomains.has(outlet.domain))
        .slice(0, 3);
      if (articleGroup) {
        followUpQueriesByTopic.set(
          articleGroup.topicId,
          dedupeStrings([
            ...(followUpQueriesByTopic.get(articleGroup.topicId) ?? []),
            ...unusedOutlets.map((outlet) => `${outlet.label} ${brief.subject ?? brief.focusQuery}`),
          ]),
        );
      }
      if (frontPageGroup) {
        followUpSeedUrlsByTopic.set(
          frontPageGroup.topicId,
          dedupeStrings([
            ...(followUpSeedUrlsByTopic.get(frontPageGroup.topicId) ?? []),
            ...unusedOutlets.map((outlet) => outlet.homeUrl),
          ]),
        );
      }
    }
  }

  const minimumSourceFloor = Math.max(
    coveragePlan.requiredSourceFamilies.length * 2,
    Math.max(4, coveragePlan.targetSources - (coveragePlan.maxPasses > 2 ? 4 : 2)),
  );
  if (snapshot.sourcesGathered < minimumSourceFloor) {
    gaps.push(`Need more total sources (${snapshot.sourcesGathered}/${minimumSourceFloor}).`);
  }

  const targetDomainGap = Math.max(coveragePlan.targetDomains - snapshot.distinctDomains, 0);
  if (targetDomainGap > 0) {
    gaps.push(`Need broader domain diversity (${snapshot.distinctDomains}/${coveragePlan.targetDomains}).`);
  }

  const sufficient = gaps.length === 0;

  return {
    sufficient,
    summary:
      gaps.length === 0
        ? "Coverage looks sufficient for synthesis."
        : `Coverage still has ${gaps.length} gap${gaps.length === 1 ? "" : "s"} to close.`,
    gaps,
    missingSourceFamilies,
    missingTopicIds,
    targetDomainGap,
    followUpQueriesByTopic,
    followUpSeedUrlsByTopic,
  };
}

function mergeCoverageFollowUps(
  coveragePlan: CoveragePlan,
  assessment: CoverageAssessment,
): void {
  for (const group of coveragePlan.queryGroups) {
    const nextQueries = assessment.followUpQueriesByTopic.get(group.topicId);
    if (nextQueries && nextQueries.length > 0) {
      group.searchQueries = dedupeStrings([...group.searchQueries, ...nextQueries]);
    }
    const nextSeedUrls = assessment.followUpSeedUrlsByTopic.get(group.topicId);
    if (nextSeedUrls && nextSeedUrls.length > 0) {
      group.seedUrls = dedupeStrings([...group.seedUrls, ...nextSeedUrls]);
    }
  }
}

function prioritizeSearchCandidate(
  topic: ResearchTopicPlan,
  sourceFamily: ResearchSourceFamily,
  candidate: SearchSnippetSourceCandidate,
  existingSources: ResearchSourceRecord[],
): number {
  let value = 0;
  const domain = parseUrlDomain(candidate.url);
  const knownDomains = new Set(
    existingSources
      .map((source) => source.domain)
      .filter((entry): entry is string => Boolean(entry)),
  );
  const candidateFamily = classifySourceFamily(candidate.url, sourceFamily, {
    title: candidate.title,
    description: candidate.snippet,
  });
  if (candidateFamily === sourceFamily) {
    value += 100;
  }
  if (sourceFamily === "official" && isOfficialSearchCandidate(candidate)) {
    value += 90;
  }
  if (sourceFamily === "community" && isCommunitySearchCandidate(candidate)) {
    value += 90;
  }
  if (sourceFamily === "mainstream_article" && isReviewSearchCandidate(candidate)) {
    value += 30;
  }
  if (isLikelyNewsMetaPage(candidate.url, candidate.title, candidate.snippet)) {
    value -= 160;
  }
  if (sourceFamily === "mainstream_front_page") {
    value += isLikelyFrontPageUrl(candidate.url) ? 70 : -35;
  }
  if (sourceFamily === "mainstream_article") {
    value += isLikelyArticleUrl(candidate.url) ? 90 : -70;
    value += isKnownMainstreamNewsDomain(domain) ? 30 : 0;
    value -= candidateFamily === "mainstream_front_page" ? 60 : 0;
    value -= domain === "news.google.com" ? 80 : 0;
  }
  if (sourceFamily === "wire" && candidateFamily !== "wire") {
    value -= 120;
  }
  if (sourceFamily === "local_news") {
    value += isLikelyArticleUrl(candidate.url) ? 80 : -30;
    value += /\b(?:local|regional|city|independent|post|times|tribune|gazette|daily|dispatch|observer|journal|pravda|inform|press)\b/i
      .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" "))
      ? 50
      : 0;
    value -= isKnownMainstreamNewsDomain(domain) ? 30 : 0;
  }
  if (sourceFamily === "blogs_analysis") {
    value += isLikelyArticleUrl(candidate.url) ? 70 : -20;
    value += /\b(?:blog|live\s+blog|analysis|analyst|tracker|updates?|situation\s+report|report\s+card|briefing|explainer|opinion|column|substack)\b/i
      .test([candidate.url, candidate.siteName ?? "", candidate.title, candidate.snippet].join(" "))
      ? 55
      : 0;
  }
  if (domain && !knownDomains.has(domain)) {
    value += 40;
  } else if (domain) {
    value -= 15;
  }
  if (candidate.title.length > 0 && /\b(?:202[4-9]|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(`${candidate.title} ${candidate.snippet}`)) {
    value += 15;
  }
  if (/wikipedia\.org/i.test(candidate.url)) {
    value -= 20;
  }
  if (topicRequestsCommunityCoverage(topic) && isCommunitySearchCandidate(candidate)) {
    value += 20;
  }
  return value;
}

function topicSortValue(topic: ResearchTopicPlan): number {
  return topic.priority;
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  const size = Math.max(1, Math.floor(chunkSize));
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runnerCount = Math.min(Math.max(concurrency, 1), Math.max(items.length, 1));
  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          break;
        }
        await worker(items[currentIndex]!, currentIndex);
      }
    }),
  );
}

function successfulBatchResult<TResult>(result: BatchTaskResult<TResult>): TResult | undefined {
  if (result.status !== "fulfilled") {
    return undefined;
  }
  return result.result;
}

function buildPlanningPrompt(requestText: string, profile: ResearchProfile, attempt = 1): string {
  const catalogRequest = isCatalogStyleRequest(requestText);
  const catalogDomainHints = catalogRequest
    ? extractCatalogDomainHints(requestText)
    : [];
  const lines = [
    "Plan a research run for this request.",
    "Break the work into distinct, non-overlapping topics.",
    `Return between 1 and ${profile === "quick" ? 2 : 5} topics.`,
    "If the request names multiple platforms or providers, give each major platform its own topic unless the topic limit forces grouping.",
    "If the request asks for versions, model types, sources, packaging, or availability, split those dimensions into separate topics when the topic limit allows.",
    "If the request explicitly asks for official sources, ecosystem or GitHub updates, mainstream coverage or reviews, or community discussion, split those source surfaces into separate topics when the topic limit allows.",
    "Each topic must include a short title, a concrete goal, a numeric priority, and one or more plain searchQueries.",
    "Keep the plan compact and execution-oriented.",
    "The topic title must be only the topic name. Do not include Goal, Priority, Query, quotes, or extra labels inside the title string.",
    "Keep each title under 8 words.",
    "Keep each goal to one short sentence.",
    "Keep each search query to a plain search string, not an explanation.",
    "Do not copy compliance checks or instruction text such as \"1 sentence. - OK\" or \"plain strings. - OK\" into the JSON.",
    catalogRequest
      ? `When the request asks for a catalog, agenda, schedule, or full list, include at least one enumeration query that uses "site:<domain>" against the most likely authoritative host${
          catalogDomainHints.length > 0 ? ` (candidates: ${catalogDomainHints.slice(0, 3).join(", ")})` : ""
        }, plus one query that pairs the subject with a page-type keyword like "sessions", "agenda", "catalog", or "schedule".`
      : "",
    catalogRequest
      ? "When the request names an organization (company, lab, publisher, event host), infer its most likely primary domain and include a plain \"site:<org-domain>\" query paired with the subject (no quoted phrases in the body). Also include targeted hub-page queries like \"site:<org-domain>/models\", \"site:<org-domain>/blog\", \"site:<org-domain>/research\", or \"site:<org-domain>/news\" when those paths are plausible, so individual product / model / post pages get surfaced instead of only top-level hub pages."
      : "",
    "Vary search queries so at least one is a direct keyword search and at least one is a qualified search with quotes, year, or a site: filter when a specific host is implied.",
    "Use this exact shape:",
    "{\"objective\":\"...\",\"scopeSummary\":\"...\",\"topics\":[{\"title\":\"...\",\"goal\":\"...\",\"priority\":1,\"searchQueries\":[\"...\"]}],\"risks\":[],\"stopConditions\":[]}",
    "Return only a JSON object that matches the requested schema.",
    "Do not include markdown, bullet lists, or commentary outside the JSON object.",
    "User request:",
    requestText,
  ].filter((line) => line.length > 0);

  if (attempt > 1) {
    lines.splice(
      5,
      0,
      "The previous attempt did not produce a valid research plan.",
      "Be exact: emit a single valid JSON object with objective, topics, risks, and stopConditions.",
    );
  }

  return lines.join("\n");
}

function buildWorkerPrompt(
  brief: ResearchBrief,
  topic: ResearchTopicPlan,
  discovery: DiscoveryRecord,
  sources: ResearchSourceRecord[],
  attempt = 1,
  options: {
    discardedSourceCount?: number;
  } = {},
): string {
  const topicHaystack = `${topic.title} ${topic.goal}`.toLowerCase();
  const catalogTopic = isCatalogStyleRequest(`${brief.focusQuery} ${brief.objective} ${topic.title} ${topic.goal}`);
  const discardedSourceCount = options.discardedSourceCount ?? 0;
  const evidenceCards = buildResearchEvidenceCards(brief, topic, sources);
  const excludedEvidenceCount = Math.max(0, sources.length - evidenceCards.length) + discardedSourceCount;
  const taskSpecificInstructions = brief.taskType === "news-sweep"
    ? [
        `Current date: ${formatResearchCurrentDate()}.`,
        /front page|headline/.test(topicHaystack)
          ? "Call out which outlet front pages or top headline stacks are giving the subject visible prominence."
          : "",
        /article|coverage/.test(topicHaystack)
          ? "Name the latest specific stories, mention which outlet published which framing, and include concrete dates whenever the evidence provides them."
          : "",
        "If a source says today, yesterday, or a relative time like 6 hours ago, resolve it into an absolute date when the current date makes that possible.",
      ]
    : [];
  const catalogInstructions = catalogTopic
    ? [
        "This is a catalog / enumeration task: list every distinct item the evidence supports. Prefer completeness over narrative polish.",
        "Official hub / reference pages (e.g. an org's /models, /products, or /blog index) are valid evidence that a named item exists even when the page carries no explicit release date. Cite the hub page and say the date is unspecified; do not drop the item just because a date is missing.",
        "When a hub page names an item you have not seen covered elsewhere, call it out as an open question so the next pass can fetch its dedicated page.",
      ]
    : [];
  const discoverySections = [
    `Topic title: ${topic.title}`,
    `Topic goal: ${topic.goal}`,
    discovery.searches.length > 0
      ? [
          "Discovery searches:",
          ...discovery.searches.map((search) =>
            [
              `Query: ${search.query}`,
              ...search.result.structuredOutput.results.slice(0, 3).map((result, index) =>
                `${index + 1}. ${result.title}\n${result.url}\nSnippet: ${result.snippet}`,
              ),
            ].join("\n"),
          ),
        ].join("\n\n")
      : "Discovery searches: none",
    discovery.searchErrors.length > 0
      ? [
          "Discovery search errors:",
          ...discovery.searchErrors.map((entry) => `${entry.query}: ${entry.error}`),
        ].join("\n")
      : "",
    discovery.fetchErrors.length > 0
      ? [
          "Known fetch failures from discovery:",
          ...discovery.fetchErrors.map((entry) => `${entry.url}\nError: ${entry.error}`),
        ].join("\n\n")
      : "",
    evidenceCards.length > 0
      ? [
          "Prefetched evidence cards:",
          ...evidenceCards.map((card) => formatEvidenceCard(card)),
        ].join("\n\n")
      : "Prefetched evidence cards: none",
  ];

  return [
    "Analyze the gathered evidence for this topic and return a structured dossier.",
    "Use only the discovery material and prefetched sources included in this prompt.",
    "Do not call tools. The evidence bundle should already contain the material you need.",
    "Cite only source IDs that are present in the prefetched sources list.",
    excludedEvidenceCount > 0
      ? `Discovery found ${excludedEvidenceCount} additional prefetched source${excludedEvidenceCount === 1 ? "" : "s"}, but they were excluded from this prompt because they were low-value, low-quality, off-topic, or below the evidence-card cutoff.`
      : "",
    ...taskSpecificInstructions,
    ...catalogInstructions,
    evidenceCards.length > 0
      ? `You must include at least one supporting sourceRef from these evidence cards when they support your findings: ${evidenceCards.map((card) => card.sourceId).join(", ")}.`
      : "",
    evidenceCards.length === 0
      ? "No usable evidence cards survived quality/relevance filtering for this topic. If the discovery bundle is still insufficient, say that plainly and leave sourceRefs empty rather than inventing citations."
      : "",
    "Use this exact shape:",
    "{\"summary\":\"...\",\"findings\":[\"...\"],\"contradictions\":[\"...\"],\"openQuestions\":[\"...\"],\"sourceRefs\":[\"source-1\"],\"confidence\":0.0}",
    "Allowed keys are only: summary, findings, contradictions, openQuestions, sourceRefs, confidence.",
    "Do not return topic, status, mission_overview, timeline, milestones, or sources objects.",
    "Return only a JSON object that matches the requested schema.",
    attempt > 1
      ? "The previous attempt leaked malformed output or missing citations. Do not include chain-of-thought, <channel|> markers, code fences, or prose outside a single JSON object."
      : "",
    attempt > 1 && sources.length > 0
      ? "If your conclusion is that the topic was absent or unsupported in the provided coverage, still cite the source IDs that demonstrate that absence. Do not leave sourceRefs empty when the usable prefetched sources support your conclusion."
      : "",
    ...discoverySections,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatResearchSourceTitle(source: ResearchSourceRecord): string {
  return normalizeInlineText(source.title ?? source.domain ?? source.resolvedUrl);
}

function formatResearchSourceFinding(source: ResearchSourceRecord, topic?: ResearchTopicPlan): string {
  const keywords = topic
    ? extractRelevanceKeywords([topic.title, topic.goal, ...topic.searchQueries], 18)
    : [];
  const preview = normalizeInlineText(
    extractBestEvidenceExcerpt(source, keywords, NEWS_DOSSIER_FINDING_PREVIEW_CHARS)
      .replace(/\b(?:Title|Description|Content|Byline|Page text|Snippet|Query|URL|Site|Top headlines \/ links):\s*/gi, " "),
  );
  const title = formatResearchSourceTitle(source);
  const domain = source.domain ? ` (${source.domain})` : "";
  return `${title}${domain}: ${preview}`;
}

function selectNewsDossierSources(
  topic: ResearchTopicPlan,
  sources: ResearchSourceRecord[],
): ResearchSourceRecord[] {
  const usableSources = sources.filter((source) => isUsableResearchSource(source));
  const selectedIds = selectFallbackCitationSourceIds(topic, usableSources, NEWS_DOSSIER_SOURCE_LIMIT);
  const byId = new Map(usableSources.map((source) => [source.id, source]));
  return selectedIds
    .map((sourceId) => byId.get(sourceId))
    .filter((source): source is ResearchSourceRecord => Boolean(source));
}

function buildSourceBackedResearchDossier(
  runId: string,
  topic: ResearchTopicPlan,
  sources: ResearchSourceRecord[],
  openQuestions: string[] = [],
): ResearchDossier {
  const selectedSources = selectNewsDossierSources(topic, sources);
  const domains = dedupeStrings(
    selectedSources
      .map((source) => source.domain)
      .filter((domain): domain is string => Boolean(domain)),
  );
  const sourceIds = selectedSources.map((source) => source.id);
  return {
    id: `${topic.id}-dossier`,
    topicId: topic.id,
    title: topic.title,
    summary:
      selectedSources.length > 0
        ? `Collected ${selectedSources.length} usable source${selectedSources.length === 1 ? "" : "s"} for ${topic.title}${domains.length > 0 ? ` across ${domains.slice(0, 5).join(", ")}` : ""}.`
        : `No usable sources survived filtering for ${topic.title}.`,
    findings: selectedSources.map((source) => formatResearchSourceFinding(source, topic)),
    contradictions: [],
    openQuestions:
      selectedSources.length > 0
        ? openQuestions
        : [`No usable source evidence was available for ${topic.title}.`, ...openQuestions],
    sourceIds,
    unresolvedSourceRefs: [],
    confidence: selectedSources.length > 0 ? 0.68 : 0.2,
    workerSessionId: `source-backed:${runId}:${topic.id}`,
  };
}

function formatSourceMarker(sourceIds: string[]): string {
  const ids = sourceIds
    .filter((sourceId) => /^source-\d+$/.test(sourceId))
    .slice(0, 4);
  return ids.length > 0 ? ` [${ids.join(", ")}]` : "";
}

function compactSourceMarker(sourceIds: string[], limit = 2): string {
  return formatSourceMarker(dedupeStrings(sourceIds).slice(0, limit));
}

function cleanFallbackReportEntry(value: string): string | undefined {
  const normalized = normalizeInlineText(value)
    .replace(/\s*(?:\(|\[)\s*source-\d+(?:\s*,\s*source-\d+)*\s*(?:\)|\])/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (/^[a-z][a-z0-9_ -]{2,40}:\s*$/i.test(normalized)) {
    return undefined;
  }
  return truncateInlineText(normalized, 520);
}

function reportEntrySimilarityTokens(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  const genericWords = new Set([
    ...RESEARCH_FOCUS_STOPWORDS,
    "actual",
    "considered",
    "content",
    "details",
    "regarding",
    "specific",
    "whether",
    "which",
    "will",
  ]);
  return new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.replace(/(?:ing|ed|s)$/i, ""))
      .filter((token) => token.length >= 4 && !genericWords.has(token)),
  );
}

function reportEntriesAreSimilar(left: string, right: string): boolean {
  const leftTokens = reportEntrySimilarityTokens(left);
  const rightTokens = reportEntrySimilarityTokens(right);
  const smallerSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallerSize < 4) {
    return false;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / smallerSize >= 0.7;
}

function fallbackOpenQuestionSemanticKey(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const mentionsCeasefire = /\b(?:ceasefire|truce)\b/.test(normalized);
  const mentionsMay9 = /\b(?:may\s*9|victory day)\b/.test(normalized);
  if (
    mentionsCeasefire
    && mentionsMay9
    && /\b(?:term|timing|expiration|detail|guarantee|proposal|viable)\b/.test(normalized)
  ) {
    return "may-9-ceasefire-terms";
  }
  if (
    mentionsCeasefire
    && /\b(?:phone call|trump|putin)\b/.test(normalized)
    && /\b(?:content|outcome|discussed|specific)\b/.test(normalized)
  ) {
    return "trump-putin-ceasefire-call-content";
  }
  if (
    mentionsCeasefire
    && /\b(?:accept|counter|respond)\b/.test(normalized)
    && /\b(?:zelensky|long-term|temporary)\b/.test(normalized)
  ) {
    return "russia-response-to-zelensky-ceasefire";
  }
  return undefined;
}

function cleanFallbackOpenQuestions(values: string[], limit = 6): string[] {
  const result: string[] = [];
  const semanticKeys = new Set<string>();
  for (const value of values) {
    const cleaned = cleanFallbackReportEntry(value);
    if (!cleaned) {
      continue;
    }
    const semanticKey = fallbackOpenQuestionSemanticKey(cleaned);
    if (semanticKey && semanticKeys.has(semanticKey)) {
      continue;
    }
    if (result.some((entry) => entry === cleaned || reportEntriesAreSimilar(entry, cleaned))) {
      continue;
    }
    result.push(cleaned);
    if (semanticKey) {
      semanticKeys.add(semanticKey);
    }
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function buildSourceBackedFinalSynthesis(
  brief: ResearchBrief,
  plan: ResearchPlan,
  dossiers: ResearchDossier[],
  sources: ResearchSourceRecord[],
  options: {
    fallbackIssues?: string[];
    gapsRemaining?: string[];
  } = {},
): FinalSynthesisRecord {
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const dossierSourceIds = dedupeStrings(
    dossiers
      .flatMap((dossier) => dossier.sourceIds)
      .filter((sourceId) => knownSourceIds.has(sourceId)),
  );
  const selectedSourceIds =
    dossierSourceIds.length > 0
      ? dossierSourceIds
      : sources
          .filter((source) => isUsableResearchSource(source))
          .slice(0, 12)
          .map((source) => source.id);
  const selectedSourceSet = new Set(selectedSourceIds);
  const fallbackIssues = options.fallbackIssues?.filter(Boolean) ?? [];
  const formattedFallbackIssues = fallbackIssues.map((issue) => issue.replace(/[.]+$/g, ""));
  const criticalWarnings = formattedFallbackIssues.map((issue) => formatCriticalResearchWarning(issue));
  const gapsRemaining = options.gapsRemaining?.filter(Boolean) ?? [];
  const dossierConfidence =
    dossiers.length > 0
      ? dossiers.reduce((sum, dossier) => sum + dossier.confidence, 0) / dossiers.length
      : 0.2;
  const confidence = clampConfidence(Math.min(0.72, dossierConfidence * 0.85));
  const openQuestions = cleanFallbackOpenQuestions([
    ...dossiers.flatMap((dossier) => dossier.openQuestions),
    ...gapsRemaining,
  ]);
  const fallbackContradictions = dossiers
    .flatMap((dossier) => dossier.contradictions)
    .map((entry) => cleanFallbackReportEntry(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 6);
  const sections = dossiers.map((dossier) => {
    const sectionSourceIds = dossier.sourceIds.filter((sourceId) => selectedSourceSet.has(sourceId));
    const sectionCitation = compactSourceMarker(sectionSourceIds, 3);
    const findings = dossier.findings
      .map((finding) => cleanFallbackReportEntry(finding))
      .filter((finding): finding is string => Boolean(finding))
      .slice(0, 6);
    const contradictions = dossier.contradictions
      .map((entry) => cleanFallbackReportEntry(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 4);
    const findingLines = findings.map((finding, index) => {
      const sourceId = sectionSourceIds[index] ?? sectionSourceIds[0];
      return `- ${finding}${sourceId ? compactSourceMarker([sourceId], 1) : sectionCitation}`;
    });
    const contradictionLines = contradictions.map((entry) => `- ⚠️ Disputed ${entry}${sectionCitation}`);
    return [
      `## ${dossier.title}`,
      "",
      `**${dossier.summary}**${sectionCitation}`,
      findingLines.length > 0 ? ["", ...findingLines].join("\n") : "",
      contradictionLines.length > 0 ? ["", ...contradictionLines].join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const coverageNotes = [
    selectedSourceIds.length > 0
      ? `The source-backed report is grounded in ${selectedSourceIds.length} fetched source${selectedSourceIds.length === 1 ? "" : "s"}.`
      : "The fallback report had no usable fetched source IDs to cite.",
    gapsRemaining.length > 0 ? `Coverage gaps remained: ${gapsRemaining.join(" | ")}.` : "",
    fallbackIssues.length > 0
      ? `Model synthesis fallback was used because the coordinator did not return a bounded structured report: ${formattedFallbackIssues.join(" | ")}.`
      : "",
  ].filter(Boolean);
  const reportSummary =
    [plan.scopeSummary, brief.scopeSummary, plan.objective, brief.objective]
      .map((entry) => normalizeInlineText(entry ?? ""))
      .find((entry) => entry.length >= 48)
    ?? normalizeInlineText(plan.objective || brief.objective || "Research findings.");
  const reportTitle = normalizeInlineText(brief.subject || "Research Report");
  const reportScope = normalizeInlineText(plan.scopeSummary || brief.scopeSummary || brief.objective || "Requested research scope");
  const tldrSentences = [
    `**${reportTitle}** is grounded in **${selectedSourceIds.length} fetched source${selectedSourceIds.length === 1 ? "" : "s"}** across **${dossiers.length} topic dossier${dossiers.length === 1 ? "" : "s"}**.`,
    `**${reportSummary}**`,
    criticalWarnings.length > 0 ? `**Fallback synthesis** was used because ${criticalWarnings[0]}.` : "",
  ].filter(Boolean);
  const keyFacts = [
    "| Fact | Value |",
    "| --- | --- |",
    `| Subject | ${reportTitle} |`,
    `| Scope | ${reportScope} |`,
    `| Sources used | ${selectedSourceIds.length} |`,
    `| Topics covered | ${dossiers.length} |`,
    `| Confidence | ${Math.round(confidence * 100)}% |`,
  ];
  const consensusSectionCitation = compactSourceMarker(selectedSourceIds, 2);
  const reportMarkdown = [
    `# ${reportTitle}`,
    "",
    `*Online · ${formatResearchCurrentDate()} · ${reportScope}*`,
    "",
    `> ${tldrSentences.join(" ")}`,
    "",
    ...keyFacts,
    criticalWarnings.length > 0
      ? ["", "## Critical Research Warnings", "", ...criticalWarnings.map((entry) => `- ${entry}`)].join("\n")
      : "",
    "",
    ...sections,
    [
      "",
      "## Consensus vs. disputed",
      "",
      "### Consensus",
      "",
      `- The filtered evidence supports the topic summaries above${consensusSectionCitation}.`,
      "",
      "### Disputed",
      "",
      fallbackContradictions.length > 0
        ? fallbackContradictions.map((entry) => `- ⚠️ Disputed ${entry}${consensusSectionCitation}`).join("\n")
        : "- No material source disagreement surfaced in the filtered evidence.",
    ].join("\n"),
    coverageNotes.length > 0 ? ["", "## Coverage Notes", "", ...coverageNotes.map((entry) => `- ${entry}`)].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    summary:
      selectedSourceIds.length > 0
        ? `Source-backed fallback synthesized ${dossiers.length} topic dossier${dossiers.length === 1 ? "" : "s"} from ${selectedSourceIds.length} fetched source${selectedSourceIds.length === 1 ? "" : "s"}.`
        : "Source-backed fallback could not find usable fetched sources for the final synthesis.",
    reportMarkdown,
    openQuestions,
    sourceIds: selectedSourceIds,
    confidence,
  };
}

function buildSynthesisPrompt(
  brief: ResearchBrief,
  plan: ResearchPlan,
  dossiers: ResearchDossier[],
  sources: ResearchSourceRecord[],
  attempt = 1,
  retryIssues: string[] = [],
): string {
  const evidenceCards = buildSynthesisEvidenceCards(brief, plan, dossiers, sources);
  const lines = [
    `Research objective: ${plan.objective}`,
    plan.scopeSummary ? `Scope summary: ${plan.scopeSummary}` : "",
    `Current date: ${formatResearchCurrentDate()}.`,
    `Task type: ${brief.taskType}.`,
    brief.reportRequirements.length > 0 ? `Report requirements: ${brief.reportRequirements.join(" | ")}` : "",
    plan.risks.length > 0 ? `Known risks: ${plan.risks.join(" | ")}` : "",
    [
      "Topic dossiers:",
      ...dossiers.map((dossier) =>
        [
          `Topic: ${dossier.title}`,
          `Summary: ${dossier.summary}`,
          dossier.findings.length > 0 ? `Findings: ${dossier.findings.join(" | ")}` : "",
          dossier.contradictions.length > 0
            ? `Contradictions: ${dossier.contradictions.join(" | ")}`
            : "",
          dossier.openQuestions.length > 0 ? `Open questions: ${dossier.openQuestions.join(" | ")}` : "",
          dossier.sourceIds.length > 0 ? `Source IDs: ${dossier.sourceIds.join(", ")}` : "Source IDs: none",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ].join("\n\n"),
    [
      `Cited evidence cards (${evidenceCards.length}/${sources.length} fetched sources shown):`,
      ...evidenceCards.map((card, index) => formatNumberedSynthesisEvidenceCard(card, index)),
    ].join("\n\n"),
    "Write a clear final research report in markdown using the Research Report Formatting Rules from your system instructions exactly.",
    "Prefer a compact, evidence-dense report over a long narrative. Cover the requested dimensions, but do not restate every source card.",
    "Keep reportMarkdown under 1,400 words while preserving every required section that applies.",
    "Preserve disagreements in the report when they affect the answer; keep unresolved questions as metadata in openQuestions, not as a report section.",
    "Do not include `Open Questions`, `Source Context`, `Evidence Context`, or internal-notes sections in reportMarkdown.",
    "Use only the topic dossiers and cited evidence cards as authoritative evidence for this synthesis.",
    "Do not inject outside knowledge to correct or overwrite the gathered evidence set.",
    "Use the bracketed numbers assigned to the cited evidence cards for reportMarkdown citations and the bottom Sources list.",
    "Return sourceIds as the underlying source IDs from the evidence cards, such as `source-1`, not numeric citation labels.",
    brief.taskType === "news-sweep"
      ? "For news sweeps, the themed `##` sections should cover front-page emphasis and latest story coverage when the gathered evidence supports them."
      : "",
    brief.taskType === "news-sweep"
      ? "If the gathered coverage is thin, stale, or overly concentrated in a few outlets, say so plainly instead of pretending the run was exhaustive."
      : "",
    "Use this exact shape:",
    "{\"summary\":\"...\",\"reportMarkdown\":\"# Topic\\n*Location · Date · Scope of report*\\n\\n> ...\",\"openQuestions\":[\"...\"],\"sourceIds\":[\"source-1\"],\"confidence\":0.0}",
    "Allowed keys are only: summary, reportMarkdown, openQuestions, sourceIds, confidence.",
    "Return only a JSON object that matches the requested schema.",
  ];

  if (attempt > 1) {
    lines.push(
      retryIssues.length > 0
        ? `Fix these issues from the previous draft: ${retryIssues.join(" | ")}`
        : "The previous attempt did not produce a valid synthesis object.",
      "Emit a single valid JSON object with summary, reportMarkdown, openQuestions, sourceIds, and confidence.",
    );
  }

  return lines
    .filter(Boolean)
    .join("\n\n");
}

function _buildSynthesisSelfCheckPrompt(
  plan: ResearchPlan,
  finalSynthesis: FinalSynthesisRecord,
  sources: ResearchSourceRecord[],
): string {
  const sourceCards = sources
    .filter((source) => finalSynthesis.sourceIds.includes(source.id))
    .slice(0, SYNTHESIS_EVIDENCE_CARD_LIMIT)
    .map((source) =>
      buildResearchEvidenceCardFromKeywords(
        source,
        extractRelevanceKeywords([plan.objective, plan.scopeSummary, ...plan.topics.flatMap((topic) => [topic.title, topic.goal])], 24),
        SYNTHESIS_EVIDENCE_EXCERPT_CHARS,
      ),
    );
  return [
    `Research objective: ${plan.objective}`,
    plan.scopeSummary ? `Scope summary: ${plan.scopeSummary}` : "",
    `Draft summary: ${finalSynthesis.summary}`,
    "Draft report:",
    finalSynthesis.reportMarkdown,
    [
      "Available source cards:",
      ...sourceCards.map((card) => formatEvidenceCard(card)),
    ].join("\n\n"),
    "Check whether the report follows instructions, stays grounded in the gathered evidence, and cites enough support.",
    "If the report is good enough, set ok to true and leave issues empty.",
    "Use this exact shape:",
    "{\"ok\":true,\"issues\":[],\"needsRetry\":false}",
    "Allowed keys are only: ok, issues, needsRetry.",
    "Return only a JSON object that matches the requested schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function _buildTopicWorkerMode(allowWorkspaceReads: boolean): ModeSelection {
  const tools = ["fetch_url_safe"];
  if (allowWorkspaceReads) {
    tools.push(
      "list_tree",
      "search_paths",
      "search_text",
      "materialize_content",
      "read_content",
      "search_content",
      "read_file",
      "read_files",
    );
  }
  return {
    base: "tool-worker",
    tools,
  };
}

interface ResearchSubsessionBudget {
  timeoutMs: number;
  timeoutMode: "wall" | "idle";
  maxAssistantChars: number;
}

function resolveResearchSubsessionBudget(
  phase: RunActivityRecord["phase"],
): ResearchSubsessionBudget {
  switch (phase) {
    case "planning":
      return {
        timeoutMs: DEFAULT_RESEARCH_PLANNING_TIMEOUT_MS,
        timeoutMode: "wall",
        maxAssistantChars: MAX_PLANNING_ASSISTANT_CHARS,
      };
    case "depth":
      return {
        timeoutMs: DEFAULT_RESEARCH_PLANNING_TIMEOUT_MS,
        timeoutMode: "wall",
        maxAssistantChars: MAX_DEPTH_SCOUT_ASSISTANT_CHARS,
      };
    case "synthesis":
      return {
        timeoutMs: DEFAULT_RESEARCH_SYNTHESIS_IDLE_TIMEOUT_MS,
        timeoutMode: "idle",
        maxAssistantChars: MAX_SYNTHESIS_ASSISTANT_CHARS,
      };
    case "topic":
    default:
      return {
        timeoutMs: DEFAULT_RESEARCH_TOPIC_TIMEOUT_MS,
        timeoutMode: "wall",
        maxAssistantChars: MAX_TOPIC_ASSISTANT_CHARS,
      };
  }
}

function formatResearchSubsessionBudgetLabel(
  phase: RunActivityRecord["phase"],
  topicTitle?: string,
): string {
  switch (phase) {
    case "planning":
      return "Research planner";
    case "depth":
      return "Source-depth scout";
    case "synthesis":
      return "Research synthesis";
    case "topic":
    default:
      return topicTitle ? `Topic worker "${topicTitle}"` : "Topic worker";
  }
}

export function createResearchSubsessionBudgetGuard(
  phase: RunActivityRecord["phase"],
  options: {
    parentSignal?: AbortSignal;
    topicTitle?: string;
  },
): {
  signal: AbortSignal;
  onEvent: (event: { type: string; payload: Record<string, unknown> }) => void;
  cleanup: () => void;
  wrapError: (error: unknown) => unknown;
} {
  const budget = resolveResearchSubsessionBudget(phase);
  const label = formatResearchSubsessionBudgetLabel(phase, options.topicTitle);
  const budgetController = new AbortController();
  let assistantChars = 0;
  let budgetFailureMessage: string | undefined;

  const abortForBudgetFailure = (message: string): void => {
    budgetFailureMessage = message;
    budgetController.abort(new GemmaDesktopError("timeout", message));
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = (): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    timeoutHandle = setTimeout(() => {
      const timeoutKind = budget.timeoutMode === "idle" ? "idle-progress" : "time";
      const action = budget.timeoutMode === "idle"
        ? `made no structured-output progress for ${Math.ceil(budget.timeoutMs / 60_000)} minute${budget.timeoutMs === 60_000 ? "" : "s"}`
        : `exceeded the ${Math.ceil(budget.timeoutMs / 60_000)} minute time budget`;
      abortForBudgetFailure(`${label} ${action} while generating structured output (${timeoutKind} budget).`);
    }, budget.timeoutMs);
  };

  armTimeout();

  const refreshProgressTimeout = (): void => {
    if (budget.timeoutMode === "idle" && !budgetFailureMessage) {
      armTimeout();
    }
  };

  const signals = options.parentSignal
    ? [options.parentSignal, budgetController.signal]
    : [budgetController.signal];

  return {
    signal: AbortSignal.any(signals),
    onEvent(event): void {
      if (event.type !== "content.delta") {
        return;
      }
      const channel = typeof event.payload.channel === "string" ? event.payload.channel : undefined;
      const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
      if ((channel === "assistant" || channel === "reasoning") && delta.length > 0) {
        refreshProgressTimeout();
      }
      if (channel !== "assistant" || delta.length === 0) {
        return;
      }

      assistantChars += delta.length;
      if (assistantChars <= budget.maxAssistantChars || budgetFailureMessage) {
        return;
      }

      abortForBudgetFailure(
        `${label} exceeded the ${budget.maxAssistantChars.toLocaleString()} character structured-output budget and looks runaway.`,
      );
    },
    cleanup(): void {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    },
    wrapError(error: unknown): unknown {
      if (!budgetFailureMessage) {
        return error;
      }
      return new GemmaDesktopError("timeout", budgetFailureMessage);
    },
  };
}

const MAX_RESEARCH_WORKER_TIMELINE_ENTRIES = 12;

function formatResearchWorkerToolLabel(toolName: string): string {
  switch (toolName) {
    case "fetch_url":
    case "fetch_url_safe":
      return "Fetch source";
    case "search_web":
      return "Search web";
    case "list_tree":
      return "List tree";
    case "search_paths":
      return "Search paths";
    case "search_text":
      return "Search text";
    case "materialize_content":
      return "Materialize content";
    case "read_content":
      return "Read content";
    case "search_content":
      return "Search content";
    case "read_file":
      return "Read file";
    case "read_files":
      return "Read files";
    default:
      return toolName
        .split(/[_-]+/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function buildResearchWorkerTextLabel(
  phase: RunActivityRecord["phase"],
  channel: "assistant" | "reasoning" | undefined,
): string | undefined {
  if (channel === "assistant") {
    if (phase === "planning") {
      return "Drafting research plan";
    }
    if (phase === "depth") {
      return "Selecting source-depth targets";
    }
    if (phase === "synthesis") {
      return "Drafting final synthesis";
    }
    return "Drafting topic dossier";
  }

  if (channel === "reasoning") {
    if (phase === "depth") {
      return "Reasoning about source depth";
    }
    return phase === "topic"
      ? "Reasoning about topic evidence"
      : "Reasoning about next research step";
  }

  return undefined;
}

function buildResearchWorkerDetailPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeInlineText(value);
    return normalized.length > 0 ? truncateText(normalized, 120) : undefined;
  }

  if (Array.isArray(value)) {
    const firstString = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return firstString ? buildResearchWorkerDetailPreview(firstString) : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["query", "url", "path", "pattern", "command", "goal", "delta", "output"]) {
      const preview = buildResearchWorkerDetailPreview(record[key]);
      if (preview) {
        return preview;
      }
    }
  }

  return undefined;
}

function upsertResearchWorkerTimelineEntry(
  timeline: ResearchWorkerTimelineEntry[],
  entry: ResearchWorkerTimelineEntry,
): ResearchWorkerTimelineEntry[] {
  const existingIndex = timeline.findIndex((candidate) => candidate.id === entry.id);
  if (existingIndex >= 0) {
    const existing = timeline[existingIndex];
    if (
      existing
      && existing.label === entry.label
      && existing.detail === entry.detail
      && existing.tone === entry.tone
    ) {
      return timeline;
    }
    const nextTimeline = [...timeline];
    nextTimeline[existingIndex] = entry;
    return nextTimeline;
  }

  return [...timeline, entry].slice(-MAX_RESEARCH_WORKER_TIMELINE_ENTRIES);
}

function toResearchWorkerSnapshot(record: RunActivityRecord): ResearchWorkerSnapshot {
  return {
    kind: record.phase,
    label: record.label,
    goal: record.goal,
    childSessionId: record.childSessionId,
    childTurnId: record.childTurnId,
    currentAction: record.currentAction,
    assistantDeltaCount: record.assistantDeltaCount,
    reasoningDeltaCount: record.reasoningDeltaCount,
    lifecycleCount: record.lifecycleCount,
    toolCallCount: record.toolCallCount,
    toolResultCount: record.toolResultCount,
    searchCount: record.searchCount,
    fetchCount: record.fetchCount,
    sourceCount: record.sourceCount,
    timeline: [...record.timeline],
    resultSummary: record.resultSummary,
    traceText: record.traceText,
  };
}

async function persistSubsessionArtifacts(
  runDirectory: string,
  relativeDirectory: string,
  result: ToolSubsessionResult,
): Promise<void> {
  const artifactDirectory = path.join(runDirectory, relativeDirectory);
  await mkdir(artifactDirectory, { recursive: true });
  if (result.snapshot) {
    await writeJson(path.join(artifactDirectory, "session.json"), result.snapshot);
  }
  await writeJson(path.join(artifactDirectory, "events.json"), result.events);
  await writeJson(path.join(artifactDirectory, "result.json"), {
    sessionId: result.sessionId,
    turnId: result.turnId,
    outputText: result.outputText,
    structuredOutput: result.structuredOutput,
    metadata: result.metadata,
  });
  await writeText(path.join(artifactDirectory, "trace.txt"), renderTrace(result.events));
}

function createSourcePreview(result: FetchExecutionResult): string {
  const headlineSection =
    result.structuredOutput.headlines && result.structuredOutput.headlines.length > 0
      && !/Top headlines \/ links:/i.test(result.structuredOutput.content)
      ? [
          "Top headlines / links:",
          ...result.structuredOutput.headlines.map((headline, index) => `${index + 1}. ${headline.title}\n   ${headline.url}`),
        ].join("\n")
      : "";
  return truncateText(
    [
      result.structuredOutput.content,
      headlineSection,
    ]
      .filter(Boolean)
      .join("\n\n")
      .replace(/```+/g, "")
      .replace(/<channel\|>/g, "")
      .replace(/\b(?:jsonset|thought:|reasoning:)\b/gi, ""),
    5000,
  );
}

function _extractFetchResultsFromEvents(events: ToolSubsessionResult["events"]): FetchExecutionResult[] {
  const fetches: FetchExecutionResult[] = [];
  for (const event of events) {
    if (event.type !== "tool.result") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (payload.toolName !== "fetch_url" && payload.toolName !== "fetch_url_safe") {
      continue;
    }
    const structuredOutput = payload.structuredOutput;
    if (!structuredOutput || typeof structuredOutput !== "object") {
      continue;
    }
    const record = structuredOutput as FetchExecutionResult["structuredOutput"] & { ok?: boolean };
    if (record.ok === false) {
      continue;
    }
    if (typeof record.requestedUrl !== "string" || typeof record.resolvedUrl !== "string") {
      continue;
    }
    fetches.push({
      output: typeof payload.output === "string" ? payload.output : "",
      structuredOutput: record,
      metadata:
        payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata as Record<string, unknown>
          : undefined,
    });
  }
  return fetches;
}

function _extractFetchErrorsFromEvents(
  events: ToolSubsessionResult["events"],
): Array<{ url: string; error: string }> {
  const fetchErrors: Array<{ url: string; error: string }> = [];
  for (const event of events) {
    if (event.type !== "tool.result") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (payload.toolName !== "fetch_url_safe") {
      continue;
    }
    const structuredOutput = payload.structuredOutput;
    if (!structuredOutput || typeof structuredOutput !== "object") {
      continue;
    }
    const record = structuredOutput as {
      ok?: boolean;
      requestedUrl?: string;
      error?: string;
    };
    if (record.ok !== false || typeof record.requestedUrl !== "string" || typeof record.error !== "string") {
      continue;
    }
    fetchErrors.push({
      url: record.requestedUrl,
      error: record.error,
    });
  }
  return fetchErrors;
}

function normalizeSourceRef(
  sourceRef: string,
  sourcesById: Map<string, ResearchSourceRecord>,
  sourceIdByUrl: Map<string, string>,
): { sourceId?: string; unresolved?: string } {
  if (sourcesById.has(sourceRef)) {
    return {
      sourceId: sourceRef,
    };
  }
  const normalized =
    sourceIdByUrl.get(sourceRef)
    ?? sourceIdByUrl.get(normalizeSourceLookupUrl(sourceRef) ?? "");
  if (normalized) {
    return {
      sourceId: normalized,
    };
  }
  return {
    unresolved: sourceRef,
  };
}

function normalizeSourceLookupUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return undefined;
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" && parsed.port === "80")
      || (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function getRegisteredSourceId(
  sourceIdByUrl: Map<string, string>,
  url: string,
): string | undefined {
  return sourceIdByUrl.get(url) ?? sourceIdByUrl.get(normalizeSourceLookupUrl(url) ?? "");
}

function rememberSourceUrl(
  sourceIdByUrl: Map<string, string>,
  url: string,
  sourceId: string,
): void {
  sourceIdByUrl.set(url, sourceId);
  const normalized = normalizeSourceLookupUrl(url);
  if (normalized) {
    sourceIdByUrl.set(normalized, sourceId);
  }
}

function dossierStatesEvidenceIsAbsent(
  dossier: Pick<NormalizedDossierRecord, "summary" | "findings" | "openQuestions">,
): boolean {
  const haystack = [
    dossier.summary,
    ...dossier.findings,
    ...dossier.openQuestions,
  ]
    .join("\n")
    .toLowerCase();
  return /\b(?:no\s+(?:usable\s+)?(?:evidence|information|coverage|reporting|results?|sources?)|did not find|nothing (?:relevant|material)|not (?:covered|mentioned|supported)|unsupported|insufficient evidence|insufficient coverage|no relevant)\b/
    .test(haystack);
}

function selectFallbackCitationSourceIds(
  topic: ResearchTopicPlan,
  sources: ResearchSourceRecord[],
  limit = 4,
): string[] {
  const keywords = extractRelevanceKeywords([topic.title, topic.goal, ...topic.searchQueries], 18);
  const preferredPageRole =
    /front page|headline/i.test(`${topic.title} ${topic.goal}`)
      ? "front_page"
      : /community/i.test(`${topic.title} ${topic.goal}`)
        ? "community"
        : "article";

  return [...sources]
    .sort((left, right) => {
      const score = (source: ResearchSourceRecord): number => {
        let value = 0;
        if (source.pageRole === preferredPageRole) {
          value += 100;
        }
        value += countKeywordHits(
          `${source.title ?? ""}\n${source.description ?? ""}\n${source.contentPreview}`,
          keywords,
        ) * 12;
        if (source.sourceFamily === "official") {
          value += 30;
        }
        if (source.sourceFamily === "wire") {
          value += 20;
        }
        if ((source.sourceDepth ?? 0) > 0 || source.discoveryMethod === "one_hop") {
          value += 15;
        }
        if (source.pageRole === "reference" || source.pageRole === "article") {
          value += 10;
        }
        if (source.pageRole === "front_page") {
          value += 10;
        }
        if (source.blockedLikely || source.kind === "search-result") {
          value -= 8;
        }
        return value;
      };
      return score(right) - score(left) || left.id.localeCompare(right.id);
    })
    .slice(0, limit)
    .map((source) => source.id);
}

export const __testOnly = {
  inferResearchFocusQuery,
  buildResearchBrief,
  buildCoveragePlan,
  buildCoverageAssessment,
  buildCoverageSnapshot,
  dossierStatesEvidenceIsAbsent,
  selectFallbackCitationSourceIds,
  classifySourceFamily,
  prioritizeSearchCandidate,
  buildHeuristicSynthesisSelfCheckRecord,
  assessContentQuality,
  extractRelevanceKeywords,
  sourceMatchesKeywords,
  isCatalogStyleRequest,
  extractCatalogDomainHints,
  extractOneHopResearchUrlsFromSource,
  buildResearchEvidenceCards,
  buildSynthesisEvidenceCards,
  buildSourceBackedFinalSynthesis,
  formatEvidenceCard,
  cleanFallbackReportEntry,
  cleanFallbackOpenQuestions,
  formatCriticalResearchWarning,
  stripUserFacingResearchScaffoldSections,
  normalizeDepthScoutRecord,
  recoverDepthScoutRecord,
  inferResearchSubject,
  buildDeterministicResearchPlan,
  isStructuredOutputBudgetFailure,
  isMissingSearchConfigurationError,
  buildPlanningPrompt,
  enhanceReportWithSourceLinks,
};

export class ResearchRunner {
  private readonly snapshot: SessionSnapshot;
  private readonly runSubsession: (request: ToolSubsessionRequest, parentToolCallId: string) => Promise<ToolSubsessionResult>;
  private readonly resolveGeminiApiKey: () => string | undefined;
  private readonly resolveGeminiApiModel: () => string | undefined;

  public constructor(options: ResearchRunnerOptions) {
    this.snapshot = options.snapshot;
    this.runSubsession = options.runSubsession;
    this.resolveGeminiApiKey =
      typeof options.geminiApiKey === "function"
        ? options.geminiApiKey
        : () => (options.geminiApiKey as string | undefined);
    this.resolveGeminiApiModel =
      typeof options.geminiApiModel === "function"
        ? options.geminiApiModel
        : () => (options.geminiApiModel as string | undefined);
  }

  public async run(input: SessionInput, options: ResearchRunOptions = {}): Promise<ResearchRunResult> {
    const requestText = contentPartsToText(input);
    if (requestText.length === 0) {
      throw new GemmaDesktopError("invalid_tool_input", "Research runs require a non-empty text request.");
    }

    const normalizedOptions = normalizeResearchOptions(this.snapshot, options);
    const runId = randomUUID();
    const runDirectory = path.join(normalizedOptions.artifactDirectory, runId);
    const sourceRegistry = new Map<string, ResearchSourceRecord>();
    const sourceIdByUrl = new Map<string, string>();
    const discoveryByTopic = new Map<string, DiscoveryRecord>();
    const startedAt = new Date().toISOString();
    const runState: ResearchRunStatus = {
      runId,
      parentSessionId: this.snapshot.sessionId,
      runtimeId: this.snapshot.runtimeId,
      modelId: this.snapshot.modelId,
      profile: normalizedOptions.profile,
      status: "running",
      stage: "planning",
      startedAt,
      artifactDirectory: runDirectory,
      stages: {
        planning: {
          status: "running",
          startedAt,
        },
        discovery: {
          status: "pending",
        },
        depth: {
          status: "pending",
        },
        workers: {
          status: "pending",
        },
        synthesis: {
          status: "pending",
        },
      },
      topicStatuses: [],
      warnings: [],
    };

    await mkdir(runDirectory, { recursive: true });
    await writeJson(path.join(runDirectory, "run.json"), {
      runId,
      request: requestText,
      profile: normalizedOptions.profile,
      parentSessionId: this.snapshot.sessionId,
      runtimeId: this.snapshot.runtimeId,
      modelId: this.snapshot.modelId,
      workingDirectory: this.snapshot.workingDirectory,
      startedAt,
      options: {
        maxConcurrentModelWorkers: normalizedOptions.maxConcurrentModelWorkers,
        maxConcurrentWebSearches: normalizedOptions.maxConcurrentWebSearches,
        maxConcurrentWebFetches: normalizedOptions.maxConcurrentWebFetches,
        maxConcurrentWorkspaceReads: normalizedOptions.maxConcurrentWorkspaceReads,
        allowWorkspaceReads: normalizedOptions.allowWorkspaceReads,
      },
    });

    const writeState = async (): Promise<void> => {
      await writeJson(path.join(runDirectory, "status.json"), runState);
      await normalizedOptions.onStatus?.(structuredClone(runState));
    };

    const markStageRunning = (stage: keyof ResearchRunStatus["stages"]): void => {
      const record = runState.stages[stage];
      record.status = "running";
      record.startedAt ??= new Date().toISOString();
      delete record.completedAt;
    };

    const markStageCompleted = (stage: keyof ResearchRunStatus["stages"]): void => {
      const record = runState.stages[stage];
      record.startedAt ??= new Date().toISOString();
      record.status = "completed";
      record.completedAt = new Date().toISOString();
    };

    const markStageFailed = (stage: keyof ResearchRunStatus["stages"]): void => {
      const record = runState.stages[stage];
      record.startedAt ??= new Date().toISOString();
      record.status = "failed";
      record.completedAt = new Date().toISOString();
    };

    const createActivityTracker = (
      phase: RunActivityRecord["phase"],
      attempt: number,
      options: {
        topic?: Pick<ResearchTopicPlan, "id" | "title" | "goal">;
        label: string;
        goal?: string;
        target?: ResearchWorkerSnapshot;
      },
    ) => {
      let lastWriteAt = 0;
      const startedAtIso = new Date().toISOString();
      const record: RunActivityRecord = {
        phase,
        attempt,
        topicId: options.topic?.id,
        topicTitle: options.topic?.title,
        startedAt: startedAtIso,
        label: options.label,
        goal: options.goal ?? options.topic?.goal,
        currentAction:
          phase === "topic"
            ? "Starting topic worker"
            : phase === "planning"
              ? "Starting research planning"
              : phase === "depth"
                ? "Starting source-depth scout"
                : "Starting final synthesis",
        assistantDeltaCount: 0,
        reasoningDeltaCount: 0,
        lifecycleCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        timeline: [
          {
            id: "worker-start",
            label:
              phase === "topic"
                ? "Topic worker started"
                : phase === "planning"
                  ? "Research coordinator started"
                  : phase === "depth"
                    ? "Source-depth scout started"
                    : "Synthesis coordinator started",
            timestamp: startedAtIso,
          },
        ],
      };

      const syncSnapshot = (): void => {
        if (!options.target) {
          return;
        }
        Object.assign(options.target, toResearchWorkerSnapshot(record));
      };

      const maybeWriteState = async (force = false): Promise<void> => {
        syncSnapshot();
        const now = Date.now();
        if (!force && now - lastWriteAt < 1000) {
          return;
        }
        lastWriteAt = now;
        await writeState();
      };

      return {
        async begin(): Promise<void> {
          syncSnapshot();
          runState.activities = [...(runState.activities ?? []), record];
          await writeState();
        },
        async onSessionStarted(info: { sessionId: string; turnId: string }): Promise<void> {
          record.childSessionId = info.sessionId;
          record.childTurnId = info.turnId;
          await maybeWriteState(true);
        },
        async update(
          patch: Partial<Pick<
            RunActivityRecord,
            "currentAction" | "searchCount" | "fetchCount" | "sourceCount" | "resultSummary" | "traceText"
          >>,
        ): Promise<void> {
          Object.assign(record, patch);
          await maybeWriteState(true);
        },
        async onEvent(event: { type: string; timestamp: string; payload: Record<string, unknown> }): Promise<void> {
          record.lastEventAt = event.timestamp;
          record.lastEventType = event.type;

          if (event.type === "content.delta") {
            const channel = typeof event.payload.channel === "string" ? event.payload.channel : undefined;
            const nextAction =
              channel === "assistant" || channel === "reasoning"
                ? buildResearchWorkerTextLabel(phase, channel)
                : undefined;
            if (channel === "assistant") {
              record.assistantDeltaCount += 1;
              record.firstTokenAt ??= event.timestamp;
            } else if (channel === "reasoning") {
              record.reasoningDeltaCount += 1;
            }
            if (nextAction) {
              record.currentAction = nextAction;
              record.timeline = upsertResearchWorkerTimelineEntry(record.timeline, {
                id: `content-${channel}`,
                label: nextAction,
                timestamp: event.timestamp,
              });
            }
          } else if (event.type === "tool.call") {
            record.toolCallCount += 1;
            const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "tool";
            const label = formatResearchWorkerToolLabel(toolName);
            record.currentAction = label;
            record.timeline = upsertResearchWorkerTimelineEntry(record.timeline, {
              id: `tool-call-${record.toolCallCount}`,
              label,
              detail: buildResearchWorkerDetailPreview(event.payload.input),
              timestamp: event.timestamp,
            });
          } else if (event.type === "tool.result") {
            record.toolResultCount += 1;
            const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "tool";
            const label = `Completed ${formatResearchWorkerToolLabel(toolName)}`;
            record.currentAction = label;
            record.timeline = upsertResearchWorkerTimelineEntry(record.timeline, {
              id: `tool-result-${record.toolResultCount}`,
              label,
              detail: buildResearchWorkerDetailPreview(event.payload.structuredOutput ?? event.payload.output),
              timestamp: event.timestamp,
              tone: "success",
            });
          } else if (event.type === "runtime.lifecycle") {
            record.lifecycleCount += 1;
            record.currentAction = "Waiting on runtime";
            record.timeline = upsertResearchWorkerTimelineEntry(record.timeline, {
              id: "runtime-lifecycle",
              label: "Waiting on runtime",
              timestamp: event.timestamp,
            });
          }

          await maybeWriteState();
        },
        async complete(
          result: ToolSubsessionResult,
          options: {
            resultSummary?: string;
            searchCount?: number;
            fetchCount?: number;
            sourceCount?: number;
          } = {},
        ): Promise<void> {
          record.resultSummary =
            options.resultSummary
            ?? toNonEmptyString(result.outputText)
            ?? record.resultSummary;
          record.traceText = renderTrace(result.events);
          record.searchCount = options.searchCount ?? record.searchCount;
          record.fetchCount = options.fetchCount ?? record.fetchCount;
          record.sourceCount = options.sourceCount ?? record.sourceCount;
          record.currentAction =
            phase === "synthesis"
              ? "Synthesis complete"
              : phase === "depth"
                ? "Source-depth scout complete"
                : "Worker complete";
          record.timeline = upsertResearchWorkerTimelineEntry(record.timeline, {
            id: "worker-complete",
            label:
              phase === "synthesis"
                ? "Synthesis complete"
                : phase === "depth"
                  ? "Source-depth scout complete"
                  : "Worker complete",
            detail: record.resultSummary,
            timestamp: new Date().toISOString(),
            tone: "success",
          });
          await maybeWriteState(true);
        },
        async end(): Promise<void> {
          const remaining = (runState.activities ?? []).filter((entry) => entry !== record);
          if (remaining.length > 0) {
            runState.activities = remaining;
          } else {
            delete runState.activities;
          }
          await writeState();
        },
      };
    };
    await writeState();

    const buildResearchSubsessionMetadata = (
      metadata: Record<string, unknown>,
      options: {
        reasoningMode?: "off" | "on";
      } = {},
    ): Record<string, unknown> => {
      const parentPreferencesValue = this.snapshot.metadata?.requestPreferences;
      const parentPreferences =
        parentPreferencesValue
        && typeof parentPreferencesValue === "object"
        && !Array.isArray(parentPreferencesValue)
          ? parentPreferencesValue as Record<string, unknown>
          : undefined;
      const reasoningMode = options.reasoningMode ?? "off";
      const requestPreferences: Record<string, unknown> = {
        ...(parentPreferences ?? {}),
        reasoningMode,
      };
      if (reasoningMode === "off") {
        const parentOllamaOptionsValue = parentPreferences?.ollamaOptions;
        const parentOllamaOptions =
          parentOllamaOptionsValue
          && typeof parentOllamaOptionsValue === "object"
          && !Array.isArray(parentOllamaOptionsValue)
            ? parentOllamaOptionsValue as Record<string, unknown>
            : undefined;
        const ollamaOptions: Record<string, unknown> = {
          ...(parentOllamaOptions ?? {}),
          temperature: 0.2,
        };
        requestPreferences.ollamaOptions = ollamaOptions;
      }

      return {
        ...metadata,
        requestPreferences,
      };
    };

    try {
      const planningResponseFormat = makeStructuredResponseFormat(
        "research_plan",
        {
          objective: { type: "string" },
          scopeSummary: { type: "string" },
          risks: { type: "array", items: { type: "string" } },
          stopConditions: { type: "array", items: { type: "string" } },
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                goal: { type: "string" },
                priority: { type: "integer" },
                searchQueries: { type: "array", items: { type: "string" } },
              },
              required: ["title", "goal", "searchQueries"],
              additionalProperties: false,
            },
          },
        },
        ["objective", "topics"],
      );

      let plannerResult: ToolSubsessionResult | undefined;
      let plan: ResearchPlan | undefined;
      runState.stages.planning.worker = {
        kind: "planning",
        label: "Research coordinator",
        goal: "Plan the topic breakdown for this research run.",
        assistantDeltaCount: 0,
        reasoningDeltaCount: 0,
        lifecycleCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        timeline: [],
      };
      for (const attempt of [1, 2]) {
        const tracker = createActivityTracker("planning", attempt, {
          label: "Research coordinator",
          goal: "Plan the topic breakdown for this research run.",
          target: runState.stages.planning.worker,
        });
        const budgetGuard = createResearchSubsessionBudgetGuard("planning", {
          parentSignal: normalizedOptions.signal,
        });
        await tracker.begin();
        let attemptResult: ToolSubsessionResult;
        try {
          attemptResult = await this.runSubsession(
            {
              prompt: buildPlanningPrompt(requestText, normalizedOptions.profile, attempt),
              mode: "minimal",
              responseFormat: planningResponseFormat,
              maxSteps: normalizedOptions.profile === "quick" ? 3 : 4,
              metadata: buildResearchSubsessionMetadata({
                researchRunId: runId,
                researchStage: "planning",
                researchAttempt: attempt,
              }),
              signal: budgetGuard.signal,
              onSessionStarted: async (info) => await tracker.onSessionStarted(info),
              onEvent: async (event) => {
                await tracker.onEvent(event);
                budgetGuard.onEvent(event);
              },
            },
            `research:${runId}:planning`,
          );

          const recoveredPlan = recoverPlan(attemptResult, requestText, normalizedOptions.profile);
          if (recoveredPlan) {
            plannerResult = attemptResult;
            plan = ensurePlanCoverage(requestText, recoveredPlan, normalizedOptions.profile);
            await tracker.complete(attemptResult, {
              resultSummary: plan.objective,
            });
            await persistSubsessionArtifacts(runDirectory, "workers/coordinator-plan", attemptResult);
            break;
          }

          await tracker.complete(attemptResult, {
            resultSummary: "Planner attempt completed without a valid structured plan.",
          });
          await persistSubsessionArtifacts(
            runDirectory,
            `workers/coordinator-plan-attempt-${attempt}`,
            attemptResult,
          );
        } catch (error) {
          const wrapped = budgetGuard.wrapError(error);
          if (normalizedOptions.signal?.aborted === true) {
            throw wrapped;
          }
          const message = wrapped instanceof Error ? wrapped.message : String(wrapped);
          if (!isStructuredOutputBudgetFailure(message)) {
            throw wrapped;
          }
          plan = buildDeterministicResearchPlan(requestText, normalizedOptions.profile, message);
          plannerResult = {
            sessionId: `deterministic:${runId}:planning`,
            turnId: `deterministic:${runId}:planning`,
            events: [],
            outputText: plan.objective,
            structuredOutput: plan,
            metadata: {
              deterministicFallback: true,
              reason: message,
            },
          };
          await tracker.update({
            currentAction: "Using deterministic research plan",
            resultSummary: message,
          });
          await tracker.complete(plannerResult, {
            resultSummary: `${plan.objective} Deterministic planner fallback used after model planner timeout.`,
          });
          await persistSubsessionArtifacts(runDirectory, "workers/coordinator-plan-fallback", plannerResult);
          break;
        } finally {
          budgetGuard.cleanup();
          await tracker.end();
        }
      }

      if (!plannerResult || !plan) {
        plan = buildDeterministicResearchPlan(
          requestText,
          normalizedOptions.profile,
          "Planner did not produce a valid structured plan after recovery and retry.",
        );
        plannerResult = {
          sessionId: `deterministic:${runId}:planning`,
          turnId: `deterministic:${runId}:planning`,
          events: [],
          outputText: plan.objective,
          structuredOutput: plan,
          metadata: {
            deterministicFallback: true,
            reason: "Planner did not produce a valid structured plan after recovery and retry.",
          },
        };
        if (runState.stages.planning.worker) {
          runState.stages.planning.worker.currentAction = "Using deterministic research plan";
          runState.stages.planning.worker.resultSummary =
            "Planner did not produce a valid structured plan after recovery and retry.";
          runState.stages.planning.worker.sourceCount = 0;
          runState.stages.planning.worker.timeline = upsertResearchWorkerTimelineEntry(
            runState.stages.planning.worker.timeline,
            {
              id: "deterministic-planning-fallback",
              label: "Using deterministic research plan",
              detail: "Planner did not produce a valid structured plan after recovery and retry.",
              timestamp: new Date().toISOString(),
              tone: "warning",
            },
          );
        }
        await persistSubsessionArtifacts(runDirectory, "workers/coordinator-plan-fallback", plannerResult);
        await writeState();
      }

      const brief = buildResearchBrief(requestText, plan);
      const coveragePlanResult = buildCoveragePlan(requestText, plan, brief, normalizedOptions.profile);
      plan = coveragePlanResult.effectivePlan;
      const coveragePlan = coveragePlanResult.coveragePlan;
      const topicById = new Map(plan.topics.map((topic) => [topic.id, topic]));
      let latestAssessment: CoverageAssessment | undefined;
      const relevanceKeywords = extractRelevanceKeywords([
        brief.subject,
        brief.focusQuery,
        brief.objective,
        brief.scopeSummary,
        ...plan.topics.map((topic) => topic.title),
        ...plan.topics.map((topic) => topic.goal),
      ]);
      const catalogStyleRequest = isCatalogStyleRequest(`${brief.focusQuery}\n${brief.objective}\n${requestText}`);

      runState.taskType = brief.taskType;
      runState.sourceFamilies = dedupeSourceFamilies([
        ...brief.requiredSourceFamilies,
        ...brief.optionalSourceFamilies,
      ]);
      runState.topicStatuses = plan.topics.map((topic) => ({
        topicId: topic.id,
        title: topic.title,
        goal: topic.goal,
        status: "pending",
        searchCount: 0,
        searchErrorCount: 0,
        fetchCount: 0,
        fetchErrorCount: 0,
        sourceCount: 0,
      }));
      runState.passCount = 0;
      runState.currentPass = 0;
      runState.coverage = buildCoverageSnapshot(coveragePlan, []);
      runState.gapsRemaining = coveragePlan.requiredSourceFamilies.map((family) =>
        `Need coverage for ${SOURCE_FAMILY_LABELS[family]}.`,
      );
      markStageCompleted("planning");
      await writeJson(path.join(runDirectory, "brief.json"), brief);
      await writeJson(path.join(runDirectory, "coverage-plan.json"), coveragePlan);
      await writeJson(path.join(runDirectory, "plan.json"), plan);
      await writeState();

      runState.stage = "discovery";
      markStageRunning("discovery");
      runState.stages.discovery.worker = {
        kind: "discovery",
        label: "Research coordinator",
        goal: "Gather evidence in bounded, coverage-driven passes.",
        assistantDeltaCount: 0,
        reasoningDeltaCount: 0,
        lifecycleCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        searchCount: 0,
        fetchCount: 0,
        sourceCount: 0,
        timeline: [],
      };
      await writeState();

      for (const topic of plan.topics) {
        discoveryByTopic.set(topic.id, {
          searches: [],
          seedUrls: [],
          fetchedSourceIds: [],
          searchErrors: [],
          fetchErrors: [],
        });
      }

      const executor = new ParallelHostExecutor({
        workingDirectory: this.snapshot.workingDirectory,
        geminiApiKey: this.resolveGeminiApiKey(),
        geminiApiModel: this.resolveGeminiApiModel(),
        maxConcurrentWebSearches: normalizedOptions.maxConcurrentWebSearches,
        maxConcurrentWebFetches: normalizedOptions.maxConcurrentWebFetches,
        maxConcurrentWorkspaceReads: normalizedOptions.maxConcurrentWorkspaceReads,
      });
      const minimumDiscoveryPasses = (() => {
        if (
          normalizedOptions.profile === "deep"
          && brief.taskType === "news-sweep"
          && (
            brief.requiredSourceFamilies.includes("mainstream_front_page")
            || brief.optionalSourceFamilies.includes("mainstream_front_page")
          )
        ) {
          return 2;
        }
        if (normalizedOptions.profile !== "quick" && catalogStyleRequest) {
          return 2;
        }
        return 1;
      })();

      let sourceCounter = 0;
      const registerFetchResult = (
        topicIds: string[],
        fetchResult: FetchExecutionResult,
        fallbackFamily?: ResearchSourceFamily,
        searchSnippetCandidate?: SearchSnippetSourceCandidate,
        discovery: {
          sourceDepth?: number;
          discoveryMethod?: ResearchSourceRecord["discoveryMethod"];
          parentSourceId?: string;
          parentResolvedUrl?: string;
        } = {},
      ): string => {
        const existingSourceId =
          getRegisteredSourceId(sourceIdByUrl, fetchResult.structuredOutput.resolvedUrl)
          ?? getRegisteredSourceId(sourceIdByUrl, fetchResult.structuredOutput.requestedUrl);
        if (existingSourceId) {
          const existing = sourceRegistry.get(existingSourceId);
          if (existing) {
            for (const topicId of topicIds) {
              if (!existing.topicIds.includes(topicId)) {
                existing.topicIds.push(topicId);
              }
            }
            existing.sourceFamily ??= classifySourceFamily(existing.resolvedUrl, fallbackFamily, {
              title: existing.title,
              description: existing.description,
            });
            existing.domain ??= parseUrlDomain(existing.resolvedUrl);
            existing.sourceDepth ??= discovery.sourceDepth;
            existing.discoveryMethod ??= discovery.discoveryMethod;
            existing.parentSourceId ??= discovery.parentSourceId;
            existing.parentResolvedUrl ??= discovery.parentResolvedUrl;
          }
          return existingSourceId;
        }
        sourceCounter += 1;
        const resolvedUrl = fetchResult.structuredOutput.resolvedUrl;
        const sourceFamily = classifySourceFamily(resolvedUrl, fallbackFamily, {
          title: fetchResult.structuredOutput.title,
          description: fetchResult.structuredOutput.description,
        });
        const rawPreview = createSourcePreview(fetchResult);
        const contentLength = fetchResult.structuredOutput.contentLength;
        const quality = assessContentQuality(rawPreview, contentLength);
        let contentPreview = rawPreview;
        let snippetMerged = false;
        if (quality.lowQuality && searchSnippetCandidate) {
          const snippetBlock = [
            "",
            "[Search snippet preserved because the fetched page body was not extractable:]",
            `Query: ${searchSnippetCandidate.query}`,
            `Title: ${searchSnippetCandidate.title}`,
            searchSnippetCandidate.siteName ? `Site: ${searchSnippetCandidate.siteName}` : "",
            searchSnippetCandidate.snippet ? `Snippet: ${searchSnippetCandidate.snippet}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          contentPreview = truncateText(`${rawPreview}\n${snippetBlock}`.trim(), 5000);
          snippetMerged = true;
        }
        const candidateFields = {
          title: fetchResult.structuredOutput.title,
          description: fetchResult.structuredOutput.description,
          contentPreview,
        };
        const offTopic = relevanceKeywords.length > 0
          ? !sourceMatchesKeywords(candidateFields, relevanceKeywords)
          : false;
        const sourceRecord: ResearchSourceRecord = {
          id: `source-${sourceCounter}`,
          requestedUrl: fetchResult.structuredOutput.requestedUrl,
          resolvedUrl,
          title: fetchResult.structuredOutput.title,
          description: fetchResult.structuredOutput.description,
          kind: fetchResult.structuredOutput.kind,
          extractedWith: fetchResult.structuredOutput.extractedWith,
          blockedLikely: fetchResult.structuredOutput.blockedLikely || quality.lowQuality,
          fetchedAt: new Date().toISOString(),
          topicIds: [...new Set(topicIds)],
          domain: parseUrlDomain(resolvedUrl),
          sourceFamily,
          pageRole: classifyPageRole(resolvedUrl, sourceFamily),
          contentPreview,
          contentLength,
          sourceDepth: discovery.sourceDepth,
          discoveryMethod: discovery.discoveryMethod,
          parentSourceId: discovery.parentSourceId,
          parentResolvedUrl: discovery.parentResolvedUrl,
          lowQualityContent: quality.lowQuality ? true : undefined,
          offTopic: offTopic ? true : undefined,
          snippetMerged: snippetMerged ? true : undefined,
        };
        sourceRegistry.set(sourceRecord.id, sourceRecord);
        rememberSourceUrl(sourceIdByUrl, sourceRecord.requestedUrl, sourceRecord.id);
        rememberSourceUrl(sourceIdByUrl, sourceRecord.resolvedUrl, sourceRecord.id);
        return sourceRecord.id;
      };
      const registerSearchSnippetSource = (
        topicId: string,
        candidate: SearchSnippetSourceCandidate,
        fallbackFamily?: ResearchSourceFamily,
      ): string => {
        const existingSourceId = getRegisteredSourceId(sourceIdByUrl, candidate.url);
        if (existingSourceId) {
          const existing = sourceRegistry.get(existingSourceId);
          if (existing && !existing.topicIds.includes(topicId)) {
            existing.topicIds.push(topicId);
          }
          return existingSourceId;
        }
        sourceCounter += 1;
        const sourceFamily = classifySourceFamily(candidate.url, fallbackFamily ?? candidate.sourceFamily, {
          title: candidate.title,
          description: candidate.snippet,
        });
        const preview = [
          `Title: ${candidate.title}`,
          candidate.siteName ? `Site: ${candidate.siteName}` : "",
          `Query: ${candidate.query}`,
          `URL: ${candidate.url}`,
          candidate.snippet ? `Snippet: ${candidate.snippet}` : "",
          "",
          "This source was preserved from a discovery search result because the destination page could not be fetched directly during the run.",
        ]
          .filter(Boolean)
          .join("\n");
        const sourceRecord: ResearchSourceRecord = {
          id: `source-${sourceCounter}`,
          requestedUrl: candidate.url,
          resolvedUrl: candidate.url,
          title: candidate.title,
          description: candidate.snippet,
          kind: "search-result",
          extractedWith: "search-snippet",
          blockedLikely: true,
          fetchedAt: new Date().toISOString(),
          topicIds: [topicId],
          domain: parseUrlDomain(candidate.url),
          sourceFamily,
          pageRole: classifyPageRole(candidate.url, sourceFamily),
          contentPreview: preview,
          sourceDepth: 0,
          discoveryMethod: "search",
        };
        sourceRegistry.set(sourceRecord.id, sourceRecord);
        rememberSourceUrl(sourceIdByUrl, sourceRecord.requestedUrl, sourceRecord.id);
        rememberSourceUrl(sourceIdByUrl, sourceRecord.resolvedUrl, sourceRecord.id);
        return sourceRecord.id;
      };
      const writeSourceArtifacts = async (): Promise<void> => {
        await writeJson(path.join(runDirectory, "sources", "index.json"), [...sourceRegistry.values()]);
        await Promise.all(
          [...sourceRegistry.values()].map(async (source) =>
            await writeJson(path.join(runDirectory, "sources", `${source.id}.json`), source),
          ),
        );
      };
      const syncTopicArtifacts = async (): Promise<void> => {
        await Promise.all(
          plan.topics.map(async (topic) =>
            await writeJson(path.join(runDirectory, "topics", `${topic.id}.json`), {
              ...topic,
              discovery: discoveryByTopic.get(topic.id),
            }),
          ),
        );
      };
      const syncTopicStatuses = (): void => {
        for (const topicStatus of runState.topicStatuses) {
          const discovery = discoveryByTopic.get(topicStatus.topicId);
          if (!discovery) {
            continue;
          }
          topicStatus.searchCount = discovery.searches.length;
          topicStatus.searchErrorCount = discovery.searchErrors.length;
          topicStatus.fetchCount = discovery.fetchedSourceIds.length;
          topicStatus.fetchErrorCount = discovery.fetchErrors.length;
          topicStatus.sourceCount = discovery.fetchedSourceIds.length;
        }
        runState.coverage = buildCoverageSnapshot(coveragePlan, [...sourceRegistry.values()]);
        runState.gapsRemaining = latestAssessment?.gaps ?? runState.gapsRemaining;
      };

      const passRecords: ResearchPassRecord[] = [];
      for (let passNumber = 1; passNumber <= coveragePlan.maxPasses; passNumber += 1) {
        const passStartedAt = new Date().toISOString();
        runState.currentPass = passNumber;
        runState.passes = [
          ...(runState.passes ?? []),
          {
            passNumber,
            status: "running",
            startedAt: passStartedAt,
          },
        ];
        if (runState.stages.discovery.worker) {
          runState.stages.discovery.worker.currentAction = `Gather pass ${passNumber}`;
          runState.stages.discovery.worker.timeline = upsertResearchWorkerTimelineEntry(
            runState.stages.discovery.worker.timeline,
            {
              id: `discovery-pass-${passNumber}`,
              label: `Starting gather pass ${passNumber}`,
              timestamp: passStartedAt,
            },
          );
        }
        await writeState();

        const relevantTopicIds = new Set<string>(
          passNumber === 1 || !latestAssessment || passNumber <= minimumDiscoveryPasses
            ? plan.topics.map((topic) => topic.id)
            : [
              ...latestAssessment.missingTopicIds,
              ...coveragePlan.queryGroups
                .filter((group) => latestAssessment?.missingSourceFamilies.includes(group.sourceFamily))
                .map((group) => group.topicId),
            ],
        );
        const activeGroups = coveragePlan.queryGroups.filter((group) => relevantTopicIds.has(group.topicId));
        const searchTasks = activeGroups.flatMap((group) =>
          dedupeStrings(group.searchQueries).map((query, queryIndex) => ({
            key: `${passNumber}:${group.topicId}:${queryIndex}`,
            topicId: group.topicId,
            query,
            sourceFamily: group.sourceFamily,
            limit: normalizedOptions.profile === "quick" ? 4 : DEFAULT_SEARCH_RESULTS_PER_QUERY,
          })),
        );
        const searchResults = searchTasks.length > 0
          ? await executor.searchWebBatch(searchTasks, {
            signal: normalizedOptions.signal,
          })
          : [];

        type ResearchFetchTask = FetchUrlInput & {
          key: string;
          topicIds: Set<string>;
          sourceFamily: ResearchSourceFamily;
          sourceDepth: number;
          discoveryMethod: ResearchSourceRecord["discoveryMethod"];
          parentSourceId?: string;
          parentResolvedUrl?: string;
        };
        const queuedFetchTasks = new Map<string, ResearchFetchTask>();
        const searchSnippetCandidatesByUrl = new Map<string, SearchSnippetSourceCandidate>();
        const queueFetch = (
          topicId: string,
          url: string,
          sourceFamily: ResearchSourceFamily,
          candidate?: SearchSnippetSourceCandidate,
          discovery: {
            sourceDepth?: number;
            discoveryMethod?: ResearchSourceRecord["discoveryMethod"];
            parentSourceId?: string;
            parentResolvedUrl?: string;
          } = {},
        ): void => {
          const existingSourceId = getRegisteredSourceId(sourceIdByUrl, url);
          if (existingSourceId) {
            const existing = existingSourceId ? sourceRegistry.get(existingSourceId) : undefined;
            if (existing && !existing.topicIds.includes(topicId)) {
              existing.topicIds.push(topicId);
            }
            const discovery = discoveryByTopic.get(topicId);
            if (discovery && existingSourceId && !discovery.fetchedSourceIds.includes(existingSourceId)) {
              discovery.fetchedSourceIds.push(existingSourceId);
            }
            return;
          }
          const existingTask = queuedFetchTasks.get(url);
          if (existingTask) {
            existingTask.topicIds.add(topicId);
            if ((discovery.sourceDepth ?? 0) < existingTask.sourceDepth) {
              existingTask.sourceDepth = discovery.sourceDepth ?? 0;
              existingTask.discoveryMethod = discovery.discoveryMethod ?? existingTask.discoveryMethod;
              existingTask.parentSourceId = discovery.parentSourceId;
              existingTask.parentResolvedUrl = discovery.parentResolvedUrl;
            }
          } else {
            queuedFetchTasks.set(url, {
              key: `${passNumber}:${topicId}:${url}`,
              url,
              topicIds: new Set([topicId]),
              sourceFamily,
              sourceDepth: discovery.sourceDepth ?? 0,
              discoveryMethod: discovery.discoveryMethod ?? (candidate ? "search" : "seed"),
              parentSourceId: discovery.parentSourceId,
              parentResolvedUrl: discovery.parentResolvedUrl,
            });
          }
          if (candidate && !searchSnippetCandidatesByUrl.has(url)) {
            searchSnippetCandidatesByUrl.set(url, candidate);
          }
        };

        for (const group of activeGroups) {
          const discovery = discoveryByTopic.get(group.topicId);
          if (!discovery) {
            continue;
          }
          const seedQuota =
            group.sourceFamily === "mainstream_front_page"
              ? (normalizedOptions.profile === "deep" ? 8 : 4)
              : (normalizedOptions.profile === "deep" ? 3 : 2);
          const desiredSeedUrls = dedupeStrings(group.seedUrls).slice(0, seedQuota);
          discovery.seedUrls = dedupeStrings([...discovery.seedUrls, ...desiredSeedUrls]);
          for (const seedUrl of desiredSeedUrls) {
            queueFetch(group.topicId, seedUrl, group.sourceFamily);
          }
        }

        for (const [index, task] of searchTasks.entries()) {
          const discovery = discoveryByTopic.get(task.topicId);
          if (!discovery) {
            continue;
          }
          const result = successfulBatchResult(searchResults[index]!);
          if (!result) {
            discovery.searchErrors.push({
              passNumber,
              query: task.query,
              error: searchResults[index]?.error ?? "Search failed without an error message.",
            });
            continue;
          }
          discovery.searches.push({
            passNumber,
            query: task.query,
            result,
          });
          const topic = topicById.get(task.topicId);
          if (!topic) {
            continue;
          }
          const currentSourceCount = (discovery.fetchedSourceIds.length);
          const targetQuota = Math.max(
            1,
            coveragePlan.queryGroups.find((group) => group.topicId === task.topicId)?.targetSources
              ?? DEFAULT_FETCHES_PER_TOPIC,
          );
          const rankedResults = result.structuredOutput.results
            .map((entry) => ({
              topicId: task.topicId,
              query: task.query,
              title: entry.title,
              url: entry.url,
              snippet: entry.snippet,
              siteName: entry.siteName,
              sourceFamily: task.sourceFamily,
              passNumber,
            }))
            .sort((left, right) =>
              prioritizeSearchCandidate(topic, task.sourceFamily, right, [...sourceRegistry.values()])
              - prioritizeSearchCandidate(topic, task.sourceFamily, left, [...sourceRegistry.values()]),
            );
          for (const candidate of rankedResults.slice(0, Math.max(2, targetQuota - currentSourceCount + 1))) {
            queueFetch(task.topicId, candidate.url, task.sourceFamily, candidate);
          }
        }

        const fetchTaskEntries = [...queuedFetchTasks.values()];
        const fetchResults = fetchTaskEntries.length > 0
          ? await executor.fetchUrlBatch(fetchTaskEntries, {
            signal: normalizedOptions.signal,
          })
          : [];

        const applyFetchResults = (
          tasks: typeof fetchTaskEntries,
          results: typeof fetchResults,
        ): ResearchSourceRecord[] => {
          const registeredSources: ResearchSourceRecord[] = [];
          tasks.forEach((task, index) => {
            const fetchResult = successfulBatchResult(results[index]!);
            const topicIds = [...task.topicIds];
            if (!fetchResult) {
              for (const topicId of topicIds) {
                const discovery = discoveryByTopic.get(topicId);
                if (!discovery) {
                  continue;
                }
                discovery.fetchErrors.push({
                  passNumber,
                  url: task.url,
                  error: results[index]?.error ?? "Fetch failed without an error message.",
                });
                const topic = topicById.get(topicId);
                const searchSnippetCandidate = searchSnippetCandidatesByUrl.get(task.url);
                if (topic && searchSnippetCandidate && shouldPreserveBlockedSearchSnippet(topic, searchSnippetCandidate)) {
                  const sourceId = registerSearchSnippetSource(topicId, searchSnippetCandidate, task.sourceFamily);
                  const source = sourceRegistry.get(sourceId);
                  if (source) {
                    registeredSources.push(source);
                  }
                  if (!discovery.fetchedSourceIds.includes(sourceId)) {
                    discovery.fetchedSourceIds.push(sourceId);
                  }
                }
              }
              return;
            }
            const searchSnippetCandidate = searchSnippetCandidatesByUrl.get(task.url);
            const sourceId = registerFetchResult(topicIds, fetchResult, task.sourceFamily, searchSnippetCandidate, {
              sourceDepth: task.sourceDepth,
              discoveryMethod: task.discoveryMethod,
              parentSourceId: task.parentSourceId,
              parentResolvedUrl: task.parentResolvedUrl,
            });
            const source = sourceRegistry.get(sourceId);
            if (source) {
              registeredSources.push(source);
            }
            for (const topicId of topicIds) {
              const discovery = discoveryByTopic.get(topicId);
              if (discovery && !discovery.fetchedSourceIds.includes(sourceId)) {
                discovery.fetchedSourceIds.push(sourceId);
              }
            }
          });
          return registeredSources;
        };

        const firstWaveSources = applyFetchResults(fetchTaskEntries, fetchResults);
        const depthCandidatesByUrl = new Map<string, DepthScoutCandidate>();
        for (const source of firstWaveSources) {
          const sourceFamily = source.sourceFamily ?? "mainstream_article";
          for (const rawUrl of extractOneHopResearchUrlsFromSource(source, brief)) {
            const url = normalizeSourceLookupUrl(rawUrl) ?? rawUrl;
            if (getRegisteredSourceId(sourceIdByUrl, url) || queuedFetchTasks.has(url) || depthCandidatesByUrl.has(url)) {
              continue;
            }
            depthCandidatesByUrl.set(url, {
              id: `depth-${passNumber}-${depthCandidatesByUrl.size + 1}`,
              url,
              parentSourceId: source.id,
              parentTitle: source.title,
              parentResolvedUrl: source.resolvedUrl,
              topicIds: source.topicIds,
              sourceFamily,
              reason: `${source.id} exposed this linked detail page during first-wave fetch.`,
            });
          }
        }
        const depthCandidateLimit = normalizedOptions.profile === "quick" ? 12 : 40;
        const depthCandidates = [...depthCandidatesByUrl.values()].slice(0, depthCandidateLimit);
        let selectedDepthCandidates = depthCandidates;
        if (depthCandidates.length > 0) {
          runState.stage = "depth";
          markStageRunning("depth");
          runState.stages.depth.worker = {
            kind: "depth",
            label: "Source-depth scout",
            goal: "Select second-level source pages that contain concrete research data.",
            assistantDeltaCount: 0,
            reasoningDeltaCount: 0,
            lifecycleCount: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            searchCount: searchTasks.length,
            fetchCount: fetchTaskEntries.length,
            sourceCount: depthCandidates.length,
            timeline: [],
          };
          const shouldUseModelDepthScout =
            depthCandidates.length > 1
            && !(passNumber > 1 && latestAssessment?.sufficient === true);
          if (!shouldUseModelDepthScout) {
            const reason =
              passNumber > 1 && latestAssessment?.sufficient === true
                ? "Coverage was already sufficient before this follow-up pass."
                : "Candidate set was a single clear source-depth target.";
            runState.stages.depth.worker.currentAction = "Deterministic depth selection";
            runState.stages.depth.worker.resultSummary =
              `Queued ${selectedDepthCandidates.length}/${depthCandidates.length} second-level page${selectedDepthCandidates.length === 1 ? "" : "s"}. ${reason}`;
            runState.stages.depth.worker.sourceCount = selectedDepthCandidates.length;
            runState.stages.depth.worker.timeline = upsertResearchWorkerTimelineEntry(
              runState.stages.depth.worker.timeline,
              {
                id: `depth-deterministic-${passNumber}`,
                label: "Deterministic depth selection",
                detail: runState.stages.depth.worker.resultSummary,
                timestamp: new Date().toISOString(),
                tone: "success",
              },
            );
            markStageCompleted("depth");
            runState.stage = "discovery";
            await writeState();
          } else {
          const tracker = createActivityTracker("depth", passNumber, {
            label: "Source-depth scout",
            goal: "Select second-level source pages that contain concrete research data.",
            target: runState.stages.depth.worker,
          });
          const budgetGuard = createResearchSubsessionBudgetGuard("depth", {
            parentSignal: normalizedOptions.signal,
          });
          let completeDepthStage = true;
          await tracker.begin();
          try {
            const attemptResult = await this.runSubsession(
              {
                prompt: buildDepthScoutPrompt(brief, passNumber, depthCandidates),
                mode: "minimal",
                systemInstructions: [
                  "This is a focused source-depth scout for a deep research run.",
                  "Select only URLs from the provided candidate list.",
                  "Return compact structured JSON only.",
                ].join("\n"),
                responseFormat: makeStructuredResponseFormat(
                  "research_depth_selection",
                  {
                    selectedUrls: { type: "array", items: { type: "string" } },
                    rationale: { type: "string" },
                    openQuestions: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                  },
                  ["selectedUrls", "rationale"],
                ),
                maxSteps: 2,
                metadata: buildResearchSubsessionMetadata({
                  researchRunId: runId,
                  researchStage: "depth",
                  researchAttempt: passNumber,
                }),
                signal: budgetGuard.signal,
                onSessionStarted: async (info) => await tracker.onSessionStarted(info),
                onEvent: async (event) => {
                  await tracker.onEvent(event);
                  budgetGuard.onEvent(event);
                },
              },
              `research:${runId}:depth:${passNumber}`,
            );
            const selection = recoverDepthScoutRecord(attemptResult, depthCandidates);
            if (selection) {
              const selectedUrlSet = new Set(selection.selectedUrls);
              selectedDepthCandidates = depthCandidates.filter((candidate) => selectedUrlSet.has(candidate.url));
            }
            await tracker.complete(attemptResult, {
              resultSummary: selection
                ? `Selected ${selectedDepthCandidates.length}/${depthCandidates.length} second-level page${selectedDepthCandidates.length === 1 ? "" : "s"}. ${selection.rationale}`
                : `Depth scout returned no valid selection; falling back to ${selectedDepthCandidates.length} deterministic second-level page${selectedDepthCandidates.length === 1 ? "" : "s"}.`,
              searchCount: searchTasks.length,
              fetchCount: fetchTaskEntries.length,
              sourceCount: selectedDepthCandidates.length,
            });
            await persistSubsessionArtifacts(runDirectory, `workers/depth-pass-${passNumber}`, attemptResult);
          } catch (error) {
            const wrapped = budgetGuard.wrapError(error);
            if (normalizedOptions.signal?.aborted === true) {
              completeDepthStage = false;
              throw wrapped;
            }
            await tracker.update({
              currentAction: "Depth scout fell back to deterministic linked pages",
              resultSummary: wrapped instanceof Error ? wrapped.message : String(wrapped),
              sourceCount: selectedDepthCandidates.length,
            });
          } finally {
            budgetGuard.cleanup();
            await tracker.end();
            if (completeDepthStage) {
              markStageCompleted("depth");
              runState.stage = "discovery";
            } else {
              markStageFailed("depth");
            }
            await writeState();
          }
          }
        }
        const oneHopFetchTasks = new Map<string, {
          key: string;
          url: string;
          topicIds: Set<string>;
          sourceFamily: ResearchSourceFamily;
          sourceDepth: number;
          discoveryMethod: ResearchSourceRecord["discoveryMethod"];
          parentSourceId?: string;
          parentResolvedUrl?: string;
        }>();
        for (const candidate of selectedDepthCandidates) {
          oneHopFetchTasks.set(candidate.url, {
            key: `${passNumber}:one-hop:${candidate.parentSourceId}:${candidate.url}`,
            url: candidate.url,
            topicIds: new Set(candidate.topicIds),
            sourceFamily: candidate.sourceFamily,
            sourceDepth: 1,
            discoveryMethod: "one_hop",
            parentSourceId: candidate.parentSourceId,
            parentResolvedUrl: candidate.parentResolvedUrl,
          });
        }
        const oneHopFetchTaskEntries = [...oneHopFetchTasks.values()];
        if (oneHopFetchTaskEntries.length > 0) {
          if (runState.stages.discovery.worker) {
            runState.stages.discovery.worker.currentAction =
              `Pulling ${oneHopFetchTaskEntries.length} linked source page${oneHopFetchTaskEntries.length === 1 ? "" : "s"}`;
            runState.stages.discovery.worker.timeline = upsertResearchWorkerTimelineEntry(
              runState.stages.discovery.worker.timeline,
              {
                id: `discovery-one-hop-${passNumber}`,
                label: "Pulling linked source pages",
                detail: `${oneHopFetchTaskEntries.length} one-hop page${oneHopFetchTaskEntries.length === 1 ? "" : "s"} queued from first-wave sources.`,
                timestamp: new Date().toISOString(),
              },
            );
          }
          await writeState();
        }
        const oneHopFetchResults = oneHopFetchTaskEntries.length > 0
          ? await executor.fetchUrlBatch(oneHopFetchTaskEntries, {
            signal: normalizedOptions.signal,
          })
          : [];
        applyFetchResults(oneHopFetchTaskEntries, oneHopFetchResults);

        latestAssessment = buildCoverageAssessment(brief, coveragePlan, [...sourceRegistry.values()], passNumber);
        mergeCoverageFollowUps(coveragePlan, latestAssessment);
        const passCompletedAt = new Date().toISOString();
        const passRecord: ResearchPassRecord = {
          passNumber,
          startedAt: passStartedAt,
          completedAt: passCompletedAt,
          queryCount: searchTasks.length,
          fetchCount: fetchTaskEntries.length + oneHopFetchTaskEntries.length,
          fetchedSourceIds: [...new Set(activeGroups.flatMap((group) => discoveryByTopic.get(group.topicId)?.fetchedSourceIds ?? []))],
          searchErrors: activeGroups.reduce((sum, group) => sum + (discoveryByTopic.get(group.topicId)?.searchErrors.filter((entry) => entry.passNumber === passNumber).length ?? 0), 0),
          fetchErrors: activeGroups.reduce((sum, group) => sum + (discoveryByTopic.get(group.topicId)?.fetchErrors.filter((entry) => entry.passNumber === passNumber).length ?? 0), 0),
          sourceCount: sourceRegistry.size,
          domainCount: new Set(
            [...sourceRegistry.values()]
              .map((source) => source.domain)
              .filter((value): value is string => Boolean(value)),
          ).size,
          summary: latestAssessment.summary,
          gaps: latestAssessment.gaps,
        };
        passRecords.push(passRecord);
        runState.passCount = passRecords.length;
        runState.passes = (runState.passes ?? []).map((pass) =>
          pass.passNumber === passNumber
            ? {
              ...pass,
              status: "completed",
              completedAt: passCompletedAt,
              summary: passRecord.summary,
              queryCount: passRecord.queryCount,
              fetchCount: passRecord.fetchCount,
              sourceCount: passRecord.sourceCount,
              gaps: passRecord.gaps,
            }
            : pass,
        );
        if (runState.stages.discovery.worker) {
          runState.stages.discovery.worker.searchCount = searchTasks.length;
          runState.stages.discovery.worker.fetchCount = fetchTaskEntries.length + oneHopFetchTaskEntries.length;
          runState.stages.discovery.worker.sourceCount = sourceRegistry.size;
          runState.stages.discovery.worker.currentAction = latestAssessment.sufficient
            ? "Coverage looks sufficient"
            : `Coverage gap check after pass ${passNumber}`;
          runState.stages.discovery.worker.timeline = upsertResearchWorkerTimelineEntry(
            runState.stages.discovery.worker.timeline,
            {
              id: `coverage-check-${passNumber}`,
              label: latestAssessment.summary,
              detail: latestAssessment.gaps.slice(0, 2).join(" "),
              timestamp: passCompletedAt,
              tone: latestAssessment.sufficient ? "success" : "warning",
            },
          );
        }

        syncTopicStatuses();
        await writeSourceArtifacts();
        await syncTopicArtifacts();
        await writeJson(path.join(runDirectory, "passes", `pass-${passNumber}.json`), {
          ...passRecord,
          coverage: runState.coverage,
          gapsRemaining: latestAssessment.gaps,
        });
        await writeJson(path.join(runDirectory, "coverage-assessment.json"), {
          passNumber,
          summary: latestAssessment.summary,
          sufficient: latestAssessment.sufficient,
          gaps: latestAssessment.gaps,
          missingSourceFamilies: latestAssessment.missingSourceFamilies,
          missingTopicIds: latestAssessment.missingTopicIds,
          targetDomainGap: latestAssessment.targetDomainGap,
        });
        await writeState();

        const qualityGap = latestAssessment.gaps.some((gap) =>
          /low-quality|off-topic|subpages not yet enumerated/i.test(gap),
        );
        const forceExtraPass =
          passNumber === 1
          && qualityGap
          && passNumber < coveragePlan.maxPasses
          && normalizedOptions.profile !== "quick";
        if (
          latestAssessment.sufficient
          && passNumber >= minimumDiscoveryPasses
          && !forceExtraPass
        ) {
          break;
        }
      }

      syncTopicStatuses();
      await writeSourceArtifacts();
      await syncTopicArtifacts();
      const missingSearchConfiguration = [...discoveryByTopic.values()].some((discovery) =>
        discovery.searchErrors.some((entry) => isMissingSearchConfigurationError(entry.error)),
      );
      if (missingSearchConfiguration && latestAssessment && !latestAssessment.sufficient) {
        const coverageSummary = latestAssessment.gaps.slice(0, 4).join(" ");
        throw new GemmaDesktopError(
          "tool_execution_failed",
          [
            "Web search is unavailable because no Gemini API key is configured.",
            "Deep research needs search to find current sources beyond the built-in seed pages.",
            coverageSummary ? `Coverage remained insufficient: ${coverageSummary}` : "",
            "Open Gemma Desktop -> Settings -> Integrations and add a Gemini API key, then rerun the research.",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      const evidenceCardArtifacts = plan.topics.map((topic) => {
        const discovery = discoveryByTopic.get(topic.id);
        const topicSources = (discovery?.fetchedSourceIds ?? [])
          .map((sourceId) => sourceRegistry.get(sourceId))
          .filter((source): source is ResearchSourceRecord => Boolean(source));
        const cards = buildResearchEvidenceCards(brief, topic, topicSources);
        return {
          topicId: topic.id,
          title: topic.title,
          sourceCount: topicSources.length,
          cardCount: cards.length,
          cards,
        };
      });
      await writeJson(path.join(runDirectory, "evidence-cards", "index.json"), {
        generatedAt: new Date().toISOString(),
        topicCardLimit: TOPIC_EVIDENCE_CARD_LIMIT,
        topics: evidenceCardArtifacts,
      });
      await Promise.all(
        evidenceCardArtifacts.map((artifact) =>
          writeJson(path.join(runDirectory, "evidence-cards", `${artifact.topicId}.json`), artifact),
        ),
      );
      markStageCompleted("discovery");
      if (runState.stages.depth.status === "pending") {
        markStageCompleted("depth");
      }
      runState.stage = "workers";
      markStageRunning("workers");
      await writeState();

      const dossiers = new Array<ResearchDossier>(plan.topics.length);
      const sortedTopics = [...plan.topics].sort((left, right) => topicSortValue(left) - topicSortValue(right));
      const topicIndexById = new Map(plan.topics.map((topic, index) => [topic.id, index]));
      const sourcesById = sourceRegistry;
      const writeDossierArtifacts = async (
        topic: ResearchTopicPlan,
        dossier: ResearchDossier,
      ): Promise<void> => {
        await writeJson(path.join(runDirectory, "dossiers", `${topic.id}.json`), dossier);
        await writeText(
          path.join(runDirectory, "dossiers", `${topic.id}.md`),
          [
            `# ${topic.title}`,
            "",
            dossier.summary,
            dossier.findings.length > 0 ? ["", "## Findings", "", ...dossier.findings.map((finding) => `- ${finding}`)].join("\n") : "",
            dossier.contradictions.length > 0
              ? ["", "## Contradictions", "", ...dossier.contradictions.map((entry) => `- ${entry}`)].join("\n")
              : "",
            dossier.openQuestions.length > 0
              ? ["", "## Open Questions", "", ...dossier.openQuestions.map((entry) => `- ${entry}`)].join("\n")
              : "",
            dossier.sourceIds.length > 0 ? ["", "## Source IDs", "", ...dossier.sourceIds.map((entry) => `- ${entry}`)].join("\n") : "",
            dossier.unresolvedSourceRefs.length > 0
              ? ["", "## Unresolved Source Refs", "", ...dossier.unresolvedSourceRefs.map((entry) => `- ${entry}`)].join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      };

      await runWithConcurrency(
        sortedTopics,
        normalizedOptions.maxConcurrentModelWorkers,
        async (topic) => {
          const stateEntry = runState.topicStatuses.find((entry) => entry.topicId === topic.id);
          if (stateEntry) {
            stateEntry.status = "running";
            stateEntry.startedAt ??= new Date().toISOString();
            delete stateEntry.completedAt;
            delete stateEntry.lastError;
            stateEntry.worker = {
              kind: "topic",
              label: brief.taskType === "news-sweep" ? "Source-bundle analyst" : "Topic worker",
              goal: topic.goal,
              assistantDeltaCount: 0,
              reasoningDeltaCount: 0,
              lifecycleCount: 0,
              toolCallCount: 0,
              toolResultCount: 0,
              searchCount: stateEntry.searchCount,
              fetchCount: stateEntry.fetchCount,
              sourceCount: stateEntry.sourceCount,
              timeline: [],
            };
          }
          await writeState();

          try {
            const discovery = discoveryByTopic.get(topic.id) ?? {
              searches: [],
              seedUrls: [],
              fetchedSourceIds: [],
              searchErrors: [],
              fetchErrors: [],
            };
            if (brief.taskType === "news-sweep") {
              const prefetchedSources = discovery.fetchedSourceIds
                .map((sourceId) => sourcesById.get(sourceId))
                .filter((source): source is ResearchSourceRecord => Boolean(source));
              const usablePrefetchedSources = selectNewsDossierSources(topic, prefetchedSources);
              const sourceChunks = chunkArray(
                usablePrefetchedSources.length > 0 ? usablePrefetchedSources : prefetchedSources.filter((source) => isUsableResearchSource(source)),
                NEWS_COLLECTOR_SOURCE_CHUNK_SIZE,
              );
              const chunkDossiers: ResearchDossier[] = [];
              for (const [chunkIndex, sourceChunk] of sourceChunks.entries()) {
                const chunkNumber = chunkIndex + 1;
                const tracker = createActivityTracker("topic", chunkNumber, {
                  topic,
                  label: "Source collector",
                  goal: `Summarize source bundle ${chunkNumber} of ${sourceChunks.length} for ${topic.title}.`,
                  target: stateEntry?.worker,
                });
                const budgetGuard = createResearchSubsessionBudgetGuard("topic", {
                  parentSignal: normalizedOptions.signal,
                  topicTitle: `${topic.title} bundle ${chunkNumber}`,
                });
                await tracker.begin();
                await tracker.update({
                  currentAction: `Summarizing source bundle ${chunkNumber}/${sourceChunks.length}`,
                  searchCount: discovery.searches.length,
                  fetchCount: discovery.fetchedSourceIds.length,
                  sourceCount: sourceChunk.length,
                });
                try {
                  const chunkDiscovery: DiscoveryRecord = {
                    ...discovery,
                    searches: discovery.searches.slice(0, 4),
                    fetchedSourceIds: sourceChunk.map((source) => source.id),
                  };
                  const attemptResult = await this.runSubsession(
                    {
                      prompt: buildWorkerPrompt(
                        brief,
                        topic,
                        chunkDiscovery,
                        sourceChunk,
                        1,
                        {
                          discardedSourceCount: Math.max(0, prefetchedSources.length - usablePrefetchedSources.length),
                        },
                      ),
                      mode: "minimal",
                      systemInstructions: [
                        "This is a focused source-bundle analyst for a deep research run.",
                        "Use only the evidence bundle in the user prompt.",
                        "Do not call tools.",
                        "Return a compact structured dossier only.",
                      ].join("\n"),
                      responseFormat: makeStructuredResponseFormat(
                        "research_source_bundle",
                        {
                          summary: { type: "string" },
                          findings: { type: "array", items: { type: "string" } },
                          contradictions: { type: "array", items: { type: "string" } },
                          openQuestions: { type: "array", items: { type: "string" } },
                          sourceRefs: { type: "array", items: { type: "string" } },
                          confidence: { type: "number" },
                        },
                        ["summary"],
                      ),
                      maxSteps: 2,
                      metadata: buildResearchSubsessionMetadata({
                        researchRunId: runId,
                        researchStage: "topic",
                        researchTopicId: topic.id,
                        researchAttempt: chunkNumber,
                      }),
                      signal: budgetGuard.signal,
                      onSessionStarted: async (info) => await tracker.onSessionStarted(info),
                      onEvent: async (event) => {
                        await tracker.onEvent(event);
                        budgetGuard.onEvent(event);
                      },
                    },
                    `research:${runId}:topic:${topic.id}:bundle:${chunkNumber}`,
                  );
                  const rawDossier = extractStructuredObjectCandidate(attemptResult) ?? {};
                  const candidateDossier = normalizeDossierRecord(rawDossier);
                  const candidateSourceIds = new Set<string>();
                  const candidateUnresolvedSourceRefs = new Set<string>();
                  if (candidateDossier) {
                    for (const sourceRef of candidateDossier.sourceRefs) {
                      const normalized = normalizeSourceRef(sourceRef, sourcesById, sourceIdByUrl);
                      if (normalized.sourceId) {
                        candidateSourceIds.add(normalized.sourceId);
                      }
                      if (normalized.unresolved) {
                        candidateUnresolvedSourceRefs.add(normalized.unresolved);
                      }
                    }
                  }
                  const fallbackSourceIds = sourceChunk.map((source) => source.id);
                  const chunkDossier: ResearchDossier = candidateDossier
                    ? {
                        id: `${topic.id}-bundle-${chunkNumber}-dossier`,
                        topicId: topic.id,
                        title: `${topic.title} bundle ${chunkNumber}`,
                        summary: candidateDossier.summary,
                        findings: candidateDossier.findings,
                        contradictions: candidateDossier.contradictions,
                        openQuestions: candidateDossier.openQuestions,
                        sourceIds: candidateSourceIds.size > 0 ? [...candidateSourceIds] : fallbackSourceIds,
                        unresolvedSourceRefs: [...candidateUnresolvedSourceRefs],
                        confidence: candidateDossier.confidence,
                        workerSessionId: attemptResult.sessionId,
                      }
                    : buildSourceBackedResearchDossier(runId, topic, sourceChunk);
                  chunkDossiers.push(chunkDossier);
                  await tracker.complete(attemptResult, {
                    resultSummary: chunkDossier.summary,
                    searchCount: discovery.searches.length,
                    fetchCount: discovery.fetchedSourceIds.length,
                    sourceCount: chunkDossier.sourceIds.length,
                  });
                  await persistSubsessionArtifacts(
                    runDirectory,
                    path.join("workers", `${topic.id}-bundle-${chunkNumber}`),
                    attemptResult,
                  );
                } catch (error) {
                  const wrapped = budgetGuard.wrapError(error);
                  const fallbackDossier = buildSourceBackedResearchDossier(runId, topic, sourceChunk);
                  chunkDossiers.push({
                    ...fallbackDossier,
                    id: `${topic.id}-bundle-${chunkNumber}-dossier`,
                    title: `${topic.title} bundle ${chunkNumber}`,
                    openQuestions: [
                      ...fallbackDossier.openQuestions,
                      `Source-bundle analyst failed: ${wrapped instanceof Error ? wrapped.message : String(wrapped)}`,
                    ],
                  });
                  await tracker.update({
                    currentAction: `Source bundle ${chunkNumber} fell back to source extraction`,
                    resultSummary: wrapped instanceof Error ? wrapped.message : String(wrapped),
                    sourceCount: sourceChunk.length,
                  });
                } finally {
                  budgetGuard.cleanup();
                  await tracker.end();
                }
              }
              const fallbackDossier =
                chunkDossiers.length > 0
                  ? undefined
                  : buildSourceBackedResearchDossier(runId, topic, prefetchedSources);
              const sourceIds = [
                ...new Set((fallbackDossier ? [fallbackDossier] : chunkDossiers).flatMap((dossier) => dossier.sourceIds)),
              ];
              const dossier: ResearchDossier = fallbackDossier ?? {
                id: `${topic.id}-dossier`,
                topicId: topic.id,
                title: topic.title,
                summary: chunkDossiers
                  .map((entry) => entry.summary)
                  .filter(Boolean)
                  .slice(0, 4)
                  .join(" "),
                findings: chunkDossiers.flatMap((entry) => entry.findings).slice(0, 18),
                contradictions: chunkDossiers.flatMap((entry) => entry.contradictions).slice(0, 8),
                openQuestions: chunkDossiers.flatMap((entry) => entry.openQuestions).slice(0, 8),
                sourceIds,
                unresolvedSourceRefs: [
                  ...new Set(chunkDossiers.flatMap((entry) => entry.unresolvedSourceRefs)),
                ],
                confidence:
                  chunkDossiers.length > 0
                    ? chunkDossiers.reduce((sum, entry) => sum + entry.confidence, 0) / chunkDossiers.length
                    : 0.2,
                workerSessionId: `source-bundles:${runId}:${topic.id}`,
              };
              const dossierIndex = topicIndexById.get(topic.id);
              if (dossierIndex === undefined) {
                throw new GemmaDesktopError("runtime_unavailable", `Missing dossier index for topic ${topic.id}.`);
              }
              dossiers[dossierIndex] = dossier;
              await writeDossierArtifacts(topic, dossier);
              if (stateEntry) {
                stateEntry.status = "completed";
                stateEntry.completedAt = new Date().toISOString();
                stateEntry.summary = dossier.summary;
                stateEntry.sourceCount = dossier.sourceIds.length;
                if (stateEntry.worker) {
                  stateEntry.worker.currentAction = "Source bundles summarized";
                  stateEntry.worker.sourceCount = dossier.sourceIds.length;
                  stateEntry.worker.resultSummary = dossier.summary;
                  stateEntry.worker.timeline = upsertResearchWorkerTimelineEntry(
                    stateEntry.worker.timeline,
                    {
                      id: `${topic.id}-source-bundles`,
                      label: "Source bundles summarized",
                      detail: dossier.summary,
                      timestamp: new Date().toISOString(),
                      tone: dossier.sourceIds.length > 0 ? "success" : "warning",
                    },
                  );
                }
              }
              await writeState();
              return;
            }
            let workerResult: ToolSubsessionResult | undefined;
            let normalizedDossier: NormalizedDossierRecord | undefined;
            let sourceIds = new Set<string>();
            let unresolvedSourceRefs = new Set<string>();
            let workerFailureMessage = `Topic worker "${topic.id}" did not produce a valid dossier.`;

            for (let attempt = 1; attempt <= MAX_TOPIC_WORKER_ATTEMPTS; attempt += 1) {
              const tracker = createActivityTracker("topic", attempt, {
                topic,
                label: "Topic worker",
                goal: topic.goal,
                target: stateEntry?.worker,
              });
              const budgetGuard = createResearchSubsessionBudgetGuard("topic", {
                parentSignal: normalizedOptions.signal,
                topicTitle: topic.title,
              });
              await tracker.begin();
              await tracker.update({
                searchCount: discovery.searches.length,
                fetchCount: discovery.fetchedSourceIds.length,
                sourceCount: discovery.fetchedSourceIds.length,
              });
              const prefetchedSources = discovery.fetchedSourceIds
                .map((sourceId) => sourcesById.get(sourceId))
                .filter((source): source is ResearchSourceRecord => Boolean(source));
              const usablePrefetchedSources = prefetchedSources
                .filter((source) => isUsableResearchSource(source));
              const discardedPrefetchedSourceCount = prefetchedSources.length - usablePrefetchedSources.length;

              let attemptResult: ToolSubsessionResult;
              try {
                attemptResult = await this.runSubsession(
                  {
                    prompt: buildWorkerPrompt(
                      brief,
                      topic,
                      discovery,
                      usablePrefetchedSources,
                      attempt,
                      {
                        discardedSourceCount: discardedPrefetchedSourceCount,
                      },
                    ),
                    mode: "minimal",
                    systemInstructions: [
                      "This is a focused topic evidence analyst.",
                      "Use only the evidence bundle in the user prompt.",
                      "Do not call tools.",
                      "Return a compact structured dossier only.",
                    ].join("\n"),
                    responseFormat: makeStructuredResponseFormat(
                      "research_dossier",
                      {
                        summary: { type: "string" },
                        findings: { type: "array", items: { type: "string" } },
                        contradictions: { type: "array", items: { type: "string" } },
                        openQuestions: { type: "array", items: { type: "string" } },
                        sourceRefs: { type: "array", items: { type: "string" } },
                        confidence: { type: "number" },
                      },
                      ["summary"],
                    ),
                    maxSteps: normalizedOptions.profile === "quick" ? 2 : 3,
                    metadata: buildResearchSubsessionMetadata({
                      researchRunId: runId,
                      researchStage: "topic",
                      researchTopicId: topic.id,
                      researchAttempt: attempt,
                    }),
                    signal: budgetGuard.signal,
                    onSessionStarted: async (info) => await tracker.onSessionStarted(info),
                    onEvent: async (event) => {
                      await tracker.onEvent(event);
                      budgetGuard.onEvent(event);
                    },
                  },
                  `research:${runId}:topic:${topic.id}`,
                );

                await writeJson(path.join(runDirectory, "topics", `${topic.id}.json`), {
                  ...topic,
                  discovery,
                });
                if (stateEntry) {
                  stateEntry.fetchCount = discovery.fetchedSourceIds.length;
                  stateEntry.fetchErrorCount = discovery.fetchErrors.length;
                  stateEntry.sourceCount = discovery.fetchedSourceIds.length;
                }
                await tracker.update({
                  searchCount: discovery.searches.length,
                  fetchCount: discovery.fetchedSourceIds.length,
                  sourceCount: discovery.fetchedSourceIds.length,
                });

                const rawDossier = extractStructuredObjectCandidate(attemptResult) ?? {};
                const candidateDossier = normalizeDossierRecord(rawDossier);
                const candidateSourceIds = new Set<string>();
                const candidateUnresolvedSourceRefs = new Set<string>();

                if (candidateDossier) {
                  for (const sourceRef of candidateDossier.sourceRefs) {
                    const normalized = normalizeSourceRef(sourceRef, sourcesById, sourceIdByUrl);
                    if (normalized.sourceId) {
                      candidateSourceIds.add(normalized.sourceId);
                    }
                    if (normalized.unresolved) {
                      candidateUnresolvedSourceRefs.add(normalized.unresolved);
                    }
                  }
                }

                const missingFetchedCitations =
                  usablePrefetchedSources.length > 0
                  && candidateSourceIds.size === 0
                  && candidateUnresolvedSourceRefs.size === 0;

                if (!candidateDossier) {
                  workerFailureMessage = `Topic worker "${topic.id}" returned malformed dossier output.`;
                } else if (candidateSourceIds.size === 0 && candidateUnresolvedSourceRefs.size > 0) {
                  workerFailureMessage =
                    `Topic worker "${topic.id}" cited URLs without fetching them in this run: ${[...candidateUnresolvedSourceRefs].join(", ")}`;
                } else if (missingFetchedCitations && dossierStatesEvidenceIsAbsent(candidateDossier)) {
                  const fallbackSourceIds = selectFallbackCitationSourceIds(topic, usablePrefetchedSources);
                  if (fallbackSourceIds.length > 0) {
                    workerResult = attemptResult;
                    normalizedDossier = candidateDossier;
                    sourceIds = new Set(fallbackSourceIds);
                    unresolvedSourceRefs = candidateUnresolvedSourceRefs;
                    await tracker.complete(attemptResult, {
                      resultSummary: `${candidateDossier.summary} Recovered citations from usable evidence.`,
                      searchCount: discovery.searches.length,
                      fetchCount: discovery.fetchedSourceIds.length,
                      sourceCount: fallbackSourceIds.length,
                    });
                    break;
                  }
                  workerFailureMessage = `Topic worker "${topic.id}" did not cite any usable prefetched sources.`;
                } else if (missingFetchedCitations) {
                  workerFailureMessage = `Topic worker "${topic.id}" did not cite any usable prefetched sources.`;
                } else {
                  workerResult = attemptResult;
                  normalizedDossier = candidateDossier;
                  sourceIds = candidateSourceIds;
                  unresolvedSourceRefs = candidateUnresolvedSourceRefs;
                  await tracker.complete(attemptResult, {
                    resultSummary: candidateDossier.summary,
                    searchCount: discovery.searches.length,
                    fetchCount: discovery.fetchedSourceIds.length,
                    sourceCount: candidateSourceIds.size,
                  });
                  break;
                }

                await tracker.complete(attemptResult, {
                  resultSummary: workerFailureMessage,
                  searchCount: discovery.searches.length,
                  fetchCount: discovery.fetchedSourceIds.length,
                  sourceCount: candidateSourceIds.size,
                });
                const attemptArtifactPath =
                  attempt < MAX_TOPIC_WORKER_ATTEMPTS
                    ? path.join("workers", `${topic.id}-attempt-${attempt}`)
                    : path.join("workers", topic.id);
                await persistSubsessionArtifacts(runDirectory, attemptArtifactPath, attemptResult);
              } catch (error) {
                const wrapped = budgetGuard.wrapError(error);
                workerFailureMessage = wrapped instanceof Error ? wrapped.message : String(wrapped);
                await tracker.update({
                  currentAction: `Topic worker attempt ${attempt} failed`,
                  resultSummary: workerFailureMessage,
                  searchCount: discovery.searches.length,
                  fetchCount: discovery.fetchedSourceIds.length,
                  sourceCount: discovery.fetchedSourceIds.length,
                });
                if (normalizedOptions.signal?.aborted === true) {
                  throw wrapped;
                }
                if (isStructuredOutputBudgetFailure(workerFailureMessage)) {
                  await tracker.update({
                    currentAction: "Source-backed topic fallback scheduled",
                    resultSummary: workerFailureMessage,
                    searchCount: discovery.searches.length,
                    fetchCount: discovery.fetchedSourceIds.length,
                    sourceCount: discovery.fetchedSourceIds.length,
                  });
                  break;
                }
              } finally {
                budgetGuard.cleanup();
                await tracker.end();
              }
            }

            if (!workerResult || !normalizedDossier) {
              if (/cited URLs without fetching them/i.test(workerFailureMessage)) {
                throw new GemmaDesktopError("tool_execution_failed", workerFailureMessage);
              }
              const fallbackSources = discovery.fetchedSourceIds
                .map((sourceId) => sourcesById.get(sourceId))
                .filter((source): source is ResearchSourceRecord => Boolean(source))
                .filter((source) => isUsableResearchSource(source));
              const fallbackDossier = buildSourceBackedResearchDossier(
                runId,
                topic,
                fallbackSources,
                [workerFailureMessage],
              );
              const dossierIndex = topicIndexById.get(topic.id);
              if (dossierIndex === undefined) {
                throw new GemmaDesktopError("runtime_unavailable", `Missing dossier index for topic ${topic.id}.`);
              }
              dossiers[dossierIndex] = fallbackDossier;
              await writeJson(path.join(runDirectory, "topics", `${topic.id}.json`), {
                ...topic,
                discovery,
              });
              await writeDossierArtifacts(topic, fallbackDossier);
              if (stateEntry) {
                stateEntry.status = "completed";
                stateEntry.completedAt = new Date().toISOString();
                stateEntry.summary = fallbackDossier.summary;
                stateEntry.sourceCount = fallbackDossier.sourceIds.length;
                if (stateEntry.worker) {
                  stateEntry.worker.currentAction = "Source-backed dossier used";
                  stateEntry.worker.sourceCount = fallbackDossier.sourceIds.length;
                  stateEntry.worker.resultSummary = fallbackDossier.summary;
                  stateEntry.worker.timeline = upsertResearchWorkerTimelineEntry(
                    stateEntry.worker.timeline,
                    {
                      id: `${topic.id}-source-backed-fallback`,
                      label: "Source-backed dossier used",
                      detail: workerFailureMessage,
                      timestamp: new Date().toISOString(),
                      tone: "warning",
                    },
                  );
                }
              }
              await writeState();
              return;
            }

            await persistSubsessionArtifacts(runDirectory, path.join("workers", topic.id), workerResult);

            const dossier: ResearchDossier = {
              id: `${topic.id}-dossier`,
              topicId: topic.id,
              title: topic.title,
              summary: normalizedDossier.summary,
              findings: normalizedDossier.findings,
              contradictions: normalizedDossier.contradictions,
              openQuestions: normalizedDossier.openQuestions,
              sourceIds: [...sourceIds],
              unresolvedSourceRefs: [...unresolvedSourceRefs],
              confidence: normalizedDossier.confidence,
              workerSessionId: workerResult.sessionId,
            };

            const dossierIndex = topicIndexById.get(topic.id);
            if (dossierIndex === undefined) {
              throw new GemmaDesktopError("runtime_unavailable", `Missing dossier index for topic ${topic.id}.`);
            }
            dossiers[dossierIndex] = dossier;

            await writeDossierArtifacts(topic, dossier);

            if (stateEntry) {
              stateEntry.status = "completed";
              stateEntry.completedAt = new Date().toISOString();
              stateEntry.summary = dossier.summary;
              stateEntry.sourceCount = dossier.sourceIds.length;
              if (stateEntry.worker) {
                stateEntry.worker.sourceCount = dossier.sourceIds.length;
                stateEntry.worker.resultSummary = dossier.summary;
              }
            }
            await writeState();
          } catch (error) {
            if (stateEntry) {
              stateEntry.status = "failed";
              stateEntry.completedAt = new Date().toISOString();
              stateEntry.lastError = error instanceof Error ? error.message : String(error);
            }
            await writeState();
            throw error;
          }
        },
      );

      await writeJson(path.join(runDirectory, "sources", "index.json"), [...sourceRegistry.values()]);
      await Promise.all(
        [...sourceRegistry.values()].map(async (source) =>
          await writeJson(path.join(runDirectory, "sources", `${source.id}.json`), source),
        ),
      );

      markStageCompleted("workers");
      runState.stage = "synthesis";
      markStageRunning("synthesis");
      await writeState();

      const synthesisResponseFormat = makeStructuredResponseFormat(
        "research_synthesis",
        {
          summary: { type: "string" },
          reportMarkdown: { type: "string" },
          openQuestions: { type: "array", items: { type: "string" } },
          sourceIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        ["summary", "reportMarkdown"],
      );

      let synthesisResult: ToolSubsessionResult | undefined;
      let finalSynthesis: FinalSynthesisRecord | undefined;
      let finalSelfCheck: SynthesisSelfCheckRecord | undefined;
      let synthesisRetryIssues: string[] = [];
      let synthesisFailureMessage: string | undefined;
      runState.stages.synthesis.worker = {
        kind: "synthesis",
        label: "Research coordinator",
        goal: "Synthesize the final research report.",
        assistantDeltaCount: 0,
        reasoningDeltaCount: 0,
        lifecycleCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        timeline: [],
      };
      for (const attempt of [1, 2]) {
        const tracker = createActivityTracker("synthesis", attempt, {
          label: "Research coordinator",
          goal: "Synthesize the final research report.",
          target: runState.stages.synthesis.worker,
        });
        const budgetGuard = createResearchSubsessionBudgetGuard("synthesis", {
          parentSignal: normalizedOptions.signal,
        });
        await tracker.begin();
        let attemptResult: ToolSubsessionResult;
        try {
          attemptResult = await this.runSubsession(
            {
              prompt: buildSynthesisPrompt(
                brief,
                plan,
                dossiers,
                [...sourceRegistry.values()],
                attempt,
                synthesisRetryIssues,
              ),
              mode: "minimal",
              systemInstructions: RESEARCH_REPORT_FORMATTING_RULES,
              responseFormat: synthesisResponseFormat,
              maxSteps: normalizedOptions.profile === "quick" ? 3 : 4,
              metadata: buildResearchSubsessionMetadata({
                researchRunId: runId,
                researchStage: "synthesis",
                researchAttempt: attempt,
              }),
              signal: budgetGuard.signal,
              onSessionStarted: async (info) => await tracker.onSessionStarted(info),
              onEvent: async (event) => {
                await tracker.onEvent(event);
                budgetGuard.onEvent(event);
              },
            },
            `research:${runId}:synthesis`,
          );

          const candidateRecord = extractStructuredObjectCandidate(attemptResult);
          const normalizedSynthesis =
            candidateRecord
              ? normalizeFinalSynthesisRecord(candidateRecord)
              : undefined;
          if (normalizedSynthesis) {
            const selfCheckRecord = buildHeuristicSynthesisSelfCheckRecord(
              brief,
              normalizedSynthesis,
              [...sourceRegistry.values()],
            );
            await writeJson(
              path.join(runDirectory, "final", `self-check-attempt-${attempt}.json`),
              selfCheckRecord,
            );
            if (selfCheckRecord?.needsRetry && attempt < 2) {
              synthesisRetryIssues = selfCheckRecord.issues;
              await tracker.complete(attemptResult, {
                resultSummary: selfCheckRecord.issues.join(" | ") || "Synthesis self-check requested a retry.",
              });
              continue;
            }
            synthesisResult = attemptResult;
            finalSynthesis = normalizedSynthesis;
            finalSelfCheck = selfCheckRecord;
            await tracker.complete(attemptResult, {
              resultSummary: [
                normalizedSynthesis.summary,
                selfCheckRecord && selfCheckRecord.issues.length > 0
                  ? `Self-check: ${selfCheckRecord.issues.join(" | ")}`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
              sourceCount: normalizedSynthesis.sourceIds.length,
            });
            await persistSubsessionArtifacts(runDirectory, "workers/coordinator-synthesis", attemptResult);
            break;
          }

          await tracker.complete(attemptResult, {
            resultSummary: "Synthesis attempt completed without a valid final report.",
          });
          synthesisFailureMessage = "Synthesis attempt completed without a valid final report.";
          synthesisRetryIssues = [synthesisFailureMessage];
          await persistSubsessionArtifacts(
            runDirectory,
            `workers/coordinator-synthesis-attempt-${attempt}`,
            attemptResult,
          );
        } catch (error) {
          const wrapped = budgetGuard.wrapError(error);
          if (normalizedOptions.signal?.aborted === true) {
            throw wrapped;
          }
          synthesisFailureMessage = wrapped instanceof Error ? wrapped.message : String(wrapped);
          synthesisRetryIssues = [synthesisFailureMessage];
          await tracker.update({
            currentAction: "Source-backed synthesis fallback scheduled",
            resultSummary: synthesisFailureMessage,
          });
          if (attempt < 2 && !isStructuredOutputBudgetFailure(synthesisFailureMessage)) {
            continue;
          }
          break;
        } finally {
          budgetGuard.cleanup();
          await tracker.end();
        }
      }

      if (!synthesisResult || !finalSynthesis) {
        const fallbackIssue =
          synthesisFailureMessage ?? "Synthesis did not produce a valid final report after retry.";
        const warning = formatCriticalResearchWarning(fallbackIssue);
        runState.warnings = dedupeStrings([...(runState.warnings ?? []), warning]);
        finalSynthesis = buildSourceBackedFinalSynthesis(brief, plan, dossiers, [...sourceRegistry.values()], {
          fallbackIssues: [fallbackIssue],
          gapsRemaining: runState.gapsRemaining,
        });
        finalSelfCheck = {
          ok: false,
          issues: [fallbackIssue],
          needsRetry: false,
        };
        synthesisResult = {
          sessionId: `source-backed:${runId}:synthesis`,
          turnId: `source-backed:${runId}:synthesis`,
          events: [],
          outputText: finalSynthesis.summary,
          structuredOutput: finalSynthesis,
        };
        if (runState.stages.synthesis.worker) {
          runState.stages.synthesis.worker.currentAction = "Source-backed synthesis used";
          runState.stages.synthesis.worker.resultSummary = warning;
          runState.stages.synthesis.worker.sourceCount = finalSynthesis.sourceIds.length;
          runState.stages.synthesis.worker.timeline = upsertResearchWorkerTimelineEntry(
            runState.stages.synthesis.worker.timeline,
            {
              id: "source-backed-synthesis-fallback",
              label: "Source-backed synthesis used",
              detail: warning,
              timestamp: new Date().toISOString(),
              tone: "warning",
            },
          );
        }
        await writeState();
      }

      const finalSourceIds =
        finalSynthesis.sourceIds.length > 0
          ? finalSynthesis.sourceIds
          : [...new Set(dossiers.flatMap((dossier) => dossier.sourceIds))];
      const enhancedReportMarkdown = enhanceReportWithSourceLinks(
        finalSynthesis.reportMarkdown,
        [...sourceRegistry.values()],
        finalSourceIds,
      );
      finalSynthesis = {
        ...finalSynthesis,
        reportMarkdown: enhancedReportMarkdown,
      };
      const persistedFinalSynthesis: FinalSynthesisRecord = {
        ...finalSynthesis,
        sourceIds: finalSourceIds,
      };

      await writeJson(path.join(runDirectory, "final", "report.json"), persistedFinalSynthesis);
      await writeJson(
        path.join(runDirectory, "final", "self-check.json"),
        finalSelfCheck ?? {
          ok: true,
          issues: [],
          needsRetry: false,
        },
      );
      await writeText(path.join(runDirectory, "final", "report.md"), finalSynthesis.reportMarkdown);
      await writeText(
        path.join(runDirectory, "trace.txt"),
        [
          "# Coordinator Plan",
          "",
          renderTrace(plannerResult.events),
          "",
          ...plan.topics.flatMap((topic) => {
            const workerTrace = dossiers[topicIndexById.get(topic.id) ?? -1];
            if (!workerTrace) {
              return [];
            }
            return [
              `# Worker ${topic.id}`,
              "",
              `Session: ${workerTrace.workerSessionId}`,
              "",
            ];
          }),
          "# Coordinator Synthesis",
          "",
          renderTrace(synthesisResult.events),
        ].join("\n"),
      );

      runState.status = "completed";
      runState.stage = "completed";
      runState.completedAt = new Date().toISOString();
      markStageCompleted("synthesis");
      await writeState();

      return {
        runId,
        profile: normalizedOptions.profile,
        artifactDirectory: runDirectory,
        runtimeId: this.snapshot.runtimeId,
        modelId: this.snapshot.modelId,
        plan,
        sources: [...sourceRegistry.values()],
        dossiers,
        finalReport: finalSynthesis.reportMarkdown,
        summary: finalSynthesis.summary,
        sourceIds: finalSourceIds,
        confidence: finalSynthesis.confidence,
        completedAt: runState.completedAt,
        taskType: brief.taskType,
        passCount: runState.passCount,
        coverage: runState.coverage,
        gapsRemaining: runState.gapsRemaining,
        sourceFamilies: runState.sourceFamilies,
        warnings: runState.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runState.stage === "planning") {
        markStageFailed("planning");
      } else if (runState.stage === "discovery") {
        markStageFailed("discovery");
      } else if (runState.stage === "depth") {
        markStageFailed("depth");
      } else if (runState.stage === "workers") {
        markStageFailed("workers");
      } else if (runState.stage === "synthesis") {
        markStageFailed("synthesis");
      }
      runState.status = "failed";
      runState.stage = "failed";
      runState.completedAt = new Date().toISOString();
      runState.error = message;
      await writeState();
      throw error;
    }
  }
}
