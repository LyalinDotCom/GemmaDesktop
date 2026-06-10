#!/usr/bin/env node
// Solar-system iterative coding benchmark for Gemma CLI on Ollama.
//
// Exercises Gemma CLI the way a user would: a fixed 4-prompt sequence that
// builds a solar-system web app (initial build + 3 --resume iterations) in an
// isolated workspace, one Ollama model per round, several attempts per round.
// The 4 prompts are FROZEN — byte-identical across models and attempts — so
// rounds are comparable. Gemma CLI defaults are the product under test: no
// generation-tuning flags are passed.
//
// Progress-aware supervision (no run left running endlessly):
// the CLI runs with --json-stream and the supervisor tails the events:
//   - model_activity / model_heartbeat -> tokens are flowing
//   - run_started / model_start / tool_start / tool_result / final_turn ->
//     the agent loop actually advanced a step
// A run is killed only when genuinely stuck:
//   stalled  - no events at all for --stall-min            (hung runtime)
//   runaway  - tokens flowing but no completed step for --turn-stall-min
//              (degenerate generation that never completes a turn)
//   timeout  - per-run hard cap at --run-cap-min
// plus an attempt-level ceiling (--attempt-cap-min, default 60) so a whole
// attempt can never exceed the budget.
//
// Cleanliness: every attempt starts by unloading EVERY resident Ollama model
// (verified via `ollama ps`) so timing always includes a cold model load, and
// the round ends with a final unload. Ollama and Gemma CLI versions, node,
// platform, and arch are recorded per attempt because Ollama can self-update.
//
// Validation (after the runs, never helping the model): node --check plus a
// jsdom functional harness (gemma-solar-iterative-validate.mjs) that loads the
// generated app, drives frames, and exercises motion, pause, slider, labels,
// click info panel, asteroid belt, and moon. Results are recorded per check.
//
// Usage (from benchmark/):
//   node gemma-solar-iterative.mjs --model gemma4:26b-a4b-it-qat --attempts 3
//   node gemma-solar-iterative.mjs --model gemma4:26b-mlx --attempts 3
//
// Outputs:
//   reports/solar-iterative/<model-tag>/attempt-N/run-{1..4}.log   JSONL events
//   reports/solar-iterative/<model-tag>/attempt-N/summary.json     full record
//   reports/solar-iterative/results.jsonl                          roll-up
//   workspaces/solar-iterative/<model-tag>-attempt-N/              the app

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CLI = join(repoRoot, 'gemma-cli', 'packages', 'cli', 'dist', 'index.js');
const VALIDATOR = join(here, 'gemma-solar-iterative-validate.mjs');
const REPORTS_ROOT = join(here, 'reports', 'solar-iterative');
const WORKSPACES_ROOT = join(here, 'workspaces', 'solar-iterative');

// FROZEN: byte-identical to the original QAT baseline session. Do not change.
const PROMPTS = [
  'Build a basic solar system simulator web app in this empty folder. Create exactly three files: index.html, style.css, and app.js. Requirements: a full-window HTML5 canvas with a dark background; the sun at the center; all 8 planets orbiting the sun as colored circles, each with a different orbit radius, size, color, and orbital speed; smooth animation with requestAnimationFrame; the app must work by opening index.html directly in a browser with no build step and no external libraries. Validate your work by checking the JavaScript syntax with: node --check app.js. When everything is written and validated, finish with a short summary.',
  'Iteration 1 on the existing solar system app you built: add user controls. Requirements: a Pause/Resume button and a simulation speed slider (range 0.1x to 5x, default 1x), both in a small control bar overlaid on top of the canvas; the button toggles the animation; the slider scales every planet orbital speed live. Keep the existing files and structure; edit index.html, style.css, and app.js as needed. Validate with: node --check app.js. Finish with a short summary of what changed.',
  'Iteration 2 on the same solar system app: add planet identification. Requirements: draw each planet name as a small text label next to its circle on the canvas; when the user clicks on a planet, show an info panel (a styled div overlay) with that planet name, its orbit radius, and its current speed; the panel has a close button. Click detection must use the planet current x/y position and radius. Keep all existing features (pause/resume button and speed slider) working. Edit the existing files only. Validate with: node --check app.js. Finish with a short summary of what changed.',
  'Iteration 3, final pass on the same solar system app: add two celestial details. Requirements: (1) an asteroid belt between the orbits of Mars and Jupiter, drawn as roughly 150 small gray dots at randomized radii and angles that slowly orbit the sun; (2) a moon orbiting Earth: a small gray circle that orbits around the Earth circle position while Earth orbits the sun. Both must respect the pause button and speed slider. Keep planet labels and the click info panel working. Edit existing files only. Validate with: node --check app.js. Finish with a short summary of what changed.',
];

const PROGRESS_EVENTS = new Set(['run_started', 'model_start', 'tool_start', 'tool_result', 'final_turn', 'run_completed', 'run_failed']);

function parseArgs(argv) {
  const options = {
    provider: 'ollama',
    endpoint: undefined,
    model: undefined,
    attempts: 1,
    runCapMin: 15,
    stallMin: 6,
    turnStallMin: 12,
    attemptCapMin: 60,
    temperature: undefined,
    topK: undefined,
    topP: undefined,
    reasoningMode: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') options.provider = readProvider(argv[++i]);
    else if (arg === '--endpoint') options.endpoint = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--attempts') options.attempts = Number(argv[++i]);
    else if (arg === '--run-cap-min') options.runCapMin = Number(argv[++i]);
    else if (arg === '--stall-min') options.stallMin = Number(argv[++i]);
    else if (arg === '--turn-stall-min') options.turnStallMin = Number(argv[++i]);
    else if (arg === '--attempt-cap-min') options.attemptCapMin = Number(argv[++i]);
    else if (arg === '--temperature') options.temperature = Number(argv[++i]);
    else if (arg === '--top-k') options.topK = Number(argv[++i]);
    else if (arg === '--top-p') options.topP = Number(argv[++i]);
    else if (arg === '--think') options.reasoningMode = readReasoningMode(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.model) {
    throw new Error('Usage: node gemma-solar-iterative.mjs --model <model> [--provider ollama|openai-compatible] [--endpoint URL] [--attempts N] [--run-cap-min M] [--stall-min M] [--turn-stall-min M] [--attempt-cap-min M]');
  }
  if (options.provider !== 'ollama' && !options.endpoint) {
    throw new Error('--endpoint is required when --provider is not ollama');
  }
  if (options.provider === 'openai-compatible') {
    options.temperature ??= 1;
    options.topK ??= 64;
    options.topP ??= 0.95;
  }
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new Error('--attempts must be a positive integer');
  for (const key of ['runCapMin', 'stallMin', 'turnStallMin', 'attemptCapMin']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be positive`);
  }
  for (const key of ['temperature', 'topK', 'topP']) {
    if (!Number.isFinite(options[key])) throw new Error(`${key} must be finite`);
  }
  return options;
}

function readProvider(value) {
  if (value === 'ollama' || value === 'openai-compatible') return value;
  throw new Error('--provider must be ollama or openai-compatible');
}

function readReasoningMode(value) {
  if (value === 'auto' || value === 'on' || value === 'off') return value;
  throw new Error('--think must be auto, on, or off');
}

function cliProviderFor(provider) {
  return provider === 'openai-compatible' ? 'llamacpp' : provider;
}

const fmt = (ms) => `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function exec(cmd, args, timeoutMs = 60_000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs }).trim();
  } catch (error) {
    return `unavailable (${error.code ?? error.status ?? 'error'})`;
  }
}

function listResidentOllamaModels() {
  const output = exec('ollama', ['ps']);
  if (output.startsWith('unavailable')) return [];
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name !== 'NAME');
}

function clearOllama() {
  const before = listResidentOllamaModels();
  for (const model of before) {
    exec('ollama', ['stop', model], 120_000);
  }
  // Unloading is asynchronous; poll briefly until clear.
  const deadline = Date.now() + 60_000;
  let resident = listResidentOllamaModels();
  while (resident.length > 0 && Date.now() < deadline) {
    execFileSync('sleep', ['2']);
    resident = listResidentOllamaModels();
  }
  return { unloaded: before, residentAfter: resident };
}

function collectStackMetadata(options) {
  return {
    timestamp: new Date().toISOString(),
    provider: options.provider,
    cliProvider: cliProviderFor(options.provider),
    endpoint: options.endpoint,
    ollamaVersion: options.provider === 'ollama' ? exec('ollama', ['--version']) : undefined,
    gemmaCliVersion: exec('node', [CLI, '--version']),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

function runSupervised({ model, workspace, prompt, resume, logPath, runNumber, options, runCapMs }) {
  return new Promise((resolvePromise) => {
    const args = [
      CLI,
      '--cwd', workspace,
      '--provider', cliProviderFor(options.provider),
      '--model', model,
      '--json-stream',
    ];
    if (options.temperature !== undefined) args.push('--temperature', String(options.temperature));
    if (options.topK !== undefined) args.push('--top-k', String(options.topK));
    if (options.topP !== undefined) args.push('--top-p', String(options.topP));
    if (options.endpoint) args.push('--endpoint', options.endpoint);
    if (options.reasoningMode) args.push('--think', options.reasoningMode);
    if (resume) args.push('--resume');
    args.push('--prompt', prompt);

    const out = createWriteStream(logPath);
    const startedAt = Date.now();
    // Own process group so a kill also takes down tool subprocesses.
    const child = spawn('node', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let lastEventAt = startedAt;     // any output (tokens count)
    let lastProgressAt = startedAt;  // agent-loop advancement only
    let toolResults = 0;
    let modelTurns = 0;
    let activityEvents = 0;
    let completedPayload;
    let failedPayload;
    let lineBuffer = '';

    const observeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      lastEventAt = Date.now();
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise still counts as output activity
      }
      const type = event.type ?? '';
      if (type === 'model_activity' || type === 'model_heartbeat') activityEvents += 1;
      if (type === 'model_start') modelTurns += 1;
      if (type === 'tool_result') toolResults += 1;
      if (type === 'run_completed') completedPayload = event.data?.result ?? event.result;
      if (type === 'run_failed') failedPayload = event.data ?? event;
      if (PROGRESS_EVENTS.has(type)) lastProgressAt = Date.now();
    };

    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      lineBuffer += chunk.toString('utf8');
      let newline = lineBuffer.indexOf('\n');
      while (newline !== -1) {
        observeLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      out.write(chunk);
      lastEventAt = Date.now();
    });

    let settled = false;
    let killReason;
    const finish = (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      out.end();
      const totals = completedPayload?.metrics?.totals ?? failedPayload?.metrics?.totals;
      resolvePromise({
        status,
        exitCode: exitCode ?? null,
        durationMs: Date.now() - startedAt,
        modelTurns,
        toolResults,
        activityEvents,
        tokensPerSecond: totals?.tokensPerSecond,
        wallTokensPerSecond: totals?.wallTokensPerSecond,
        outputTokens: totals?.outputTokens,
        error: failedPayload?.error,
      });
    };

    const kill = (status) => {
      killReason = status;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    let lastStatusLineAt = 0;
    const watch = setInterval(() => {
      const now = Date.now();
      const sinceEvent = now - lastEventAt;
      const sinceProgress = now - lastProgressAt;
      const elapsed = now - startedAt;

      if (elapsed > runCapMs) {
        log(`run ${runNumber}: HARD TIMEOUT after ${fmt(elapsed)} — killing`);
        kill('timeout');
        return;
      }
      if (sinceEvent > options.stallMin * 60_000) {
        log(`run ${runNumber}: STALLED — no output for ${fmt(sinceEvent)} — killing`);
        kill('stalled');
        return;
      }
      if (sinceProgress > options.turnStallMin * 60_000) {
        log(`run ${runNumber}: RUNAWAY — tokens flowing but no completed step for ${fmt(sinceProgress)} (${activityEvents} activity events) — killing`);
        kill('runaway');
        return;
      }
      if (now - lastStatusLineAt >= 30_000) {
        lastStatusLineAt = now;
        log(`run ${runNumber}: ${fmt(elapsed)} elapsed | turns=${modelTurns} tools=${toolResults} | last activity ${Math.round(sinceEvent / 1000)}s ago | last step ${fmt(sinceProgress)} ago`);
      }
    }, 10_000);

    child.on('error', () => finish('spawn-error'));
    child.on('exit', (code) => finish(killReason ?? (code === 0 ? 'completed' : 'failed'), code));
  });
}

function readSessionStats(workspace) {
  try {
    const dir = join(workspace, '.gemmacli', 'sessions');
    const file = readdirSync(dir).find((f) => f.endsWith('.json'));
    if (!file) return undefined;
    const session = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return (session.runs ?? []).map((r) => ({
      status: r.status,
      durationMs: r.stats?.durationMs,
      turns: r.stats?.turns,
      toolCalls: r.stats?.toolCalls,
    }));
  } catch {
    return undefined;
  }
}

function validateWorkspace(workspace) {
  try {
    const output = execFileSync('node', [VALIDATOR, workspace], { encoding: 'utf8', timeout: 120_000 });
    return JSON.parse(output);
  } catch (error) {
    return { error: `validator failed: ${error.message?.slice(0, 400)}` };
  }
}

function nextFreeSlot(root, prefix) {
  let slot = 1;
  while (true) {
    try {
      statSync(join(root, `${prefix}${slot}`));
      slot += 1;
    } catch {
      return slot;
    }
  }
}

const options = parseArgs(process.argv);
if (!statSync(CLI, { throwIfNoEntry: false })) {
  throw new Error(`Gemma CLI build not found at ${CLI}. Run npm run build:gemma-cli first.`);
}
const modelTag = (options.provider === 'ollama' ? options.model : `${options.provider}-${options.model}`).replace(/[:/]/g, '_');
const modelReports = join(REPORTS_ROOT, modelTag);
mkdirSync(modelReports, { recursive: true });
mkdirSync(WORKSPACES_ROOT, { recursive: true });

for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
  const slot = nextFreeSlot(modelReports, 'attempt-');
  const attemptDir = join(modelReports, `attempt-${slot}`);
  const workspace = join(WORKSPACES_ROOT, `${modelTag}-attempt-${slot}`);
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  log(`=== ${options.provider}/${options.model} attempt ${attempt}/${options.attempts} (slot ${slot}) ===`);
  log(`supervision: stall ${options.stallMin}m | runaway ${options.turnStallMin}m | run cap ${options.runCapMin}m | attempt cap ${options.attemptCapMin}m`);
  if (options.temperature !== undefined || options.topK !== undefined || options.topP !== undefined) {
    log(`sampling: temperature ${options.temperature} | top_k ${options.topK} | top_p ${options.topP}`);
  }

  let ollamaClear;
  if (options.provider === 'ollama') {
    log('clearing Ollama for a cold start');
    ollamaClear = clearOllama();
    if (ollamaClear.residentAfter.length > 0) {
      log(`WARNING: models still resident after clear: ${ollamaClear.residentAfter.join(', ')}`);
    }
  } else {
    log(`using external ${options.provider} endpoint ${options.endpoint}`);
  }
  const stack = collectStackMetadata(options);
  log(`stack: provider ${stack.provider}${stack.endpoint ? ` at ${stack.endpoint}` : ''}${stack.ollamaVersion ? ` | ollama "${stack.ollamaVersion}"` : ''} | gemma-cli ${stack.gemmaCliVersion} | node ${stack.node} | ${stack.arch} ${stack.memoryGb}GB`);

  const attemptStartedAt = Date.now();
  const runs = [];
  for (let i = 0; i < PROMPTS.length; i += 1) {
    const runNumber = i + 1;
    const attemptElapsed = Date.now() - attemptStartedAt;
    const attemptRemaining = options.attemptCapMin * 60_000 - attemptElapsed;
    if (attemptRemaining < 60_000) {
      log(`attempt cap reached before run ${runNumber} — stopping attempt`);
      runs.push({ run: runNumber, status: 'attempt-cap', durationMs: 0 });
      break;
    }
    const runCapMs = Math.min(options.runCapMin * 60_000, attemptRemaining);
    log(`run ${runNumber}/4 started${i > 0 ? ' (--resume)' : ''} (cap ${fmt(runCapMs)})`);
    const result = await runSupervised({
      model: options.model,
      workspace,
      prompt: PROMPTS[i],
      resume: i > 0,
      logPath: join(attemptDir, `run-${runNumber}.log`),
      runNumber,
      options,
      runCapMs,
    });
    runs.push({ run: runNumber, ...result });
    log(`run ${runNumber}/4 ${result.status} in ${fmt(result.durationMs)} (turns=${result.modelTurns} tools=${result.toolResults}${result.tokensPerSecond ? ` | ${result.tokensPerSecond.toFixed(1)} tok/s gen` : ''})`);
    if (result.status !== 'completed') {
      log(`stopping attempt: run ${runNumber} ${result.status} — recorded as the failure for this attempt`);
      break;
    }
  }
  const totalMs = Date.now() - attemptStartedAt;

  log('validating generated app (post-hoc, no model assistance)');
  const validation = validateWorkspace(workspace);
  const checksPassed = Array.isArray(validation.checks)
    ? `${validation.checks.filter((c) => c.ok).length}/${validation.checks.length}`
    : 'n/a';
  log(`validation: ${checksPassed} checks passed`);

  const allRunsCompleted = runs.length === 4 && runs.every((r) => r.status === 'completed');
  const summary = {
    benchmark: 'solar-iterative',
    provider: options.provider,
    cliProvider: cliProviderFor(options.provider),
    endpoint: options.endpoint,
    model: options.model,
    attemptSlot: slot,
    attemptDir,
    workspace,
    stack,
    ollamaClear,
    ...(options.temperature !== undefined || options.topK !== undefined || options.topP !== undefined || options.reasoningMode
      ? {
          sampling: {
            temperature: options.temperature,
            topK: options.topK,
            topP: options.topP,
            reasoningMode: options.reasoningMode ?? 'auto',
          },
        }
      : {}),
    supervision: {
      runCapMin: options.runCapMin,
      stallMin: options.stallMin,
      turnStallMin: options.turnStallMin,
      attemptCapMin: options.attemptCapMin,
    },
    startedAt: new Date(attemptStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalMs,
    outcome: allRunsCompleted ? 'all-4-completed' : `stopped-at-run-${runs.length}-${runs.at(-1)?.status}`,
    runs,
    sessionStats: readSessionStats(workspace),
    validation,
  };
  writeFileSync(join(attemptDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  appendFileSync(join(REPORTS_ROOT, 'results.jsonl'), `${JSON.stringify(summary)}\n`);
  log(`attempt outcome: ${summary.outcome} | total ${fmt(totalMs)} | validation ${checksPassed}`);
}

if (options.provider === 'ollama') {
  log('clearing Ollama (final cleanup)');
  clearOllama();
}
log('round done');
