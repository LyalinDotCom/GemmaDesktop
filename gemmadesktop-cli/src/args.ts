import path from "node:path";
import type { BuildTurnPolicyInput, ModeSelection } from "@gemma-desktop/sdk-core";
import {
  type DesktopParityRuntimeEndpoints,
  resolveDefaultModelTarget,
} from "./desktopParity.js";
import type { RequestPreferences } from "./metadata.js";

export class CliArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export type CliCommandName = "help" | "inspect" | "preview" | "run" | "scenario";
export type ScenarioId =
  | "act-webapp-black-hole"
  | "pdf-attention-authors"
  | "web-hacker-news-frontpage"
  | "web-news-coverage-compare"
  | "research-gemma4-availability";
export type BuildVerifierMode = "hybrid" | "deterministic" | "off";

export interface CommonCliOptions {
  command: CliCommandName;
  outputJson: boolean;
  endpoints: DesktopParityRuntimeEndpoints;
  workingDirectory: string;
  geminiApiKey?: string;
  geminiApiModel?: string;
}

export interface SessionCliOptions extends CommonCliOptions {
  command: "preview" | "run";
  runtimeId: string;
  modelId: string;
  mode: ModeSelection;
  maxSteps?: number;
  buildPolicy?: BuildTurnPolicyInput;
  systemInstructions?: string;
  prompt?: string;
  promptFile?: string;
  showEvents: boolean;
  debugRuntime: boolean;
  selectedToolNames: string[];
  requestPreferences: RequestPreferences;
  extraMetadata?: Record<string, unknown>;
}

export interface InspectCliOptions extends CommonCliOptions {
  command: "inspect";
}

export interface ScenarioCliOptions extends CommonCliOptions {
  command: "scenario";
  action: "run";
  scenarioId: ScenarioId;
  runtimeId: string;
  modelId: string;
  maxSteps?: number;
  turnTimeoutMs: number;
  buildPolicy?: BuildTurnPolicyInput;
  showEvents: boolean;
  debugRuntime: boolean;
  requestPreferences: RequestPreferences;
}

export interface HelpCliOptions {
  command: "help";
}

export type CliCommand = HelpCliOptions | InspectCliOptions | SessionCliOptions | ScenarioCliOptions;

interface ParseState {
  argv: string[];
  index: number;
  command: CliCommandName;
  outputJson: boolean;
  endpoints: DesktopParityRuntimeEndpoints;
  workingDirectory: string;
  runtimeId: string;
  modelId: string;
  modeBase: string;
  tools: string[];
  withoutTools: string[];
  requiredTools: string[];
  selectedToolNames: string[];
  maxSteps?: number;
  turnTimeoutMs?: number;
  buildTurns?: number;
  buildVerifier?: BuildVerifierMode;
  systemInstructions?: string;
  prompt?: string;
  promptFile?: string;
  showEvents: boolean;
  debugRuntime: boolean;
  geminiApiKey?: string;
  geminiApiModel?: string;
  requestPreferences: RequestPreferences;
  extraMetadata?: Record<string, unknown>;
  positional: string[];
}

const COMMANDS = new Set<CliCommandName>(["help", "inspect", "preview", "run", "scenario"]);
const REASONING_MODES = new Set(["auto", "on"]);
const BUILD_VERIFIER_MODES = new Set<BuildVerifierMode>(["hybrid", "deterministic", "off"]);
const SCENARIOS = new Set<ScenarioId>([
  "act-webapp-black-hole",
  "pdf-attention-authors",
  "web-hacker-news-frontpage",
  "web-news-coverage-compare",
  "research-gemma4-availability",
]);
const MODE_PRESETS = new Set([
  "assistant",
  "explore",
  "cowork",
  "planner",
  "plan",
  "build",
  "minimal",
  "tool-worker",
]);

export function usage(): string {
  return [
    "Usage:",
    "  gemma-desktop run [prompt] --model <id> [--runtime <id>] [--mode explore|build]",
    "  gemma-desktop preview --model <id> [--runtime <id>] [--mode explore|build] [--json]",
    "  gemma-desktop scenario run <scenario-id> --model <id> [--runtime <id>] [--json]",
    "  gemma-desktop inspect [--json]",
    "",
    "Common options:",
    "  --cwd <path>                  Working directory for SDK tools and session context.",
    "  --ollama-endpoint <url>       Ollama endpoint. Mirrors the desktop default when omitted.",
    "  --lmstudio-endpoint <url>     LM Studio endpoint. Mirrors the desktop default when omitted.",
    "  --llamacpp-endpoint <url>     llama.cpp server endpoint. Mirrors the desktop default when omitted.",
    "  --gemini-api-key <key>        Optional Gemini API key for SDK research/search helpers.",
    "  --gemini-api-model <model>    Optional Gemini API model for SDK research/search helpers.",
    "",
    "Run and preview options:",
    "  --prompt <text>               Prompt text. Positional text and stdin are also accepted.",
    "  --prompt-file <path>          Read prompt text from a UTF-8 file.",
    "  --system <text>               Additional system instructions passed to the SDK session.",
    "  --max-steps <count>           SDK turn step budget.",
    "  --build-turns <count>         Build/ACT sampling turn budget; defaults to the SDK build policy.",
    "  --turn-timeout-ms <count>     Per-scenario-turn timeout in milliseconds; defaults to 360000.",
    "  --build-verifier <mode>       Build/ACT completion verifier: hybrid, deterministic, or off.",
    "  --tool <name>                 Add a tool to the SDK mode selection. Can repeat.",
    "  --without-tool <name>         Remove a tool from the SDK mode selection. Can repeat.",
    "  --require-tool <name>         Require a tool call in the SDK mode selection. Can repeat.",
    "  --reasoning <auto|on>          Request reasoning control through desktop-style metadata.",
    "  --ollama-option <key=value>   Numeric Ollama request option. Can repeat.",
    "  --ollama-keep-alive <value>   Ollama request keep_alive value.",
    "  --lmstudio-option <key=value> Numeric LM Studio request option. Can repeat.",
    "  --metadata-json <object>      Extra top-level session metadata.",
    "  --show-events                 Include SDK events in JSON output or mirror them to stderr.",
    "  --debug-runtime               Mirror runtime debug records to stderr as JSON lines.",
    "  --json                        Emit machine-readable JSON.",
    "",
    "On-demand scenario IDs:",
    "  act-webapp-black-hole          Multi-turn build/edit/validate web app scenario.",
    "  pdf-attention-authors          Locate Attention Is All You Need, extract text, list authors.",
    "  web-hacker-news-frontpage      Fetch Hacker News and summarize the current front page.",
    "  web-news-coverage-compare      Compare latest CNN, Fox News, and MSNBC coverage.",
    "  research-gemma4-availability   Research current Gemma 4 versions and availability.",
  ].join("\n");
}

function initialState(argv: string[], cwd: string): ParseState {
  const defaultTarget = resolveDefaultModelTarget();
  const first = argv[0];
  const command =
    first && COMMANDS.has(first as CliCommandName)
      ? first as CliCommandName
      : first === "--help" || first === "-h"
        ? "help"
        : "run";
  return {
    argv,
    index: command === "run" && first !== "run" ? 0 : 1,
    command,
    outputJson: false,
    endpoints: {},
    workingDirectory: cwd,
    runtimeId: defaultTarget.runtimeId,
    modelId: defaultTarget.modelId,
    modeBase: "explore",
    tools: [],
    withoutTools: [],
    requiredTools: [],
    selectedToolNames: [],
    showEvents: false,
    debugRuntime: false,
    requestPreferences: {},
    positional: [],
  };
}

function readFlagValue(state: ParseState, flag: string): string {
  const value = state.argv[state.index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliArgumentError(`Missing value for ${flag}.`);
  }
  state.index += 2;
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliArgumentError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function readNumericOption(value: string, flag: string): [string, number] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliArgumentError(`${flag} must use key=value syntax.`);
  }
  const key = value.slice(0, separator).trim();
  const rawValue = value.slice(separator + 1).trim();
  const numericValue = Number(rawValue);
  if (!key || !Number.isFinite(numericValue)) {
    throw new CliArgumentError(`${flag} must use a non-empty key and a finite numeric value.`);
  }
  return [key, numericValue];
}

function readJsonObject(value: string, flag: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliArgumentError(`${flag} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function addNumericOption(
  current: Record<string, number> | undefined,
  entry: [string, number],
): Record<string, number> {
  return {
    ...(current ?? {}),
    [entry[0]]: entry[1],
  };
}

function buildModeSelection(state: ParseState): ModeSelection {
  if (!MODE_PRESETS.has(state.modeBase)) {
    throw new CliArgumentError(`Unsupported mode "${state.modeBase}".`);
  }

  if (
    state.tools.length === 0
    && state.withoutTools.length === 0
    && state.requiredTools.length === 0
  ) {
    return state.modeBase as ModeSelection;
  }

  return {
    base: state.modeBase as Extract<ModeSelection, string>,
    ...(state.tools.length > 0 ? { tools: [...state.tools] } : {}),
    ...(state.withoutTools.length > 0 ? { withoutTools: [...state.withoutTools] } : {}),
    ...(state.requiredTools.length > 0 ? { requiredTools: [...state.requiredTools] } : {}),
  };
}

function buildBuildPolicy(state: ParseState): BuildTurnPolicyInput | undefined {
  if (state.buildTurns == null && state.buildVerifier == null) {
    return undefined;
  }

  return {
    ...(state.buildTurns != null ? { samplingTurns: state.buildTurns } : {}),
    ...(state.buildVerifier != null ? { completionVerifier: state.buildVerifier } : {}),
  };
}

function resolveWorkingDirectory(input: string): string {
  return path.resolve(input);
}

function applyFlag(state: ParseState, flag: string): void {
  switch (flag) {
    case "--help":
    case "-h":
      state.command = "help";
      state.index += 1;
      return;
    case "--json":
      state.outputJson = true;
      state.index += 1;
      return;
    case "--show-events":
      state.showEvents = true;
      state.index += 1;
      return;
    case "--debug-runtime":
      state.debugRuntime = true;
      state.index += 1;
      return;
    case "--cwd":
      state.workingDirectory = resolveWorkingDirectory(readFlagValue(state, flag));
      return;
    case "--runtime":
      state.runtimeId = readFlagValue(state, flag);
      return;
    case "--model":
      state.modelId = readFlagValue(state, flag);
      return;
    case "--mode":
      state.modeBase = readFlagValue(state, flag);
      return;
    case "--prompt":
      state.prompt = readFlagValue(state, flag);
      return;
    case "--prompt-file":
      state.promptFile = readFlagValue(state, flag);
      return;
    case "--system":
      state.systemInstructions = readFlagValue(state, flag);
      return;
    case "--max-steps":
      state.maxSteps = readPositiveInteger(readFlagValue(state, flag), flag);
      return;
    case "--turn-timeout-ms":
      state.turnTimeoutMs = readPositiveInteger(readFlagValue(state, flag), flag);
      return;
    case "--build-turns":
      state.buildTurns = readPositiveInteger(readFlagValue(state, flag), flag);
      return;
    case "--build-verifier": {
      const value = readFlagValue(state, flag);
      if (!BUILD_VERIFIER_MODES.has(value as BuildVerifierMode)) {
        throw new CliArgumentError("--build-verifier must be hybrid, deterministic, or off.");
      }
      state.buildVerifier = value as BuildVerifierMode;
      return;
    }
    case "--tool": {
      const tool = readFlagValue(state, flag);
      state.tools.push(tool);
      state.selectedToolNames.push(tool);
      return;
    }
    case "--without-tool":
      state.withoutTools.push(readFlagValue(state, flag));
      return;
    case "--require-tool":
      state.requiredTools.push(readFlagValue(state, flag));
      return;
    case "--ollama-endpoint":
      state.endpoints.ollama = readFlagValue(state, flag);
      return;
    case "--lmstudio-endpoint":
      state.endpoints.lmstudio = readFlagValue(state, flag);
      return;
    case "--llamacpp-endpoint":
      state.endpoints.llamacpp = readFlagValue(state, flag);
      return;
    case "--gemini-api-key":
      state.geminiApiKey = readFlagValue(state, flag);
      return;
    case "--gemini-api-model":
      state.geminiApiModel = readFlagValue(state, flag);
      return;
    case "--reasoning": {
      const value = readFlagValue(state, flag);
      if (!REASONING_MODES.has(value)) {
        throw new CliArgumentError("--reasoning must be auto or on.");
      }
      state.requestPreferences.reasoningMode = value as RequestPreferences["reasoningMode"];
      return;
    }
    case "--ollama-option":
      state.requestPreferences.ollamaOptions = addNumericOption(
        state.requestPreferences.ollamaOptions,
        readNumericOption(readFlagValue(state, flag), flag),
      );
      return;
    case "--ollama-keep-alive":
      state.requestPreferences.ollamaKeepAlive = readFlagValue(state, flag);
      return;
    case "--lmstudio-option":
      state.requestPreferences.lmstudioOptions = addNumericOption(
        state.requestPreferences.lmstudioOptions,
        readNumericOption(readFlagValue(state, flag), flag),
      );
      return;
    case "--metadata-json":
      state.extraMetadata = {
        ...(state.extraMetadata ?? {}),
        ...readJsonObject(readFlagValue(state, flag), flag),
      };
      return;
    default:
      if (flag.startsWith("--")) {
        throw new CliArgumentError(`Unknown option ${flag}.`);
      }
      state.positional.push(flag);
      state.index += 1;
  }
}

export function parseCliCommand(argv: string[], cwd = process.cwd()): CliCommand {
  const state = initialState(argv, cwd);

  while (state.index < state.argv.length) {
    const value = state.argv[state.index];
    if (!value) {
      state.index += 1;
      continue;
    }
    applyFlag(state, value);
  }

  if (state.command === "help") {
    return { command: "help" };
  }

  const common: Omit<CommonCliOptions, "command"> = {
    outputJson: state.outputJson,
    endpoints: state.endpoints,
    workingDirectory: state.workingDirectory,
    ...(state.geminiApiKey ? { geminiApiKey: state.geminiApiKey } : {}),
    ...(state.geminiApiModel ? { geminiApiModel: state.geminiApiModel } : {}),
  };

  if (state.command === "inspect") {
    return {
      command: "inspect",
      ...common,
    };
  }

  if (state.command === "scenario") {
    const [action, rawScenarioId, ...extra] = state.positional;
    if (action !== "run") {
      throw new CliArgumentError("Scenario command must be: scenario run <scenario-id>.");
    }
    if (!rawScenarioId || !SCENARIOS.has(rawScenarioId as ScenarioId)) {
      throw new CliArgumentError(`Unsupported scenario "${rawScenarioId ?? ""}".`);
    }
    if (extra.length > 0) {
      throw new CliArgumentError(`Unexpected scenario argument: ${extra[0]}.`);
    }

    return {
      command: "scenario",
      action: "run",
      scenarioId: rawScenarioId as ScenarioId,
      ...common,
      runtimeId: state.runtimeId,
      modelId: state.modelId,
      ...(state.maxSteps ? { maxSteps: state.maxSteps } : {}),
      turnTimeoutMs: state.turnTimeoutMs ?? 360_000,
      buildPolicy: {
        samplingTurns: state.buildTurns ?? state.maxSteps ?? 6,
        completionVerifier: state.buildVerifier ?? "off",
      },
      showEvents: state.showEvents,
      debugRuntime: state.debugRuntime,
      requestPreferences: state.requestPreferences,
    };
  }

  const buildPolicy = buildBuildPolicy(state);
  return {
    command: state.command,
    ...common,
    runtimeId: state.runtimeId,
    modelId: state.modelId,
    mode: buildModeSelection(state),
    ...(state.maxSteps ? { maxSteps: state.maxSteps } : {}),
    ...(buildPolicy ? { buildPolicy } : {}),
    ...(state.systemInstructions ? { systemInstructions: state.systemInstructions } : {}),
    prompt: state.prompt ?? (state.positional.length > 0 ? state.positional.join(" ") : undefined),
    ...(state.promptFile ? { promptFile: state.promptFile } : {}),
    showEvents: state.showEvents,
    debugRuntime: state.debugRuntime,
    selectedToolNames: [...new Set(state.selectedToolNames)],
    requestPreferences: state.requestPreferences,
    ...(state.extraMetadata ? { extraMetadata: state.extraMetadata } : {}),
  };
}
