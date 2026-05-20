#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findScenario, listGeminiModels, listLmStudioModels, listOllamaModels, scenarios } from '@gemma-sdk/agent';
import type { AgentRunOptions, AgentTurn, StreamChunk, ToolCall } from '@gemma-sdk/agent';
import { runAcp } from './acp.js';
import { parseArgs } from './args.js';
import { appendEvent, createDiagnosticContext, createRunModelActivityRecorder, listStoredSessions, recordRunError, recordRunResult, recordRunStart, sessionMessagesWithMetadata, type DiagnosticContext } from './diagnostics.js';
import { createRuntime, formatRunResult, resolveRuntimeSkills } from './runtime.js';
import { runTui } from './tui.js';
import { cliVersionText } from './version.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let diagnostics: DiagnosticContext | undefined;
  let jsonStreamActive = argv.includes('--json-stream');
  let streamedError = false;
  try {
    const options = parseArgs(argv);
    jsonStreamActive = options.jsonStream;
    if (options.version) {
      console.log(cliVersionText());
      return 0;
    }
    if (options.help) {
      console.log(helpText());
      return 0;
    }

    if (options.listSessions) {
      const sessions = await listStoredSessions(options.cwd);
      console.log(formatSessions(sessions));
      return 0;
    }

    if (options.listModels) {
      console.log((await listModels(options)).join('\n'));
      return 0;
    }

    if (options.acp) {
      await runAcp(options);
      return 0;
    }

    diagnostics = await createDiagnosticContext(options);
    const promptHistory = sessionMessagesWithMetadata(diagnostics.session);
    options.history = promptHistory.messages;

    if (options.tui || shouldStartTuiByDefault(options)) {
      await runTui(options, undefined, undefined, diagnostics);
      return 0;
    }

    const scenario = options.scenario ? findScenario(options.scenario) : undefined;
    if (options.scenario && !scenario) {
      throw new Error(`Unknown scenario "${options.scenario}". Available scenarios: ${scenarios.map((item) => item.id).join(', ')}`);
    }

    const prompt = scenario?.prompt ?? options.prompt;
    if (!prompt) {
      throw new Error('Provide --prompt "..." or --scenario <id>.');
    }

    const runtime = await createRuntime(options);
    const runSkills = resolveRuntimeSkills(runtime.skills, prompt);
    const explicitSkillPaths = new Set(runtime.skills.map((skill) => skill.path));
    const detectedSkills = runSkills.filter((skill) => !explicitSkillPaths.has(skill.path));
    const runId = await recordRunStart(diagnostics, prompt, promptHistory.metadata);
    const resultBase = {
      sessionId: diagnostics.session.id,
      provider: runtime.provider.name,
      model: runtime.model,
      selectedModel: runtime.selectedModel,
      context: {
        requestedTokens: runtime.requestedContextTokens,
        loadedTokens: runtime.loadedContextTokens,
        tokens: runtime.contextTokens
      },
      scenario: scenario?.id,
      skills: runSkills.map((skill) => skill.name),
      detectedSkills: detectedSkills.map((skill) => skill.name)
    };
    const jsonStream = options.jsonStream
      ? createJsonStreamReporter({
          sessionId: diagnostics.session.id,
          runId,
          provider: runtime.provider.name,
          model: runtime.model,
          selectedModel: runtime.selectedModel,
          scenario: scenario?.id
        })
      : undefined;
    const modelActivity = createRunModelActivityRecorder(diagnostics, runId);
    const partialTurns: AgentTurn[] = [];
    const pendingToolCalls = new Map<number, ToolCall>();
    const jsonRunOptions = jsonStream?.runOptions();
    const runOptions: AgentRunOptions = {
      async onModelStart(event) {
        await jsonRunOptions?.onModelStart?.(event);
      },
      async onModelActivity(event) {
        await modelActivity.record(event);
        await jsonRunOptions?.onModelActivity?.(event);
      },
      async onToolStart(event) {
        pendingToolCalls.set(event.index, event.toolCall);
        await jsonRunOptions?.onToolStart?.(event);
      },
      async onTurn(event) {
        partialTurns[event.index] = event.turn;
        if (event.turn.kind === 'tool') {
          pendingToolCalls.delete(event.index);
        }
        await jsonRunOptions?.onTurn?.(event);
      }
    };
    let result;
    try {
      jsonStream?.emit('run_started', {
        promptLength: prompt.length,
        selectedModel: runtime.selectedModel,
        runtimeModel: runtime.model,
        context: {
          requestedTokens: runtime.requestedContextTokens,
          loadedTokens: runtime.loadedContextTokens,
          tokens: runtime.contextTokens
        },
        promptHistory: promptHistory.metadata,
        skills: runSkills.map((skill) => skill.name),
        detectedSkills: detectedSkills.map((skill) => skill.name)
      });
      result = await runtime.run(prompt, runOptions);
      await modelActivity.flush();
      await recordRunResult(diagnostics, runId, result, {
        modelOutputs: modelActivity.snapshots()
      });
    } catch (error) {
      await modelActivity.flush();
      await recordRunError(diagnostics, runId, error, 'failed', {
        turns: partialTurns.filter(Boolean),
        pendingToolCalls: [...pendingToolCalls.values()],
        modelOutputs: modelActivity.snapshots()
      });
      if (jsonStream) {
        streamedError = true;
        jsonStream.emit('run_failed', { error: formatError(error) });
      }
      throw error;
    }
    const resultPayload = { ...resultBase, ...result };
    if (options.jsonStream) {
      jsonStream?.emit('run_completed', { result: resultPayload });
    } else if (options.json) {
      console.log(JSON.stringify(resultPayload, null, 2));
    } else {
      console.log(formatRunResult(result));
    }
    return 0;
  } catch (error) {
    if (diagnostics) {
      await appendEvent(diagnostics.eventLogPath, {
        type: 'cli_error',
        timestamp: new Date().toISOString(),
        sessionId: diagnostics.session.id,
        data: formatError(error)
      });
    }
    if (jsonStreamActive) {
      if (!streamedError) {
        console.log(JSON.stringify({
          type: 'cli_error',
          timestamp: new Date().toISOString(),
          data: { error: formatError(error) }
        }));
      }
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

function shouldStartTuiByDefault(options: ReturnType<typeof parseArgs>): boolean {
  return !options.prompt && !options.scenario && !options.acp;
}

function helpText(): string {
  return `Gemma CLI ${cliVersionText().replace(/^gemma-cli\s+/, 'v')}

Usage:
  gemma
  gemma --prompt "summarize package.json"
  gemma --scenario file-analysis
  gemma --tui
  gemma --acp
  gemma --resume
  gemma --resume <session-id>

Options:
  No prompt/scenario/acp starts the TUI by default.
  -p, --prompt <text>       Prompt to run.
  -s, --scenario <id>       Fixed harmless scenario to run.
  --skill <name>            Load a skill from ~/.gemmacli/skills or .gemma/skills. Repeatable.
  --provider <name>         ollama, lmstudio, or gemini. Defaults to ollama.
  --model <name>            Model name. Ollama defaults to gemma4:26b; Gemini defaults to gemini-3.5-flash.
  --ollama-url <url>        Ollama base URL. Defaults to http://127.0.0.1:11434.
  --lmstudio-url <url>      LM Studio base URL. Defaults to http://127.0.0.1:1234.
  --gemini-api-key <key>    Gemini API key. Defaults to GEMINI_API_KEY.
  --gemini-api-base-url <url> Gemini API base URL. Defaults to https://generativelanguage.googleapis.com/v1beta.
  --cwd <path>              Workspace root for tools. Defaults to current directory.
  --max-turns <n>           Maximum model/tool turns. Defaults to unlimited.
  --max-tokens <n>          Maximum model tokens per turn. Defaults to provider settings.
  --context-tokens <n>      Target context budget for reporting and provider options. Configure Ollama context in Ollama. Defaults to 262144.
  --temperature <n>         Sampling temperature. Defaults to 1.
  --top-p <n>               Nucleus sampling top_p. Defaults to 0.95.
  --top-k <n>               Top-k setting when supported by the provider. Defaults to 64.
  --think <auto|on|off>     Reasoning control. Defaults to auto.
  --shell-idle-timeout-ms <n> No-output timeout for exec_command. Defaults to 300000.
  --no-ollama-autostart     Do not try to start an installed Ollama server for /v1 model discovery.
  --yolo                    Allow tool commands to reference files outside the workspace without prompting.
  -i, --tui                 Start the line-oriented terminal UI.
  --acp                     Start minimal JSONL ACP-compatible stdio mode.
  --json                    Print structured run result.
  --json-stream             Print JSONL progress events and final result for headless runs.
  --resume [session-id]     Resume latest session or an ID prefix from .gemmacli/sessions.
  --list-sessions           List resumable sessions for this workspace.
  --list-models             List models for the selected Ollama, LM Studio, or Gemini provider.
  -v, --version             Print the Gemma CLI version.
  -h, --help                Show help.

Scenarios:
${scenarios.map((scenario) => `  ${scenario.id.padEnd(18)} ${scenario.description}`).join('\n')}

TUI commands:
  /model, /run <command>, /skills, /stats, /status, /help, /quit

ACP methods:
  initialize, session/new, session/prompt, models/list, skills/list
`;
}

function formatSessions(sessions: Awaited<ReturnType<typeof listStoredSessions>>): string {
  if (sessions.length === 0) {
    return 'No sessions found in .gemmacli/sessions.';
  }
  return sessions
    .map((session) => `${session.id}  ${session.updatedAt}  ${session.provider}/${session.model ?? 'default'}  runs=${session.runs.length}  messages=${session.history.length}`)
    .join('\n');
}

async function listModels(options: ReturnType<typeof parseArgs>): Promise<string[]> {
  if (options.provider === 'lmstudio') {
    return listLmStudioModels(options.lmStudioUrl);
  }
  if (options.provider === 'ollama') {
    return listOllamaModels(options.ollamaUrl);
  }
  if (options.provider === 'gemini') {
    return listGeminiModels(options.geminiApiKey, options.geminiApiBaseUrl);
  }
  throw new Error('--list-models is only available for ollama, lmstudio, and gemini providers.');
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export interface JsonStreamContext {
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  selectedModel?: string;
  scenario?: string;
}

interface JsonStreamReporter {
  emit(type: string, data?: Record<string, unknown>): void;
  runOptions(): AgentRunOptions;
}

const jsonStreamActivityIntervalMs = 1000;
const jsonStreamHeartbeatIntervalMs = 5000;

export function createJsonStreamReporter(context: JsonStreamContext, writeLine: (line: string) => void = (line) => console.log(line)): JsonStreamReporter {
  let pendingActivity: PendingActivity | undefined;
  let lastActivityEmittedAt = 0;
  let activeModel: { index: number; finalization: boolean } | undefined;
  let lastModelSignalAt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    if (type === 'run_completed' || type === 'run_failed' || type === 'cli_error') {
      stopHeartbeat();
    }
    writeLine(JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      sessionId: context.sessionId,
      runId: context.runId,
      provider: context.provider,
      model: context.model,
      selectedModel: context.selectedModel,
      ...(context.scenario ? { scenario: context.scenario } : {}),
      data
    }));
  };

  return {
    emit,
    runOptions() {
      return {
        onModelStart(event) {
          flushActivity();
          startHeartbeat(event.index, event.finalization === true);
          emit('model_start', {
            index: event.index,
            finalization: event.finalization === true
          });
        },
        onModelActivity(event) {
          recordActivity(event.index, event.finalization === true, event.chunk);
        },
        onToolStart(event) {
          flushActivity();
          stopHeartbeat();
          emit('tool_start', {
            index: event.index,
            tool: event.toolCall.tool,
            args: summarizeToolArgs(event.toolCall)
          });
        },
        onTurn(event) {
          flushActivity();
          stopHeartbeat();
          if (event.turn.kind === 'tool') {
            emit('tool_result', summarizeToolTurn(event.index, event.turn));
          } else {
            emit('final_turn', {
              index: event.index,
              answerChars: event.turn.content.length,
              answerPreview: previewText(event.turn.content, 500)
            });
          }
        }
      };
    }
  };

  function recordActivity(index: number, finalization: boolean, chunk: StreamChunk): void {
    if (!chunk.content && !chunk.thinking && !chunk.status && chunk.done !== true && !chunk.doneReason) {
      return;
    }
    lastModelSignalAt = Date.now();
    if (pendingActivity && (pendingActivity.index !== index || pendingActivity.finalization !== finalization)) {
      flushActivity();
    }
    pendingActivity ??= {
      index,
      finalization,
      contentChars: 0,
      thinkingChars: 0
    };
    if (chunk.content) {
      pendingActivity.contentChars += chunk.content.length;
      pendingActivity.contentPreview = appendPreview(pendingActivity.contentPreview, chunk.content, 240);
    }
    if (chunk.thinking) {
      pendingActivity.thinkingChars += chunk.thinking.length;
      pendingActivity.thinkingPreview = appendPreview(pendingActivity.thinkingPreview, chunk.thinking, 240);
    }
    if (chunk.status) {
      pendingActivity.status = chunk.status;
    }
    if (chunk.done === true) {
      pendingActivity.done = true;
    }
    if (chunk.doneReason) {
      pendingActivity.doneReason = chunk.doneReason;
    }

    const now = Date.now();
    if (pendingActivity.done || lastActivityEmittedAt === 0 || now - lastActivityEmittedAt >= jsonStreamActivityIntervalMs) {
      flushActivity(now);
    }
  }

  function flushActivity(now = Date.now()): void {
    if (!pendingActivity) {
      return;
    }
    emit('model_activity', formatPendingActivity(pendingActivity));
    pendingActivity = undefined;
    lastActivityEmittedAt = now;
  }

  function startHeartbeat(index: number, finalization: boolean): void {
    activeModel = { index, finalization };
    lastModelSignalAt = Date.now();
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (!activeModel) {
        return;
      }
      const now = Date.now();
      const idleMs = now - lastModelSignalAt;
      if (idleMs < jsonStreamHeartbeatIntervalMs) {
        return;
      }
      emit('model_heartbeat', {
        index: activeModel.index,
        finalization: activeModel.finalization,
        idleMs
      });
      lastModelSignalAt = now;
    }, jsonStreamHeartbeatIntervalMs);
  }

  function stopHeartbeat(): void {
    activeModel = undefined;
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

interface PendingActivity {
  index: number;
  finalization: boolean;
  contentChars: number;
  thinkingChars: number;
  contentPreview?: string;
  thinkingPreview?: string;
  status?: string;
  done?: boolean;
  doneReason?: string;
}

function formatPendingActivity(activity: PendingActivity): Record<string, unknown> {
  return {
    index: activity.index,
    finalization: activity.finalization,
    ...(activity.thinkingChars > 0 ? {
      thinkingChars: activity.thinkingChars,
      thinkingPreview: activity.thinkingPreview
    } : {}),
    ...(activity.contentChars > 0 ? {
      contentChars: activity.contentChars,
      contentPreview: activity.contentPreview
    } : {}),
    ...(activity.status ? { status: activity.status } : {}),
    ...(activity.done === true ? { done: true } : {}),
    ...(activity.doneReason ? { doneReason: activity.doneReason } : {})
  };
}

function summarizeToolTurn(index: number, turn: AgentTurn): Record<string, unknown> {
  return {
    index,
    tool: turn.toolCall?.tool,
    ok: turn.toolResult?.ok === true,
    outputChars: turn.toolResult?.output.length ?? turn.content.length,
    outputPreview: previewText(turn.toolResult?.output ?? turn.content, 500)
  };
}

function summarizeToolArgs(toolCall: ToolCall): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolCall.args)) {
    result[key] = summarizeValue(value, key);
  }
  return result;
}

function summarizeValue(value: unknown, key: string, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > 240 || /content|oldText|newText/i.test(key)) {
      return {
        chars: value.length,
        preview: previewText(value, 240)
      };
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return depth >= 2
      ? { items: value.length }
      : value.slice(0, 8).map((item) => summarizeValue(item, key, depth + 1));
  }
  if (typeof value === 'object' && value) {
    if (depth >= 2) {
      return { keys: Object.keys(value).length };
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 12)
        .map(([childKey, childValue]) => [childKey, summarizeValue(childValue, childKey, depth + 1)])
    );
  }
  return String(value);
}

function previewText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function appendPreview(current: string | undefined, next: string, maxChars: number): string {
  const marker = '…';
  if (!current) {
    return previewText(next, maxChars);
  }
  if (current.endsWith(marker)) {
    return current;
  }
  return previewText(`${current}${next}`, maxChars);
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const exitCode = await main();
  await flushStandardStreams();
  process.exit(exitCode);
}

async function flushStandardStreams(): Promise<void> {
  await Promise.all([
    flushWritable(process.stdout),
    flushWritable(process.stderr)
  ]);
}

function flushWritable(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (stream.destroyed || !stream.writable) {
        resolve();
        return;
      }
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}
