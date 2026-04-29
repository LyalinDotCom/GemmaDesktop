import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { ModeSelection, ShellCommandResult, ToolResult } from "./runtime.js";

export const FINALIZE_BUILD_TOOL_NAME = "finalize_build";

export type BuildCompletionVerifierMode = "hybrid" | "deterministic" | "off";

export interface BuildTurnPolicy {
  samplingTurns: number;
  requireVerificationAfterMutation: boolean;
  requireFinalizationAfterMutation: boolean;
  completionVerifier: BuildCompletionVerifierMode;
  verificationContinuationLimit: number;
  finalizationContinuationLimit: number;
  verifierAttemptLimit: number;
}

export interface BuildTurnPolicyInput {
  samplingTurns?: number;
  requireVerificationAfterMutation?: boolean;
  requireFinalizationAfterMutation?: boolean;
  completionVerifier?: BuildCompletionVerifierMode;
  verificationContinuationLimit?: number;
  finalizationContinuationLimit?: number;
  verifierAttemptLimit?: number;
}

export interface BuildMutationRecord {
  sequence: number;
  toolName: string;
  paths: string[];
}

export interface BuildCommandExecutionRecord extends ShellCommandResult {
  sequence: number;
  toolName: string;
}

export interface BuildFinalizationValidationItem {
  command: string;
  status: "passed" | "failed" | "blocked";
  notes?: string;
}

export interface BuildFinalizationRecord {
  sequence: number;
  toolName: string;
  summary: string;
  artifacts: string[];
  validation: BuildFinalizationValidationItem[];
  localUrl?: string;
  browserVerified?: boolean;
  instructionChecklist: string[];
  blockers: string[];
  raw: Record<string, unknown>;
}

export interface BuildBrowserEvidenceRecord {
  sequence: number;
  toolName: string;
  url?: string;
  status?: string;
  readyState?: string;
  matchCount?: number;
  errorCount?: number;
  consoleErrorCount?: number;
  timedOut?: boolean;
  lastError?: string;
}

export interface BuildTurnState {
  enabled: boolean;
  canRunCommands: boolean;
  canFinalize: boolean;
  userGoal: string;
  mutations: BuildMutationRecord[];
  commandExecutions: BuildCommandExecutionRecord[];
  finalizations: BuildFinalizationRecord[];
  browserEvidence: BuildBrowserEvidenceRecord[];
  nextSequence: number;
}

export interface BuildVerificationPlan {
  commands: string[];
  rationale: string;
}

export interface BuildValidationStatus {
  attempted: boolean;
  passed: boolean;
  changedPaths: string[];
  latestAttempt?: BuildCommandExecutionRecord;
  latestBrowserEvidence?: BuildBrowserEvidenceRecord;
  recommendedCommands: string[];
  rationale: string;
}

export interface BuildFinalizationStatus {
  attempted: boolean;
  passed: boolean;
  latestFinalization?: BuildFinalizationRecord;
  issues: string[];
}

export interface BuildCompletionVerifierInput {
  userGoal: string;
  workingDirectory: string;
  changedPaths: string[];
  validationStatus?: BuildValidationStatus;
  finalization?: BuildFinalizationRecord;
  browserEvidence: BuildBrowserEvidenceRecord[];
}

export interface BuildCompletionVerifierResult {
  ok: boolean;
  issues: string[];
  retryInstruction?: string;
  metadata?: Record<string, unknown>;
}

export type BuildCompletionVerifier = (
  input: BuildCompletionVerifierInput,
) => Promise<BuildCompletionVerifierResult> | BuildCompletionVerifierResult;

export interface BuildTurnSummary {
  policy: BuildTurnPolicy;
  changedPaths: string[];
  verification?: BuildValidationStatus;
  finalization?: BuildFinalizationStatus;
  verifier?: BuildCompletionVerifierResult;
  browserEvidence: BuildBrowserEvidenceRecord[];
}

export const DEFAULT_BUILD_TURN_POLICY: BuildTurnPolicy = {
  samplingTurns: 30,
  requireVerificationAfterMutation: true,
  requireFinalizationAfterMutation: false,
  completionVerifier: "off",
  verificationContinuationLimit: 3,
  finalizationContinuationLimit: 3,
  verifierAttemptLimit: 2,
};

const NODE_SCRIPT_PRIORITY = [
  "check",
  "build",
  "test",
  "typecheck",
  "lint",
  "verify",
] as const;

const GENERIC_VERIFICATION_PATTERNS = [
  /\b(?:npm|pnpm)\s+run\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\b(?:npm|pnpm)\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\b(?:npm|pnpm)\s+run\s+(?:dev|start|serve|preview)\b/i,
  /\byarn\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\byarn\s+(?:dev|start|serve|preview)\b/i,
  /\bbun\s+run\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\bbun\s+run\s+(?:dev|start|serve|preview)\b/i,
  /\bxmllint\b/i,
  /\bnode\b[^\n;&|]*\b(?:validate|verify|check|test|lint)[\w.-]*(?:\.(?:cjs|js|mjs|ts))?\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bpython(?:3)?\s+-m\s+pytest\b/i,
  /\bpython(?:3)?\s+-m\s+compileall\b/i,
  /\btsc(?:\s|$)/i,
  /\beslint\b/i,
  /\bruff\s+check\b/i,
  /\bmypy\b/i,
  /\bcargo\s+(?:test|check)\b/i,
  /\bgo\s+test\b/i,
  /\bvite\s+build\b/i,
  /\bnext\s+build\b/i,
];

const BLOCKER_PATTERNS = [
  /\bblocked\b/i,
  /\bblocker\b/i,
  /\bcannot\b/i,
  /\bcan't\b/i,
  /\bcould not\b/i,
  /\bcouldn't\b/i,
  /\bmissing\b/i,
  /\bnot installed\b/i,
  /\bunavailable\b/i,
  /\bpermission\b/i,
  /\btimed out\b/i,
];

const BLOCKER_CONTEXT_PATTERNS = [
  /\bverify\b/i,
  /\bverification\b/i,
  /\bbuild\b/i,
  /\btest\b/i,
  /\bcheck\b/i,
  /\bcommand\b/i,
  /\bdependency\b/i,
  /\bscript\b/i,
  /\btool\b/i,
  /\binstall\b/i,
  /\bruntime\b/i,
];

const SHELL_MUTATION_PATH_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function resolveModeBase(mode: ModeSelection): string {
  return typeof mode === "string" ? mode : mode.base ?? "explore";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: Iterable<string>): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }
  return [...deduped];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function resolveBuildTurnPolicy(
  input: BuildTurnPolicyInput | undefined,
): BuildTurnPolicy {
  const completionVerifier =
    input?.completionVerifier === "deterministic"
    || input?.completionVerifier === "off"
    || input?.completionVerifier === "hybrid"
      ? input.completionVerifier
      : DEFAULT_BUILD_TURN_POLICY.completionVerifier;

  return {
    samplingTurns: normalizePositiveInteger(
      input?.samplingTurns,
      DEFAULT_BUILD_TURN_POLICY.samplingTurns,
    ),
    requireVerificationAfterMutation:
      input?.requireVerificationAfterMutation
      ?? DEFAULT_BUILD_TURN_POLICY.requireVerificationAfterMutation,
    requireFinalizationAfterMutation:
      input?.requireFinalizationAfterMutation
      ?? DEFAULT_BUILD_TURN_POLICY.requireFinalizationAfterMutation,
    completionVerifier,
    verificationContinuationLimit: normalizePositiveInteger(
      input?.verificationContinuationLimit,
      DEFAULT_BUILD_TURN_POLICY.verificationContinuationLimit,
    ),
    finalizationContinuationLimit: normalizePositiveInteger(
      input?.finalizationContinuationLimit,
      DEFAULT_BUILD_TURN_POLICY.finalizationContinuationLimit,
    ),
    verifierAttemptLimit: normalizePositiveInteger(
      input?.verifierAttemptLimit,
      DEFAULT_BUILD_TURN_POLICY.verifierAttemptLimit,
    ),
  };
}

function nextSequence(state: BuildTurnState): number {
  state.nextSequence += 1;
  return state.nextSequence;
}

function coercePath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isShellCommandResult(value: unknown): value is ShellCommandResult {
  return (
    isRecord(value)
    && typeof value.command === "string"
    && (typeof value.exitCode === "number" || value.exitCode === null)
    && typeof value.stdout === "string"
    && typeof value.stderr === "string"
    && typeof value.timedOut === "boolean"
  );
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueStrings(value.filter((entry): entry is string => typeof entry === "string"));
}

function coerceFinalizationValidation(value: unknown): BuildFinalizationValidationItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((entry) => {
      const command = typeof entry.command === "string" ? entry.command.trim() : "";
      const status =
        entry.status === "passed" || entry.status === "failed" || entry.status === "blocked"
          ? entry.status
          : undefined;
      const notes =
        typeof entry.notes === "string" && entry.notes.trim().length > 0
          ? entry.notes.trim()
          : undefined;
      return command && status
        ? {
            command,
            status,
            ...(notes ? { notes } : {}),
          }
        : undefined;
    })
    .filter((entry): entry is BuildFinalizationValidationItem => Boolean(entry));
}

function extractBuildFinalizationRecord(
  state: BuildTurnState,
  toolResult: ToolResult,
): BuildFinalizationRecord | undefined {
  if (toolResult.toolName !== FINALIZE_BUILD_TOOL_NAME || !isRecord(toolResult.structuredOutput)) {
    return undefined;
  }

  const record = toolResult.structuredOutput;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const localUrl =
    typeof record.localUrl === "string" && record.localUrl.trim().length > 0
      ? record.localUrl.trim()
      : undefined;

  return {
    sequence: nextSequence(state),
    toolName: toolResult.toolName,
    summary,
    artifacts: coerceStringArray(record.artifacts),
    validation: coerceFinalizationValidation(record.validation),
    ...(localUrl ? { localUrl } : {}),
    ...(typeof record.browserVerified === "boolean" ? { browserVerified: record.browserVerified } : {}),
    instructionChecklist: coerceStringArray(record.instructionChecklist),
    blockers: coerceStringArray(record.blockers),
    raw: record,
  };
}

function extractBrowserEvidenceRecord(
  state: BuildTurnState,
  toolResult: ToolResult,
): BuildBrowserEvidenceRecord | undefined {
  if (
    toolResult.toolName !== "open_project_browser"
    && toolResult.toolName !== "search_project_browser_dom"
    && toolResult.toolName !== "get_project_browser_errors"
    && toolResult.toolName !== "browser"
  ) {
    return undefined;
  }

  const structured = isRecord(toolResult.structuredOutput)
    ? toolResult.structuredOutput
    : {};
  const url =
    typeof structured.url === "string" && structured.url.trim().length > 0
      ? structured.url.trim()
      : typeof structured.currentUrl === "string" && structured.currentUrl.trim().length > 0
        ? structured.currentUrl.trim()
        : undefined;
  const status =
    typeof structured.status === "string" && structured.status.trim().length > 0
      ? structured.status.trim()
      : undefined;
  const readyState =
    typeof structured.readyState === "string" && structured.readyState.trim().length > 0
      ? structured.readyState.trim()
      : undefined;
  const matches = Array.isArray(structured.matches) ? structured.matches : undefined;
  const errors = Array.isArray(structured.errors) ? structured.errors : undefined;
  const consoleErrorCount =
    typeof structured.consoleErrorCount === "number"
      ? structured.consoleErrorCount
      : undefined;
  const timedOut =
    typeof structured.timedOut === "boolean"
      ? structured.timedOut
      : undefined;
  const lastError =
    typeof structured.lastError === "string" && structured.lastError.trim().length > 0
      ? structured.lastError.trim()
      : undefined;

  return {
    sequence: nextSequence(state),
    toolName: toolResult.toolName,
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    ...(readyState ? { readyState } : {}),
    ...(matches ? { matchCount: matches.length } : {}),
    ...(errors ? { errorCount: errors.length } : {}),
    ...(typeof consoleErrorCount === "number" ? { consoleErrorCount } : {}),
    ...(typeof timedOut === "boolean" ? { timedOut } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function extractMutationPaths(toolResult: ToolResult): string[] {
  if (!toolResult.structuredOutput || !isRecord(toolResult.structuredOutput)) {
    return [];
  }

  const record = toolResult.structuredOutput;
  switch (toolResult.toolName) {
    case "write_file": {
      const resolvedPath = coercePath(record.path);
      return resolvedPath ? [resolvedPath] : [];
    }
    case "edit_file": {
      const replacements =
        typeof record.replacements === "number"
          ? record.replacements
          : undefined;
      if (record.staleTarget === true || replacements === 0) {
        return [];
      }
      const resolvedPath = coercePath(record.path);
      return resolvedPath ? [resolvedPath] : [];
    }
    case "workspace_editor_agent": {
      const appliedWrites = Array.isArray(record.appliedWrites)
        ? record.appliedWrites
        : [];
      return uniqueStrings(
        appliedWrites
          .filter(isRecord)
          .map((write) => coercePath(write.path))
          .filter((candidate): candidate is string => typeof candidate === "string"),
      );
    }
    case "exec_command": {
      return isShellCommandResult(record)
        ? extractShellCommandMutationPaths(record.command)
        : [];
    }
    case "workspace_command_agent": {
      const executions = Array.isArray(record.executions)
        ? record.executions
        : [];
      return uniqueStrings(
        executions
          .filter(isShellCommandResult)
          .flatMap((execution) => extractShellCommandMutationPaths(execution.command)),
      );
    }
    default:
      return [];
  }
}

function normalizeShellMutationPath(candidatePath: string): string | undefined {
  const trimmed = candidatePath.trim();
  if (
    trimmed.length === 0
    || trimmed.startsWith("-")
    || trimmed.includes("$")
    || trimmed.includes("*")
  ) {
    return undefined;
  }

  const extension = path.extname(trimmed).toLowerCase();
  if (!SHELL_MUTATION_PATH_EXTENSIONS.has(extension)) {
    return undefined;
  }

  return trimmed;
}

function collectShellCommandPathMatches(command: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of command.matchAll(pattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeShellMutationPath(candidate);
    if (normalized) {
      matches.push(normalized);
    }
  }
  return matches;
}

function extractShellCommandMutationPaths(command: string): string[] {
  return uniqueStrings([
    ...collectShellCommandPathMatches(command, /(?:>|>>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g),
    ...collectShellCommandPathMatches(command, /\btee(?:\s+-a)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g),
  ]);
}

function extractCommandExecutions(toolResult: ToolResult): BuildCommandExecutionRecord[] {
  if (toolResult.toolName === "exec_command" && isShellCommandResult(toolResult.structuredOutput)) {
    return [
      {
        ...toolResult.structuredOutput,
        sequence: 0,
        toolName: toolResult.toolName,
      },
    ];
  }

  if (
    toolResult.toolName === "workspace_command_agent"
    && isRecord(toolResult.structuredOutput)
    && Array.isArray(toolResult.structuredOutput.executions)
  ) {
    return toolResult.structuredOutput.executions
      .filter(isShellCommandResult)
      .map((execution) => ({
        ...execution,
        sequence: 0,
        toolName: toolResult.toolName,
      }));
  }

  if (
    toolResult.toolName === "peek_background_process"
    && isRecord(toolResult.structuredOutput)
    && typeof toolResult.structuredOutput.command === "string"
    && typeof toolResult.structuredOutput.output === "string"
  ) {
    const status =
      typeof toolResult.structuredOutput.status === "string"
        ? toolResult.structuredOutput.status
        : undefined;
    const exitCode =
      typeof toolResult.structuredOutput.exitCode === "number"
        ? toolResult.structuredOutput.exitCode
        : status === "running"
          ? 0
          : null;
    return [
      {
        command: toolResult.structuredOutput.command,
        exitCode,
        stdout: toolResult.structuredOutput.output,
        stderr: "",
        timedOut: false,
        sequence: 0,
        toolName: toolResult.toolName,
      },
    ];
  }

  return [];
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function looksLikeVerificationCommand(
  command: string,
  recommendedCommands: readonly string[],
): boolean {
  const normalized = normalizeCommand(command);

  if (
    recommendedCommands.some((candidate) =>
      normalized.includes(normalizeCommand(candidate)),
    )
  ) {
    return true;
  }

  return GENERIC_VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

function commandsReferToSameValidation(claimedCommand: string, observedCommand: string): boolean {
  const claimed = normalizeCommand(claimedCommand);
  const observed = normalizeCommand(observedCommand);
  return claimed.length > 0 && observed.length > 0 && (
    claimed === observed
    || claimed.includes(observed)
    || observed.includes(claimed)
  );
}

function browserEvidenceHasFailure(evidence: BuildBrowserEvidenceRecord): boolean {
  return (
    evidence.timedOut === true
    || Boolean(evidence.lastError)
    || (typeof evidence.consoleErrorCount === "number" && evidence.consoleErrorCount > 0)
    || (typeof evidence.errorCount === "number" && evidence.errorCount > 0)
  );
}

function isPassingBrowserEvidence(evidence: BuildBrowserEvidenceRecord): boolean {
  if (browserEvidenceHasFailure(evidence)) {
    return false;
  }

  const readyState = evidence.readyState?.toLowerCase();
  if (readyState && readyState !== "complete" && readyState !== "interactive") {
    return false;
  }

  if (evidence.toolName === "open_project_browser") {
    return (
      readyState === "complete"
      && typeof evidence.consoleErrorCount === "number"
      && evidence.consoleErrorCount === 0
    );
  }

  if (evidence.toolName === "get_project_browser_errors") {
    return typeof evidence.errorCount === "number" && evidence.errorCount === 0;
  }

  if (evidence.toolName === "search_project_browser_dom") {
    return typeof evidence.matchCount === "number" && evidence.matchCount > 0;
  }

  return false;
}

function validationClaimMatchesBrowserEvidence(
  claimedCommand: string,
  evidence: BuildBrowserEvidenceRecord,
): boolean {
  const claimed = normalizeCommand(claimedCommand);
  if (!claimed) {
    return false;
  }

  const url = evidence.url ? normalizeCommand(evidence.url) : "";
  return (
    claimed.includes("browser")
    || claimed.includes(normalizeCommand(evidence.toolName))
    || (url.length > 0 && (claimed.includes(url) || url.includes(claimed)))
  );
}

function finalizationListsObservedPassingValidation(
  state: BuildTurnState,
  finalization: BuildFinalizationRecord,
  latestMutationSequence: number,
): boolean {
  const claimedPassingCommands = finalization.validation
    .filter((item) => item.status === "passed")
    .map((item) => item.command);
  if (claimedPassingCommands.length === 0) {
    return false;
  }

  const observedPassingCommands = state.commandExecutions
    .filter((execution) =>
      execution.sequence > latestMutationSequence
      && execution.exitCode === 0
      && execution.timedOut === false
    )
    .map((execution) => execution.command);

  return claimedPassingCommands.some((claimedCommand) =>
    observedPassingCommands.some((observedCommand) =>
      commandsReferToSameValidation(claimedCommand, observedCommand)
    )
    || state.browserEvidence
      .filter((evidence) =>
        evidence.sequence > latestMutationSequence
        && isPassingBrowserEvidence(evidence)
      )
      .some((evidence) => validationClaimMatchesBrowserEvidence(claimedCommand, evidence))
  );
}

function formatPackageManagerRunCommand(
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  scriptName: string,
): string {
  switch (packageManager) {
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "npm":
    default:
      return `npm run ${scriptName}`;
  }
}

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function prefixCommandForDirectory(
  workingDirectory: string,
  packageDirectory: string,
  command: string,
): string {
  const relative = path.relative(workingDirectory, packageDirectory);
  if (!relative) {
    return command;
  }
  return `cd ${quoteShellToken(relative)} && ${command}`;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function collectCandidatePackageDirectories(
  workingDirectory: string,
  candidatePaths: readonly string[],
): string[] {
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const directories = new Set<string>([resolvedWorkingDirectory]);

  for (const candidatePath of candidatePaths) {
    const resolvedPath = path.resolve(
      path.isAbsolute(candidatePath)
        ? candidatePath
        : path.join(resolvedWorkingDirectory, candidatePath),
    );
    const relativeToWorkingDirectory = path.relative(resolvedWorkingDirectory, resolvedPath);
    if (
      relativeToWorkingDirectory.startsWith("..")
      || path.isAbsolute(relativeToWorkingDirectory)
    ) {
      continue;
    }

    let directory =
      path.basename(resolvedPath) === "package.json"
        ? path.dirname(resolvedPath)
        : path.dirname(resolvedPath);

    while (true) {
      directories.add(directory);
      if (directory === resolvedWorkingDirectory) {
        break;
      }
      const parent = path.dirname(directory);
      const relativeParent = path.relative(resolvedWorkingDirectory, parent);
      if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
        break;
      }
      directory = parent;
    }
  }

  return [...directories];
}

async function detectNodeVerificationPlan(
  workingDirectory: string,
  candidatePaths: readonly string[],
): Promise<BuildVerificationPlan | undefined> {
  const candidateDirectories = collectCandidatePackageDirectories(
    workingDirectory,
    candidatePaths,
  );

  for (const packageDirectory of candidateDirectories) {
    const plan = await detectNodeVerificationPlanInDirectory(
      workingDirectory,
      packageDirectory,
    );
    if (plan) {
      return plan;
    }
  }

  return undefined;
}

function resolveCandidatePathInsideWorkspace(
  workingDirectory: string,
  candidatePath: string,
): string | undefined {
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const resolvedPath = path.resolve(
    path.isAbsolute(candidatePath)
      ? candidatePath
      : path.join(resolvedWorkingDirectory, candidatePath),
  );
  const relative = path.relative(resolvedWorkingDirectory, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function isSvgPath(candidatePath: string): boolean {
  return path.extname(candidatePath).toLowerCase() === ".svg";
}

function detectSvgVerificationPlan(
  workingDirectory: string,
  candidatePaths: readonly string[],
): BuildVerificationPlan | undefined {
  const svgPaths = uniqueStrings(
    candidatePaths
      .filter(isSvgPath)
      .map((candidatePath) =>
        resolveCandidatePathInsideWorkspace(workingDirectory, candidatePath))
      .filter((candidatePath): candidatePath is string => typeof candidatePath === "string"),
  );

  if (svgPaths.length === 0) {
    return undefined;
  }

  return {
    commands: [`xmllint --noout ${svgPaths.map(quoteShellToken).join(" ")}`],
    rationale:
      svgPaths.length === 1
        ? "Detected a generated SVG artifact and selected XML parser validation so malformed markup is caught before completion."
        : "Detected generated SVG artifacts and selected XML parser validation so malformed markup is caught before completion.",
  };
}

async function detectNodeVerificationPlanInDirectory(
  workingDirectory: string,
  packageDirectory: string,
): Promise<BuildVerificationPlan | undefined> {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return undefined;
  }

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      commands: [],
      rationale: "A package.json file exists, but it could not be parsed to determine verification scripts.",
    };
  }

  const packageManagerField =
    typeof parsed.packageManager === "string" ? parsed.packageManager : undefined;
  const packageManagerFromField =
    packageManagerField?.startsWith("pnpm@") ? "pnpm"
    : packageManagerField?.startsWith("yarn@") ? "yarn"
    : packageManagerField?.startsWith("bun@") ? "bun"
    : packageManagerField?.startsWith("npm@") ? "npm"
    : undefined;
  const hasPnpmLock = await fileExists(path.join(packageDirectory, "pnpm-lock.yaml"));
  const hasYarnLock = await fileExists(path.join(packageDirectory, "yarn.lock"));
  const hasBunLock =
    await fileExists(path.join(packageDirectory, "bun.lockb"))
    || await fileExists(path.join(packageDirectory, "bun.lock"));
  const packageManager =
    packageManagerFromField
    ?? (hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasBunLock ? "bun" : "npm");

  const scripts = isRecord(parsed.scripts) ? parsed.scripts : undefined;
  const availableScripts = scripts
    ? NODE_SCRIPT_PRIORITY.filter((name) => typeof scripts[name] === "string")
    : [];

  if (availableScripts.length === 0) {
    return {
      commands: [],
      rationale: "A Node workspace was detected, but package.json does not declare build, check, test, typecheck, lint, or verify scripts.",
    };
  }

  const commands =
    availableScripts.includes("check")
      ? [prefixCommandForDirectory(
          workingDirectory,
          packageDirectory,
          formatPackageManagerRunCommand(packageManager, "check"),
        )]
      : availableScripts
          .slice(0, 2)
          .map((scriptName) => prefixCommandForDirectory(
            workingDirectory,
            packageDirectory,
            formatPackageManagerRunCommand(packageManager, scriptName),
          ));

  return {
    commands,
    rationale:
      packageDirectory === workingDirectory
        ? "Detected a Node-style workspace from package.json and selected its strongest available verification scripts."
        : `Detected a nested Node-style workspace at ${path.relative(workingDirectory, packageDirectory)} and selected its strongest available verification scripts.`,
  };
}

async function detectRustVerificationPlan(workingDirectory: string): Promise<BuildVerificationPlan | undefined> {
  if (!(await fileExists(path.join(workingDirectory, "Cargo.toml")))) {
    return undefined;
  }

  return {
    commands: ["cargo check"],
    rationale: "Detected a Rust workspace from Cargo.toml and selected cargo check as the default verifier.",
  };
}

async function detectGoVerificationPlan(workingDirectory: string): Promise<BuildVerificationPlan | undefined> {
  if (!(await fileExists(path.join(workingDirectory, "go.mod")))) {
    return undefined;
  }

  return {
    commands: ["go test ./..."],
    rationale: "Detected a Go workspace from go.mod and selected go test ./... as the default verifier.",
  };
}

async function detectPythonVerificationPlan(workingDirectory: string): Promise<BuildVerificationPlan | undefined> {
  const pythonManifestPaths = [
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.py",
    "setup.cfg",
  ].map((entry) => path.join(workingDirectory, entry));
  const hasPythonManifest = await Promise.all(pythonManifestPaths.map(fileExists))
    .then((results) => results.some(Boolean));
  if (!hasPythonManifest) {
    return undefined;
  }

  const hasTests = await Promise.all([
    fileExists(path.join(workingDirectory, "tests")),
    fileExists(path.join(workingDirectory, "pytest.ini")),
    fileExists(path.join(workingDirectory, "tox.ini")),
  ]).then((results) => results.some(Boolean));

  return {
    commands: [hasTests ? "pytest" : "python -m compileall ."],
    rationale: "Detected a Python workspace from standard manifests and selected a basic verifier.",
  };
}

export function createBuildTurnState(
  mode: ModeSelection,
  availableTools: readonly string[],
  userGoal = "",
): BuildTurnState | undefined {
  if (resolveModeBase(mode) !== "build") {
    return undefined;
  }

  return {
    enabled: true,
    canRunCommands:
      availableTools.includes("exec_command")
      || availableTools.includes("workspace_command_agent"),
    canFinalize: availableTools.includes(FINALIZE_BUILD_TOOL_NAME),
    userGoal,
    mutations: [],
    commandExecutions: [],
    finalizations: [],
    browserEvidence: [],
    nextSequence: 0,
  };
}

export function recordBuildToolResult(
  state: BuildTurnState | undefined,
  toolResult: ToolResult,
): void {
  if (!state?.enabled) {
    return;
  }

  const finalization = extractBuildFinalizationRecord(state, toolResult);
  if (finalization) {
    state.finalizations.push(finalization);
    return;
  }

  const browserEvidence = extractBrowserEvidenceRecord(state, toolResult);
  if (browserEvidence) {
    state.browserEvidence.push(browserEvidence);
  }

  const mutationPaths = extractMutationPaths(toolResult);
  if (mutationPaths.length > 0) {
    state.mutations.push({
      sequence: nextSequence(state),
      toolName: toolResult.toolName,
      paths: mutationPaths,
    });
  }

  const commandExecutions = extractCommandExecutions(toolResult);
  for (const execution of commandExecutions) {
    state.commandExecutions.push({
      ...execution,
      sequence: nextSequence(state),
    });
  }
}

export async function planBuildVerification(
  workingDirectory: string,
  candidatePaths: readonly string[] = [],
): Promise<BuildVerificationPlan> {
  const nodePlan = await detectNodeVerificationPlan(workingDirectory, candidatePaths);
  if (nodePlan) {
    return nodePlan;
  }

  const svgPlan = detectSvgVerificationPlan(workingDirectory, candidatePaths);
  if (svgPlan) {
    return svgPlan;
  }

  const detectors = [
    detectRustVerificationPlan,
    detectGoVerificationPlan,
    detectPythonVerificationPlan,
  ];

  for (const detect of detectors) {
    const plan = await detect(workingDirectory);
    if (plan) {
      return plan;
    }
  }

  return {
    commands: [],
    rationale: "No standard project manifest was detected, so verification must be chosen from the actual workspace context.",
  };
}

export function summarizeBuildValidation(
  state: BuildTurnState | undefined,
  plan: BuildVerificationPlan,
): BuildValidationStatus | undefined {
  if (!state?.enabled || state.mutations.length === 0) {
    return undefined;
  }

  const latestMutationSequence = state.mutations[state.mutations.length - 1]?.sequence ?? 0;
  const changedPaths = uniqueStrings(state.mutations.flatMap((mutation) => mutation.paths));
  const attempts = state.commandExecutions.filter((execution) =>
    execution.sequence > latestMutationSequence
    && looksLikeVerificationCommand(execution.command, plan.commands),
  );
  const browserAttempts = state.browserEvidence.filter((evidence) =>
    evidence.sequence > latestMutationSequence
    && (
      isPassingBrowserEvidence(evidence)
      || browserEvidenceHasFailure(evidence)
    )
  );
  const latestAttempt = attempts.at(-1);
  const latestBrowserEvidence = browserAttempts.at(-1);
  const commandPassed = Boolean(
    latestAttempt
    && latestAttempt.exitCode === 0
    && latestAttempt.timedOut === false,
  );
  const browserPassed = Boolean(
    latestBrowserEvidence
    && isPassingBrowserEvidence(latestBrowserEvidence),
  );

  return {
    attempted: attempts.length > 0 || browserAttempts.length > 0,
    passed: commandPassed || browserPassed,
    changedPaths,
    ...(latestAttempt ? { latestAttempt } : {}),
    ...(latestBrowserEvidence ? { latestBrowserEvidence } : {}),
    recommendedCommands: plan.commands,
    rationale: plan.rationale,
  };
}

export function summarizeBuildFinalization(
  state: BuildTurnState | undefined,
  validationStatus: BuildValidationStatus | undefined,
): BuildFinalizationStatus | undefined {
  if (!state?.enabled || state.mutations.length === 0 || !state.canFinalize) {
    return undefined;
  }

  const latestMutationSequence = state.mutations[state.mutations.length - 1]?.sequence ?? 0;
  // Later verification can strengthen the evidence, but it should not make an
  // already-recorded completion stale unless files changed after that evidence.
  const minimumSequence = latestMutationSequence;
  const candidates = state.finalizations.filter((finalization) =>
    finalization.sequence > minimumSequence
  );
  const latestFinalization = candidates.at(-1);
  if (!latestFinalization) {
    return {
      attempted: false,
      passed: false,
      issues: ["Build work was changed or verified, but finalize_build has not recorded completion evidence yet."],
    };
  }

  const issues: string[] = [];
  if (latestFinalization.summary.length === 0) {
    issues.push("finalize_build must include a concise completion summary.");
  }
  if (latestFinalization.artifacts.length === 0) {
    issues.push("finalize_build must list the concrete artifact paths created or changed.");
  }
  if (
    validationStatus?.passed
    && !finalizationListsObservedPassingValidation(
      state,
      latestFinalization,
      latestMutationSequence,
    )
  ) {
    issues.push("finalize_build must list a passing verification command that was observed after the latest file changes.");
  }
  if (latestFinalization.validation.some((item) => item.status === "failed")) {
    issues.push("finalize_build cannot claim completion while listing failed validation.");
  }
  if (latestFinalization.blockers.length > 0 && validationStatus?.passed) {
    issues.push("finalize_build lists blockers even though validation passed; either resolve them or explain a concrete incomplete state.");
  }

  return {
    attempted: true,
    passed: issues.length === 0,
    latestFinalization,
    issues,
  };
}

export function summarizeBuildTurn(input: {
  state: BuildTurnState | undefined;
  policy: BuildTurnPolicy;
  validationStatus?: BuildValidationStatus;
  finalizationStatus?: BuildFinalizationStatus;
  verifier?: BuildCompletionVerifierResult;
}): BuildTurnSummary | undefined {
  const { state } = input;
  if (!state?.enabled) {
    return undefined;
  }

  return {
    policy: input.policy,
    changedPaths: uniqueStrings(state.mutations.flatMap((mutation) => mutation.paths)),
    ...(input.validationStatus ? { verification: input.validationStatus } : {}),
    ...(input.finalizationStatus ? { finalization: input.finalizationStatus } : {}),
    ...(input.verifier ? { verifier: input.verifier } : {}),
    browserEvidence: [...state.browserEvidence],
  };
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 16)).trimEnd()} ...`;
}

function formatChangedPaths(paths: readonly string[]): string {
  return paths.slice(0, 6).join(", ");
}

function formatRecommendedCommands(commands: readonly string[]): string {
  return commands.join(" | ");
}

function formatBrowserEvidence(evidence: BuildBrowserEvidenceRecord): string {
  return [
    evidence.toolName,
    evidence.url ? `url=${evidence.url}` : undefined,
    evidence.readyState ? `readyState=${evidence.readyState}` : undefined,
    typeof evidence.consoleErrorCount === "number"
      ? `consoleErrors=${evidence.consoleErrorCount}`
      : undefined,
    typeof evidence.errorCount === "number"
      ? `errors=${evidence.errorCount}`
      : undefined,
    evidence.timedOut ? "timedOut=true" : undefined,
    evidence.lastError ? `lastError=${truncateText(evidence.lastError, 120)}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export function buildFailedBuildVerificationInstruction(
  status: BuildValidationStatus,
): string {
  const attempt = status.latestAttempt;
  const browserEvidence = status.latestBrowserEvidence;
  const outputSnippet = attempt
    ? truncateText([attempt.stdout.trim(), attempt.stderr.trim()].filter(Boolean).join("\n"), 320)
    : undefined;

  return [
    "This act turn is not complete yet.",
    `You changed files in this turn: ${formatChangedPaths(status.changedPaths)}.`,
    attempt
      ? `The latest verification command failed: ${attempt.command} (exit ${attempt.exitCode ?? "null"}${attempt.timedOut ? ", timed out" : ""}).`
      : browserEvidence
        ? `The latest browser/runtime verification failed or was inconclusive: ${formatBrowserEvidence(browserEvidence)}.`
        : "The latest verification step failed.",
    outputSnippet && outputSnippet.length > 0
      ? `Latest verification output:\n${outputSnippet}`
      : undefined,
    status.recommendedCommands.length > 0
      ? `Fix the issue and rerun a meaningful verification command. Recommended commands for this workspace: ${formatRecommendedCommands(status.recommendedCommands)}.`
      : "Fix the issue and rerun a meaningful verification command for this workspace.",
    "Only stop early if you explain the concrete blocker plainly.",
    "Emit the next tool call now.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildMissingBuildFinalizationInstruction(
  validationStatus: BuildValidationStatus,
): string {
  return [
    "This act turn is not complete yet.",
    `You changed files in this turn: ${formatChangedPaths(validationStatus.changedPaths)}.`,
    "Verification has passed, but completion evidence still needs to be recorded.",
    `Call ${FINALIZE_BUILD_TOOL_NAME} now with the artifact paths, passing validation command, instruction checklist, and any local URL/browser evidence.`,
    "Do not call another tool unless a final verification or browser check is still genuinely needed.",
    `Emit the ${FINALIZE_BUILD_TOOL_NAME} tool call now.`,
  ].join("\n");
}

export function buildRejectedBuildFinalizationInstruction(
  status: BuildFinalizationStatus,
): string {
  return [
    "This act turn is not complete yet.",
    `${FINALIZE_BUILD_TOOL_NAME} recorded incomplete or inconsistent evidence: ${status.issues.join(" ")}`,
    "Fix the completion evidence or do the missing work, then call finalize_build again.",
    "Only stop early if the task is truly blocked and the blocker is concrete.",
    "Emit the next tool call now.",
  ].join("\n");
}

export function buildRejectedBuildVerifierInstruction(
  result: BuildCompletionVerifierResult,
): string {
  return [
    "This act turn is not complete yet.",
    `The build completion verifier rejected the result: ${result.issues.join(" ")}`,
    result.retryInstruction,
    "Repair the implementation or evidence, rerun meaningful validation if files change, then call finalize_build again.",
    "Emit the next tool call now.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function looksLikeExplicitBuildBlocker(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return (
    BLOCKER_PATTERNS.some((pattern) => pattern.test(trimmed))
    && BLOCKER_CONTEXT_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
}

const TOPIC_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "basic",
  "build",
  "called",
  "create",
  "folder",
  "make",
  "page",
  "simple",
  "site",
  "that",
  "the",
  "their",
  "this",
  "use",
  "using",
  "web",
  "with",
]);

function normalizeTopicText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractTopicTerms(value: string): string[] {
  return uniqueStrings(
    normalizeTopicText(value)
      .split(" ")
      .filter((term) => term.length >= 4 && !TOPIC_STOP_WORDS.has(term)),
  ).slice(0, 8);
}

function extractTopicPhrases(value: string): string[] {
  const terms = extractTopicTerms(value);
  const phrases: string[] = [];
  for (let index = 0; index < terms.length - 1; index += 1) {
    phrases.push(`${terms[index]} ${terms[index + 1]}`);
  }
  return phrases.slice(0, 4);
}

export function evaluateBuildCompletionHeuristically(
  input: BuildCompletionVerifierInput,
): BuildCompletionVerifierResult {
  const issues: string[] = [];
  const finalization = input.finalization;
  if (!finalization) {
    return {
      ok: false,
      issues: ["No finalize_build evidence was recorded."],
      retryInstruction: "Call finalize_build with concrete artifact and validation evidence.",
    };
  }

  const evidenceText = normalizeTopicText([
    finalization.summary,
    finalization.artifacts.join(" "),
    finalization.instructionChecklist.join(" "),
    input.changedPaths.join(" "),
  ].join(" "));
  const phrases = extractTopicPhrases(input.userGoal);
  const missingPhrase = phrases.find((phrase) =>
    !evidenceText.includes(phrase)
    && !phrase.split(" ").every((term) => evidenceText.includes(term))
  );
  if (missingPhrase) {
    issues.push(`Completion evidence does not clearly match the requested topic "${missingPhrase}".`);
  }

  if (input.validationStatus?.passed && !finalization.validation.some((item) => item.status === "passed")) {
    issues.push("Completion evidence does not list the observed passing validation command.");
  }

  if (finalization.localUrl && finalization.browserVerified !== true && input.browserEvidence.length > 0) {
    issues.push("Completion evidence includes a local URL but does not mark browser verification as complete.");
  }

  return {
    ok: issues.length === 0,
    issues,
    ...(issues.length > 0
      ? {
          retryInstruction:
            "Align the implementation and final evidence with the user's requested topic, then rerun validation if needed.",
        }
      : {}),
  };
}
