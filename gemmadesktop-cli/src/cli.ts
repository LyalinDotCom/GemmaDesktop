import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EnvironmentInspectionResult,
  GemmaDesktopEvent,
  RuntimeDebugEvent,
  SessionInput,
  SessionSnapshot,
  TurnResult,
} from "@gemma-desktop/sdk-core";
import {
  createGemmaDesktop,
  type CreateGemmaDesktopOptions,
  type CreateSessionOptions,
  type GemmaDesktopSession,
  type SessionDebugSnapshot,
} from "@gemma-desktop/sdk-node";
import {
  CliArgumentError,
  parseCliCommand,
  usage,
  type CliCommand,
  type ScenarioCliOptions,
  type SessionCliOptions,
} from "./args.js";
import {
  createDesktopParityRuntimeAdapters,
  describeDesktopParityRuntimeConfig,
} from "./desktopParity.js";
import { buildDesktopParitySessionMetadata } from "./metadata.js";
import { runHeadlessScenario } from "./scenarios.js";

export interface WritableTextStream {
  write(chunk: string): unknown;
}

export interface ReadableTextStream extends AsyncIterable<unknown> {
  isTTY?: boolean;
  setEncoding?(encoding: BufferEncoding): void;
}

export type SessionLike = Pick<GemmaDesktopSession, "id" | "runStreamed" | "snapshot">;

export interface GemmaDesktopLike {
  inspectEnvironment(): Promise<EnvironmentInspectionResult>;
  describeSession(snapshot: SessionSnapshot): SessionDebugSnapshot;
  sessions: {
    create(options: CreateSessionOptions): Promise<SessionLike>;
  };
}

export interface CliDependencies {
  createGemmaDesktop(options: CreateGemmaDesktopOptions): Promise<GemmaDesktopLike>;
}

export interface CliRuntime {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: ReadableTextStream;
  stdout: WritableTextStream;
  stderr: WritableTextStream;
  signal?: AbortSignal;
  dependencies?: CliDependencies;
}

interface RunJsonOutput {
  result: TurnResult;
  events?: GemmaDesktopEvent[];
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  createGemmaDesktop: async (options) => await createGemmaDesktop(options),
};

function writeLine(stream: WritableTextStream, text = ""): void {
  stream.write(`${text}\n`);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveOptionalEnvValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function createDesktop(command: Exclude<CliCommand, { command: "help" }>, runtime: CliRuntime): Promise<GemmaDesktopLike> {
  const dependencies = runtime.dependencies ?? DEFAULT_DEPENDENCIES;
  return dependencies.createGemmaDesktop({
    workingDirectory: command.workingDirectory,
    adapters: createDesktopParityRuntimeAdapters(command.endpoints, {
      omlxApiKey: command.omlxApiKey ?? resolveOptionalEnvValue(runtime.env.OMLX_API_KEY),
    }),
    geminiApiKey: command.geminiApiKey ?? resolveOptionalEnvValue(runtime.env.GEMINI_API_KEY),
    geminiApiModel: command.geminiApiModel ?? resolveOptionalEnvValue(runtime.env.GEMMA_DESKTOP_GEMINI_API_MODEL),
  });
}

function hasRequestPreferences(command: SessionCliOptions): boolean {
  return Object.keys(command.requestPreferences).length > 0;
}

function createSessionOptions(command: SessionCliOptions): CreateSessionOptions {
  const metadata = buildDesktopParitySessionMetadata({
    mode: command.mode,
    runtimeId: command.runtimeId,
    preferredRuntimeId: command.runtimeId,
    selectedToolNames: command.selectedToolNames,
    requestPreferences: hasRequestPreferences(command) ? command.requestPreferences : undefined,
    extraMetadata: command.extraMetadata,
  });

  return {
    runtime: command.runtimeId,
    model: command.modelId,
    mode: command.mode,
    workingDirectory: command.workingDirectory,
    metadata,
    ...(command.systemInstructions ? { systemInstructions: command.systemInstructions } : {}),
    ...(command.maxSteps ? { maxSteps: command.maxSteps } : {}),
    ...(command.buildPolicy ? { buildPolicy: command.buildPolicy } : {}),
    ...(command.geminiApiKey ? { geminiApiKey: command.geminiApiKey } : {}),
    ...(command.geminiApiModel ? { geminiApiModel: command.geminiApiModel } : {}),
  };
}

async function readAll(stream: ReadableTextStream): Promise<string> {
  stream.setEncoding?.("utf8");
  let text = "";
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      text += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text += chunk.toString("utf8");
    } else {
      text += String(chunk);
    }
  }
  return text;
}

async function resolvePrompt(command: SessionCliOptions, runtime: CliRuntime): Promise<string> {
  if (command.prompt !== undefined) {
    return command.prompt;
  }

  if (command.promptFile) {
    const filePath = path.resolve(command.workingDirectory, command.promptFile);
    return await readFile(filePath, "utf8");
  }

  if (runtime.stdin.isTTY === false) {
    const stdin = await readAll(runtime.stdin);
    if (stdin.trim().length > 0) {
      return stdin;
    }
  }

  throw new CliArgumentError("Missing prompt. Provide positional text, --prompt, --prompt-file, or stdin.");
}

function formatInspectionSummary(
  inspection: EnvironmentInspectionResult,
  parity: ReturnType<typeof describeDesktopParityRuntimeConfig>,
): string {
  const lines = [
    `Inspected at ${inspection.inspectedAt}`,
    `Machine: ${inspection.machine.platform}/${inspection.machine.arch}, ${Math.round(inspection.machine.totalMemoryBytes / 1024 ** 3)} GB RAM`,
    `Desktop parity adapters: ${parity.adapterIds.join(", ")}`,
    `Endpoints: Ollama ${parity.endpoints.ollama}, LM Studio ${parity.endpoints.lmstudio}, llama.cpp ${parity.endpoints.llamacpp}, oMLX ${parity.endpoints.omlx}`,
    "",
    "Runtimes:",
  ];

  for (const runtime of inspection.runtimes) {
    const status = runtime.healthy
      ? "healthy"
      : runtime.reachable
        ? "reachable"
        : runtime.installed
          ? "installed"
          : "unavailable";
    lines.push(
      `  ${runtime.runtime.id} (${runtime.runtime.displayName}): ${status}, ${runtime.models.length} models, ${runtime.loadedInstances.length} loaded`,
    );
    for (const warning of runtime.warnings) {
      lines.push(`    warning: ${warning}`);
    }
  }

  if (inspection.warnings.length > 0) {
    lines.push("", "Warnings:", ...inspection.warnings.map((warning) => `  ${warning}`));
  }

  if (inspection.diagnosis.length > 0) {
    lines.push("", "Diagnosis:", ...inspection.diagnosis.map((entry) => `  ${entry}`));
  }

  return lines.join("\n");
}

async function executeInspect(command: Extract<CliCommand, { command: "inspect" }>, runtime: CliRuntime): Promise<number> {
  const desktop = await createDesktop(command, runtime);
  const inspection = await desktop.inspectEnvironment();
  const parity = describeDesktopParityRuntimeConfig(command.endpoints);

  if (command.outputJson) {
    writeLine(runtime.stdout, stringifyJson({ parity, environment: inspection }));
  } else {
    writeLine(runtime.stdout, formatInspectionSummary(inspection, parity));
  }

  return 0;
}

function collectAssistantDelta(event: GemmaDesktopEvent): string {
  if (event.type !== "content.delta") {
    return "";
  }
  const payload = event.payload;
  const channel = typeof payload.channel === "string" ? payload.channel : undefined;
  const delta = typeof payload.delta === "string" ? payload.delta : "";
  return channel === "assistant" || channel === undefined ? delta : "";
}

async function executePreview(command: SessionCliOptions, runtime: CliRuntime): Promise<number> {
  const desktop = await createDesktop(command, runtime);
  const session = await desktop.sessions.create(createSessionOptions(command));
  const debugSnapshot = desktop.describeSession(session.snapshot());

  if (command.outputJson) {
    writeLine(runtime.stdout, stringifyJson(debugSnapshot));
  } else {
    writeLine(runtime.stdout, stringifyJson({
      sessionId: debugSnapshot.sessionId,
      runtimeId: debugSnapshot.runtimeId,
      modelId: debugSnapshot.modelId,
      mode: debugSnapshot.mode,
      workingDirectory: debugSnapshot.workingDirectory,
      toolNames: debugSnapshot.toolNames,
      requestPreview: debugSnapshot.requestPreview,
    }));
  }

  return 0;
}

async function executeRun(command: SessionCliOptions, runtime: CliRuntime): Promise<number> {
  const prompt: SessionInput = await resolvePrompt(command, runtime);
  const desktop = await createDesktop(command, runtime);
  const session = await desktop.sessions.create(createSessionOptions(command));
  const events: GemmaDesktopEvent[] = [];
  let wroteAssistantText = false;

  const streamed = await session.runStreamed(prompt, {
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    ...(command.maxSteps ? { maxSteps: command.maxSteps } : {}),
    ...(command.buildPolicy ? { buildPolicy: command.buildPolicy } : {}),
    ...(command.debugRuntime
      ? {
          debug: (event: RuntimeDebugEvent) => {
            writeLine(runtime.stderr, stringifyJson({ type: "runtime.debug", event }));
          },
        }
      : {}),
  });

  for await (const event of streamed.events) {
    if (command.showEvents || command.outputJson) {
      events.push(event);
    }
    if (command.showEvents && !command.outputJson) {
      writeLine(runtime.stderr, stringifyJson({ type: "sdk.event", event }));
    }
    if (!command.outputJson) {
      const delta = collectAssistantDelta(event);
      if (delta.length > 0) {
        wroteAssistantText = true;
        runtime.stdout.write(delta);
      }
    }
  }

  const result = await streamed.completed;

  if (command.outputJson) {
    const output: RunJsonOutput = {
      result,
      ...(command.showEvents ? { events } : {}),
    };
    writeLine(runtime.stdout, stringifyJson(output));
    return 0;
  }

  if (wroteAssistantText) {
    writeLine(runtime.stdout);
  } else {
    writeLine(runtime.stdout, result.text);
  }

  for (const warning of result.warnings) {
    writeLine(runtime.stderr, `warning: ${warning}`);
  }

  return 0;
}

async function executeScenario(command: ScenarioCliOptions, runtime: CliRuntime): Promise<number> {
  const desktop = await createDesktop(command, runtime);
  const result = await runHeadlessScenario(command, desktop, runtime);

  if (command.outputJson) {
    writeLine(runtime.stdout, stringifyJson(result));
  } else {
    writeLine(runtime.stdout, `Scenario: ${result.scenarioId}`);
    writeLine(runtime.stdout, `Workspace: ${result.workingDirectory}`);
    writeLine(runtime.stdout, `Artifact: ${result.artifactDirectory}`);
    writeLine(runtime.stdout, `Score: ${Math.round(result.evaluation.score * 100)}%`);
    writeLine(runtime.stdout, `Success: ${result.evaluation.success ? "yes" : "no"}`);
    if (result.evaluation.issues.length > 0) {
      writeLine(runtime.stdout, `Issues: ${result.evaluation.issues.join(", ")}`);
    }
  }

  return result.evaluation.success ? 0 : 1;
}

async function executeCommand(command: CliCommand, runtime: CliRuntime): Promise<number> {
  switch (command.command) {
    case "help":
      writeLine(runtime.stdout, usage());
      return 0;
    case "inspect":
      return await executeInspect(command, runtime);
    case "preview":
      return await executePreview(command, runtime);
    case "run":
      return await executeRun(command, runtime);
    case "scenario":
      return await executeScenario(command, runtime);
  }
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const command = parseCliCommand(runtime.argv, runtime.cwd);
    return await executeCommand(command, runtime);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      writeLine(runtime.stderr, `error: ${error.message}`);
      writeLine(runtime.stderr);
      writeLine(runtime.stderr, usage());
      return 2;
    }

    writeLine(runtime.stderr, `error: ${formatError(error)}`);
    return 1;
  }
}
