#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const targetModelWeights = [
  'e2b',
  'e4b',
  '12b',
  '26b',
  '31b'
];

export const targetOllamaModelIds = [
  'gemma4:e2b',
  'gemma4:e4b',
  'gemma4:12b',
  'gemma4:26b',
  'gemma4:31b'
];

export const targetLmStudioModelIds = [
  'google/gemma-4-e2b',
  'google/gemma-4-e4b',
  'google/gemma-4-12b',
  'google/gemma-4-26b-a4b',
  'google/gemma-4-31b'
];

export const targetProviderModels = {
  ollama: targetOllamaModelIds,
  lmstudio: targetLmStudioModelIds
};

export const defaultThinkModes = ['on', 'off'];

export const defaultPrompt = [
  'Write a dependency-free Python 3 script in your final answer only.',
  'The script should read one text file path from argv, count total lines, blank lines, words, and unique case-insensitive words, then print a compact JSON object.',
  'Include simple argument validation and useful error messages.',
  'Do not write files. Do not use external packages. Return only one fenced code block containing the script.'
].join(' ');

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchmarkDir, '..');
const defaultReportsDir = path.join(benchmarkDir, 'reports');
const defaultWorkspacesDir = path.join(benchmarkDir, 'workspaces');

export function parseArgs(argv) {
  const options = {
    providers: ['ollama'],
    endpoint: undefined,
    providerEndpoints: {},
    cliCommand: process.env.GEMMA_BENCHMARK_CLI,
    cliPath: undefined,
    models: undefined,
    thinkModes: [...defaultThinkModes],
    prompt: defaultPrompt,
    output: undefined,
    reportsDir: defaultReportsDir,
    workspacesDir: defaultWorkspacesDir,
    timeoutMs: 20 * 60 * 1000,
    skipMissing: true,
    keepModelLoaded: false,
    resetRuntimeBetweenCases: false,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--provider':
        options.providers = [readProvider(readValue(argv, ++i, arg))];
        break;
      case '--providers':
        options.providers = splitList(readValue(argv, ++i, arg)).map(readProvider);
        break;
      case '--endpoint':
        options.endpoint = readValue(argv, ++i, arg);
        break;
      case '--ollama-endpoint':
        options.providerEndpoints.ollama = readValue(argv, ++i, arg);
        break;
      case '--lmstudio-endpoint':
      case '--lm-studio-endpoint':
        options.providerEndpoints.lmstudio = readValue(argv, ++i, arg);
        break;
      case '--cli-path':
        options.cliPath = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--cli-command':
        options.cliCommand = readValue(argv, ++i, arg);
        break;
      case '--models':
        options.models = splitList(readValue(argv, ++i, arg));
        break;
      case '--model':
        options.models = [readValue(argv, ++i, arg)];
        break;
      case '--think':
        options.thinkModes = splitList(readValue(argv, ++i, arg));
        break;
      case '--prompt':
        options.prompt = readValue(argv, ++i, arg);
        break;
      case '--prompt-file':
        options.promptFile = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--output':
        options.output = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--reports-dir':
        options.reportsDir = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--workspaces-dir':
        options.workspacesDir = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--timeout-ms':
        options.timeoutMs = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--no-skip-missing':
        options.skipMissing = false;
        break;
      case '--keep-model-loaded':
        options.keepModelLoaded = true;
        break;
      case '--reset-runtime-between-cases':
      case '--clean-runtime':
        options.resetRuntimeBetweenCases = true;
        break;
      case '--no-reset-runtime-between-cases':
      case '--no-clean-runtime':
        options.resetRuntimeBetweenCases = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.providers.length === 0) {
    throw new Error('At least one provider is required.');
  }
  validateThinkModes(options.thinkModes);
  return options;
}

export function buildBenchmarkPlan(options) {
  const runId = timestampForPath(new Date());
  return unique(options.providers).flatMap((provider) =>
    modelsForProvider(options, provider).flatMap((model) => options.thinkModes.map((think) => ({
      provider,
      model,
      think,
      workspace: path.join(options.workspacesDir, runId, `${provider}-${safePathPart(model)}-think-${think}`)
    })))
  );
}

export function buildGemmaCliArgs(options, item) {
  const args = [
    '--provider',
    item.provider,
    '--model',
    item.model,
    '--think',
    item.think,
    '--json-stream',
    '--cwd',
    item.workspace,
    '--prompt',
    options.prompt
  ];
  const endpoint = endpointForProvider(options, item.provider);
  if (endpoint) {
    args.splice(4, 0, '--endpoint', endpoint);
  }
  return args;
}

export function resolveGemmaCli(options, cwd = process.cwd()) {
  if (options.cliPath) {
    return {
      command: process.execPath,
      baseArgs: [options.cliPath],
      label: options.cliPath
    };
  }

  const localBinary = findLocalGemmaBinary(cwd);
  const command = options.cliCommand ?? localBinary ?? 'gemma';
  return {
    command,
    baseArgs: [],
    label: command
  };
}

export function parseJsonStreamEvents(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

export function metricsFromJsonStreamEvents(events, fallbackWallDurationMs = 0) {
  const calls = new Map();
  const startedAt = eventTimeMs(events[0]);
  const completedAt = eventTimeMs(events.findLast((event) => event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'cli_error'));

  for (const event of events) {
    if (event.type !== 'model_start' && event.type !== 'model_activity') {
      continue;
    }
    const data = event.data ?? {};
    const index = typeof data.index === 'number' ? data.index : 0;
    const finalization = data.finalization === true;
    const key = `${finalization ? 'final' : 'turn'}:${index}`;
    const timestamp = eventTimeMs(event) ?? Date.now();
    const call = calls.get(key) ?? {
      index,
      finalization,
      startedAt: timestamp,
      contentChars: 0,
      thinkingChars: 0
    };

    if (event.type === 'model_start') {
      call.startedAt = timestamp;
      calls.set(key, call);
      continue;
    }

    const contentChars = positiveNumber(data.contentChars) ?? 0;
    const thinkingChars = positiveNumber(data.thinkingChars) ?? 0;
    if ((contentChars > 0 || thinkingChars > 0) && call.firstOutputAt === undefined) {
      call.firstOutputAt = timestamp;
    }
    call.contentChars += contentChars;
    call.thinkingChars += thinkingChars;
    call.lastActivityAt = timestamp;
    if (data.done === true) {
      call.doneAt = timestamp;
    }
    if (typeof data.doneReason === 'string') {
      call.doneReason = data.doneReason;
    }
    if (data.usage && typeof data.usage === 'object') {
      call.usage = data.usage;
    }
    calls.set(key, call);
  }

  const modelCalls = [...calls.values()]
    .map((call) => formatEventModelCall(call))
    .sort((a, b) => Number(a.finalization) - Number(b.finalization) || a.index - b.index);
  return {
    totals: formatEventTotals(modelCalls, startedAt !== undefined && completedAt !== undefined
      ? Math.max(0, completedAt - startedAt)
      : fallbackWallDurationMs),
    modelCalls
  };
}

export function renderMarkdownReport(report) {
  const lines = [
    '# Gemma Model Throughput Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Providers: ${(report.providers ?? [report.provider]).join(', ')}`,
    `CLI: ${report.cli}`,
    `Clean runtime reset: ${report.resetRuntimeBetweenCases ? 'enabled' : 'disabled'}`,
    `Prompt tokens are reported from provider usage when available; otherwise the benchmark falls back to an estimated 4 characters per token.`,
    '',
    '## Stack',
    '',
    ...stackLines(report.stack),
    '',
    '## Runtime Metadata',
    '',
    'Provider and model configuration snapshots below are collected from the touched runtime APIs before the benchmark cases run.',
    '',
    '```json',
    JSON.stringify(report.stack?.providers ?? {}, null, 2),
    '```',
    '',
    '## Prompt',
    '',
    '```text',
    report.prompt,
    '```',
    '',
    '## Results',
    '',
    '| Provider | Model | Thinking | Status | Tok/s | Wall tok/s | Tokens | Source | First output | Model time | Context | Temp | Max tokens | Answer chars |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |',
    ...report.results.map((result) => resultRow(result, report)),
    ''
  ];

  const notable = report.results.filter((result) => result.status !== 'completed');
  if (notable.length > 0) {
    lines.push('## Skips And Failures', '');
    for (const result of notable) {
      lines.push(`- ${result.model} / think ${result.think}: ${result.status}${result.error ? ` - ${singleLine(result.error)}` : ''}`);
    }
    lines.push('');
  }

  if (report.resetRuntimeBetweenCases) {
    lines.push('## Runtime Reset Evidence', '');
    for (const result of report.results) {
      lines.push(`- ${result.provider} / ${result.model} / think ${result.think}: before ${resetSummary(result.runtimeResetBefore)}; after ${resetSummary(result.cleanup)}`);
    }
    lines.push('');
  }

  const runtimeStateResults = report.results.filter((result) => result.runtimeModelState);
  if (runtimeStateResults.length > 0) {
    lines.push('## Runtime Model State Evidence', '');
    for (const result of runtimeStateResults) {
      lines.push(`- ${result.provider} / ${result.model} / think ${result.think}: ${runtimeStateSummary(result.runtimeModelState)}`);
    }
    lines.push('');
  }

  lines.push('## Commands', '');
  for (const result of report.results) {
    lines.push(`### ${result.provider ?? report.provider} / ${result.model} / think ${result.think}`, '');
    lines.push('```sh');
    lines.push(shellQuoteCommand([result.command, ...result.commandArgs]));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function runBenchmark(rawOptions) {
  const options = { ...rawOptions };
  if (options.promptFile) {
    options.prompt = await readFile(options.promptFile, 'utf8');
  }
  const cli = resolveGemmaCli(options);
  if (!options.dryRun && options.cliPath) {
    await assertCliBuilt(options.cliPath);
  }

  const plan = buildBenchmarkPlan(options);
  const availability = options.skipMissing && !options.dryRun
    ? await listAvailableModelsByProvider(options, unique(plan.map((item) => item.provider)))
    : new Map();
  const stack = await collectStackMetadata(options, cli, plan, availability);
  const results = [];

  for (const item of plan) {
    const commandArgs = buildGemmaCliArgs(options, item);
    const fullCommandArgs = [...cli.baseArgs, ...commandArgs];
    const availableModels = availability.get(item.provider);
    if (availableModels?.error) {
      results.push({
        provider: item.provider,
        model: item.model,
        think: item.think,
        workspace: item.workspace,
        status: 'skipped',
        error: availableModels.error,
        command: cli.command,
        commandArgs: fullCommandArgs
      });
      continue;
    }
    if (availableModels?.models && !availableModels.models.has(item.model)) {
      results.push({
        provider: item.provider,
        model: item.model,
        think: item.think,
        workspace: item.workspace,
        status: 'skipped',
        error: 'model is not installed',
        command: cli.command,
        commandArgs: fullCommandArgs
      });
      continue;
    }
    if (options.dryRun) {
      results.push({
        provider: item.provider,
        model: item.model,
        think: item.think,
        workspace: item.workspace,
        status: 'dry-run',
        command: cli.command,
        commandArgs: fullCommandArgs
      });
      continue;
    }
    await mkdir(item.workspace, { recursive: true });
    const runtimeResetBefore = options.resetRuntimeBetweenCases
      ? await resetTouchedRuntimeState(options, options.providers)
      : undefined;
    const loadedBeforeRun = await modelLoadedBeforeRun(options, item);
    const result = await runBenchmarkCase(options, item, cli, commandArgs);
    result.runtimeModelState = await captureRuntimeModelState(options, item);
    if (runtimeResetBefore) {
      result.runtimeResetBefore = runtimeResetBefore;
    }
    results.push(result);
    if (!options.keepModelLoaded) {
      result.cleanup = options.resetRuntimeBetweenCases
        ? await resetTouchedRuntimeState(options, options.providers)
        : await cleanupModelAfterRun(options, item, loadedBeforeRun);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    providers: unique(plan.map((item) => item.provider)),
    cli: cli.label,
    resetRuntimeBetweenCases: options.resetRuntimeBetweenCases,
    stack,
    prompt: options.prompt,
    results
  };
  const output = options.output ?? path.join(options.reportsDir, `gemma-throughput-${timestampForPath(new Date())}.md`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, renderMarkdownReport(report), 'utf8');
  return { report, output };
}

export async function listAvailableModelsByProvider(options, providers) {
  const entries = await Promise.all(providers.map(async (provider) => {
    try {
      return [provider, { models: await listAvailableModels(options, provider) }];
    } catch (error) {
      return [provider, { error: error instanceof Error ? error.message : String(error) }];
    }
  }));
  return new Map(entries);
}

async function listAvailableModels(options, provider) {
  const cli = resolveGemmaCli(options);
  const args = [
    '--provider',
    provider,
    '--list-models'
  ];
  const endpoint = endpointForProvider(options, provider);
  if (endpoint) {
    args.splice(2, 0, '--endpoint', endpoint);
  }
  const result = await runProcess(cli.command, [...cli.baseArgs, ...args], {
    cwd: repoRoot,
    timeoutMs: 60_000
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to list ${provider} models: ${result.error ?? (result.stderr || result.stdout)}`);
  }
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

async function runBenchmarkCase(options, item, cli, commandArgs) {
  const startedAt = Date.now();
  const fullCommandArgs = [...cli.baseArgs, ...commandArgs];
  const processResult = await runProcess(cli.command, fullCommandArgs, {
    cwd: repoRoot,
    timeoutMs: options.timeoutMs
  });
  const events = parseJsonStreamEvents(processResult.stdout);
  const completed = events.findLast((event) => event.type === 'run_completed');
  const failed = events.findLast((event) => event.type === 'run_failed' || event.type === 'cli_error');
  const result = completed?.data?.result;
  const fallbackMetrics = metricsFromJsonStreamEvents(events, Date.now() - startedAt);
  const runMetrics = result?.metrics ?? failed?.data?.metrics ?? fallbackMetrics;
  const metrics = runMetrics?.totals;
  const started = events.findLast((event) => event.type === 'run_started');
  return {
    provider: item.provider,
    model: item.model,
    think: item.think,
    workspace: item.workspace,
    status: processResult.timedOut
      ? 'timeout'
      : processResult.exitCode === 0 && result
        ? 'completed'
        : 'failed',
    command: cli.command,
    commandArgs: fullCommandArgs,
    wallDurationMs: Date.now() - startedAt,
    cliDurationMs: result?.stats?.durationMs,
    selectedModel: result?.selectedModel ?? started?.data?.selectedModel,
    context: result?.context ?? started?.data?.context,
    settings: result?.settings ?? started?.data?.settings,
    answerChars: typeof result?.answer === 'string' ? result.answer.length : undefined,
    metrics,
    modelCalls: runMetrics?.modelCalls,
    eventCounts: countEvents(events),
    error: failed?.data?.error?.message ?? failed?.data?.error ?? processResult.error ?? (processResult.stderr.trim() || undefined)
  };
}

export async function collectStackMetadata(options, cli, plan, availability) {
  const providers = unique(plan.map((item) => item.provider));
  const modelsByProvider = Object.fromEntries(providers.map((provider) => [
    provider,
    unique(plan.filter((item) => item.provider === provider).map((item) => item.model))
  ]));
  const providerEntries = await Promise.all(providers.map(async (provider) => [
    provider,
    await collectProviderMetadata(options, provider, modelsByProvider[provider], availability.get(provider))
  ]));

  return {
    system: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    gemmaCli: await collectGemmaCliMetadata(cli),
    providers: Object.fromEntries(providerEntries)
  };
}

async function collectGemmaCliMetadata(cli) {
  const version = await runProcess(cli.command, [...cli.baseArgs, '--version'], {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  const help = await runProcess(cli.command, [...cli.baseArgs, '--help'], {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  return {
    command: cli.command,
    label: cli.label,
    versionText: singleLine(version.stdout || version.stderr || version.error || 'unknown'),
    defaults: parseGemmaCliDefaults(help.stdout)
  };
}

function parseGemmaCliDefaults(helpTextOutput) {
  return {
    maxTurns: matchDefault(helpTextOutput, /--max-turns[\s\S]*?Defaults to ([^.]+)\./),
    maxTokens: matchDefault(helpTextOutput, /--max-tokens[\s\S]*?Defaults to ([^.]+)\./),
    contextTokens: numberDefault(helpTextOutput, /--context-tokens[\s\S]*?Defaults to ([0-9_]+)\./),
    temperature: numberDefault(helpTextOutput, /--temperature[\s\S]*?Defaults to ([0-9.]+)\./),
    topP: numberDefault(helpTextOutput, /--top-p[\s\S]*?Defaults to ([0-9.]+)\./),
    topK: numberDefault(helpTextOutput, /--top-k[\s\S]*?Defaults to ([0-9_]+)\./),
    think: matchDefault(helpTextOutput, /--think[\s\S]*?Defaults to ([^.]+)\./)
  };
}

async function collectProviderMetadata(options, provider, models, availability) {
  if (provider === 'ollama') {
    return collectOllamaMetadata(options, models, availability);
  }
  if (provider === 'lmstudio') {
    return collectLmStudioMetadata(options, models, availability);
  }
  return { reachable: false, error: `Unsupported provider: ${provider}` };
}

async function collectOllamaMetadata(options, models, availability) {
  const endpoint = normalizeRuntimeRoot(endpointForProvider(options, 'ollama') ?? 'http://127.0.0.1:11434');
  const commandVersion = await runProcess('ollama', ['--version'], {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  const version = await fetchJson(`${endpoint}/api/version`).catch((error) => ({ error: error.message }));
  const tags = await fetchJson(`${endpoint}/api/tags`).catch(() => undefined);
  const ps = await fetchJson(`${endpoint}/api/ps`).catch(() => undefined);
  const modelEntries = await Promise.all(models.map(async (model) => [
    model,
    await fetchOllamaModelMetadata(endpoint, model)
  ]));

  return {
    endpoint,
    reachable: !version?.error,
    error: version?.error,
    version: version?.version,
    commandVersion: singleLine(commandVersion.stdout || commandVersion.stderr || commandVersion.error || ''),
    listedModelCount: availability?.models?.size ?? (Array.isArray(tags?.models) ? tags.models.length : undefined),
    loadedModels: Array.isArray(ps?.models) ? ps.models.map((item) => item.name ?? item.model).filter(Boolean) : undefined,
    models: Object.fromEntries(modelEntries)
  };
}

async function fetchOllamaModelMetadata(endpoint, model) {
  const show = await postJson(`${endpoint}/api/show`, { model }).catch(() => undefined);
  if (!show) {
    return undefined;
  }
  const details = show.details ?? {};
  const modelInfo = show.model_info ?? {};
  const parameters = parseOllamaParameters(show.parameters);
  return pruneUndefined({
    rawDetails: details,
    rawModelInfo: modelInfo,
    family: details.family,
    parameterSize: details.parameter_size,
    quantization: details.quantization_level,
    contextLength: findContextLength(modelInfo),
    maxContextLength: findContextLength(modelInfo),
    temperature: parameters.temperature,
    parameters,
    parametersText: show.parameters,
    capabilities: show.capabilities
  });
}

async function collectLmStudioMetadata(options, models, availability) {
  const endpoint = normalizeRuntimeRoot(endpointForProvider(options, 'lmstudio') ?? 'http://127.0.0.1:1234');
  const commandVersion = await runProcess('lms', ['version'], {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  const greeting = await fetchJson(`${endpoint}/lmstudio-greeting`).catch((error) => ({ error: error.message }));
  const openAiModels = await fetchJson(`${endpoint}/v1/models`).catch(() => undefined);
  const nativeModels = await fetchJson(`${endpoint}/api/v0/models`).catch(() => undefined);
  const nativeModelsById = new Map((nativeModels?.data ?? []).map((model) => [model.id, model]));
  const modelEntries = models.map((model) => [
    model,
    compactLmStudioModelMetadata(nativeModelsById.get(model))
  ]);

  return {
    endpoint,
    reachable: greeting?.lmstudio === true || Array.isArray(openAiModels?.data),
    error: greeting?.error,
    version: greeting?.version,
    commandVersion: summarizeLmStudioCommandVersion(commandVersion.stdout || commandVersion.stderr || commandVersion.error || ''),
    listedModelCount: availability?.models?.size ?? (Array.isArray(openAiModels?.data) ? openAiModels.data.length : undefined),
    transportDiagnostics: lmStudioTransportDiagnostics(options),
    models: Object.fromEntries(modelEntries)
  };
}

function lmStudioTransportDiagnostics(options) {
  if (options.mediaKind !== 'audio') {
    return undefined;
  }
  return {
    audio: {
      status: 'not supported',
      evidence: 'LM Studio local chat transports expose text/image inputs only; audio file handles are not delivered to the model through the public REST, OpenAI-compatible, Anthropic-compatible, CLI, or lmstudio-js chat surfaces.',
      checkedSurfaces: [
        '/api/v1/chat',
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/messages',
        'lms chat',
        '@lmstudio/sdk model.respond'
      ]
    }
  };
}

function compactLmStudioModelMetadata(model) {
  if (!model) {
    return undefined;
  }
  return pruneUndefined({
    rawApiModel: model,
    state: model.state,
    family: model.arch,
    publisher: model.publisher,
    quantization: model.quantization,
    compatibilityType: model.compatibility_type,
    maxContextLength: model.max_context_length,
    contextLength: model.context_length,
    capabilities: model.capabilities
  });
}

export function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: error.message, exitCode: 1, signal: undefined, timedOut });
    });
  });
}

async function stopOllamaModel(model) {
  const result = await runProcess('ollama', ['stop', model], {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  const unloaded = result.exitCode === 0
    ? await waitForOllamaModelToUnload(model)
    : { ok: false, output: '' };
  return {
    ok: result.exitCode === 0 && unloaded.ok,
    output: [result.stdout, result.stderr, unloaded.output].filter(Boolean).join('\n').trim()
  };
}

export async function modelLoadedBeforeRun(options, item) {
  if (item.provider === 'lmstudio') {
    return lmStudioModelLoaded(options, item.model);
  }
  return false;
}

export async function cleanupModelAfterRun(options, item, loadedBeforeRun) {
  if (item.provider === 'ollama') {
    return stopOllamaModel(item.model);
  }
  if (item.provider === 'lmstudio' && !loadedBeforeRun) {
    return unloadLmStudioModel(options, item.model);
  }
  return { ok: true, output: loadedBeforeRun ? 'Model was already loaded before this case; left it loaded.' : '' };
}

export async function captureRuntimeModelState(options, item) {
  if (item.provider === 'lmstudio') {
    const loadedModels = await lmStudioLoadedModels();
    const record = loadedModels.find((model) => model.identifier === item.model || model.modelKey === item.model || model.path === item.model);
    return compactLmStudioRuntimeState(record);
  }
  if (item.provider === 'ollama') {
    const result = await runProcess('ollama', ['ps'], {
      cwd: repoRoot,
      timeoutMs: 10_000
    });
    if (result.exitCode !== 0) {
      return { error: result.error ?? (result.stderr.trim() || result.stdout.trim()) };
    }
    return compactOllamaRuntimeState(result.stdout, item.model);
  }
  return undefined;
}

export async function resetTouchedRuntimeState(options, providers) {
  const entries = [];
  for (const provider of unique(providers)) {
    entries.push([provider, await resetProviderRuntimeState(options, provider)]);
  }
  return Object.fromEntries(entries);
}

async function resetProviderRuntimeState(options, provider) {
  if (provider === 'ollama') {
    return resetOllamaRuntimeState();
  }
  if (provider === 'lmstudio') {
    return resetLmStudioRuntimeState(options);
  }
  return { ok: false, output: `Unsupported provider: ${provider}` };
}

async function resetOllamaRuntimeState() {
  const ps = await runProcess('ollama', ['ps'], {
    cwd: repoRoot,
    timeoutMs: 10_000
  });
  if (ps.exitCode !== 0) {
    return {
      ok: false,
      unloadedModels: [],
      output: ps.error ?? (ps.stderr.trim() || ps.stdout.trim())
    };
  }

  const loadedModels = ollamaLoadedModels(ps.stdout);
  const stops = [];
  for (const model of loadedModels) {
    stops.push([model, await stopOllamaModel(model)]);
  }
  return {
    ok: stops.every(([, result]) => result.ok),
    unloadedModels: loadedModels,
    output: stops.map(([model, result]) => `${model}: ${result.output || (result.ok ? 'unloaded' : 'failed')}`).join('\n')
  };
}

async function resetLmStudioRuntimeState(options) {
  const before = await lmStudioLoadedModelIds(options);
  const result = await runProcess('lms', ['unload', '--all'], {
    cwd: repoRoot,
    timeoutMs: 60_000
  });
  const unloaded = result.exitCode === 0
    ? await waitForNoLmStudioModels(options)
    : { ok: false, output: '' };
  return {
    ok: result.exitCode === 0 && unloaded.ok,
    unloadedModels: before,
    output: [result.stdout, result.stderr, result.error, unloaded.output].filter(Boolean).join('\n').trim()
  };
}

async function lmStudioModelLoaded(options, model) {
  const loadedIds = await lmStudioLoadedModelIds(options);
  return loadedIds.includes(model);
}

async function lmStudioModels(options) {
  const endpoint = normalizeRuntimeRoot(endpointForProvider(options, 'lmstudio') ?? 'http://127.0.0.1:1234');
  return fetchJson(`${endpoint}/api/v0/models`).catch(() => undefined);
}

async function lmStudioLoadedModels() {
  const result = await runProcess('lms', ['ps', '--json'], {
    cwd: repoRoot,
    timeoutMs: 10_000
  });
  if (result.exitCode !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function lmStudioLoadedModelIds(options) {
  const models = await lmStudioModels(options);
  return Array.isArray(models?.data)
    ? models.data
      .filter((item) => item.state && item.state !== 'not-loaded')
      .map((item) => item.id)
      .filter(Boolean)
    : [];
}

async function unloadLmStudioModel(options, model) {
  const endpoint = normalizeRuntimeRoot(endpointForProvider(options, 'lmstudio') ?? 'http://127.0.0.1:1234');
  const result = await postJson(`${endpoint}/api/v1/models/unload`, { instance_id: model }).catch((error) => ({ error: error.message }));
  const unloaded = result?.error
    ? { ok: false, output: result.error }
    : await waitForLmStudioModelToUnload(options, model);
  return {
    ok: unloaded.ok,
    output: unloaded.output
  };
}

async function waitForLmStudioModelToUnload(options, model, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loaded = await lmStudioModelLoaded(options, model);
    if (!loaded) {
      return { ok: true, output: '' };
    }
    await sleep(2_000);
  }
  return {
    ok: false,
    output: `Timed out waiting for LM Studio to unload ${model}.`
  };
}

async function waitForNoLmStudioModels(options, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loadedIds = await lmStudioLoadedModelIds(options);
    if (loadedIds.length === 0) {
      return { ok: true, output: '' };
    }
    await sleep(2_000);
  }
  return {
    ok: false,
    output: 'Timed out waiting for LM Studio to unload all models.'
  };
}

async function waitForOllamaModelToUnload(model, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await runProcess('ollama', ['ps'], {
      cwd: repoRoot,
      timeoutMs: 10_000
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        output: result.error ?? (result.stderr.trim() || result.stdout.trim())
      };
    }
    if (!ollamaPsIncludesModel(result.stdout, model)) {
      return { ok: true, output: '' };
    }
    await sleep(2_000);
  }
  return {
    ok: false,
    output: `Timed out waiting for Ollama to unload ${model}.`
  };
}

export function ollamaPsIncludesModel(output, model) {
  return ollamaLoadedModels(output).includes(model);
}

export function ollamaLoadedModels(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertCliBuilt(cliPath) {
  try {
    await access(cliPath);
  } catch {
    throw new Error(`Gemma CLI build not found at ${cliPath}. Run npm run build:gemma-cli first.`);
  }
}

function findLocalGemmaBinary(cwd) {
  const binaryName = process.platform === 'win32' ? 'gemma.cmd' : 'gemma';
  const candidates = [];
  if (path.resolve(cwd) !== repoRoot) {
    candidates.push(path.join(cwd, 'node_modules/.bin', binaryName));
  }
  candidates.push(path.join(benchmarkDir, 'node_modules/.bin', binaryName));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function formatEventModelCall(call) {
  const endedAt = call.doneAt ?? call.lastActivityAt ?? call.startedAt;
  const durationMs = Math.max(0, endedAt - call.startedAt);
  const generationDurationMs = call.firstOutputAt === undefined
    ? undefined
    : Math.max(0, endedAt - call.firstOutputAt);
  const estimatedOutputTokens = estimateTokens(call.contentChars + call.thinkingChars);
  const providerOutputTokens = positiveNumber(call.usage?.outputTokens);
  const metricOutputTokens = providerOutputTokens ?? estimatedOutputTokens;
  return pruneUndefined({
    index: call.index,
    finalization: call.finalization,
    durationMs,
    firstOutputLatencyMs: call.firstOutputAt === undefined ? undefined : Math.max(0, call.firstOutputAt - call.startedAt),
    generationDurationMs,
    contentChars: call.contentChars,
    thinkingChars: call.thinkingChars,
    estimatedOutputTokens,
    providerOutputTokens,
    metricOutputTokens,
    tokenSource: providerOutputTokens === undefined ? 'estimate' : 'provider',
    tokensPerSecond: rate(metricOutputTokens, generationDurationMs),
    wallTokensPerSecond: rate(metricOutputTokens, durationMs),
    done: call.doneAt !== undefined,
    doneReason: call.doneReason
  });
}

function formatEventTotals(modelCalls, wallDurationMs) {
  const contentChars = sum(modelCalls.map((call) => call.contentChars));
  const thinkingChars = sum(modelCalls.map((call) => call.thinkingChars));
  const estimatedOutputTokens = estimateTokens(contentChars + thinkingChars);
  const providerCalls = modelCalls.filter((call) => call.providerOutputTokens !== undefined);
  const providerOutputTokens = providerCalls.length > 0
    ? round(sum(providerCalls.map((call) => call.providerOutputTokens ?? 0)))
    : undefined;
  const tokenSource = providerCalls.length === modelCalls.length && modelCalls.length > 0
    ? 'provider'
    : providerCalls.length === 0
      ? 'estimate'
      : 'mixed';
  const metricOutputTokens = round(sum(modelCalls.map((call) => call.metricOutputTokens)));
  const modelCallDurationMs = sum(modelCalls.map((call) => call.durationMs));
  const generationDurationMs = sum(modelCalls.map((call) => call.generationDurationMs ?? 0));
  return pruneUndefined({
    wallDurationMs,
    modelCallDurationMs,
    generationDurationMs: generationDurationMs > 0 ? generationDurationMs : undefined,
    contentChars,
    thinkingChars,
    estimatedOutputTokens,
    providerOutputTokens,
    metricOutputTokens,
    tokenSource,
    tokensPerSecond: rate(metricOutputTokens, generationDurationMs),
    wallTokensPerSecond: rate(metricOutputTokens, wallDurationMs)
  });
}

function resultRow(result, report = {}) {
  const metrics = result.metrics ?? {};
  const settings = result.settings ?? report.stack?.gemmaCli?.defaults ?? {};
  const context = result.context ?? {};
  const runtimeState = result.runtimeModelState ?? {};
  return [
    result.provider,
    result.model,
    result.think,
    result.status,
    formatNumber(metrics.tokensPerSecond),
    formatNumber(metrics.wallTokensPerSecond),
    formatNumber(metrics.metricOutputTokens),
    metrics.tokenSource ?? '',
    formatMs(firstOutputLatency(result)),
    formatMs(metrics.modelCallDurationMs ?? result.cliDurationMs ?? result.wallDurationMs),
    formatNumber(runtimeState.contextLength ?? context.tokens ?? context.loadedTokens ?? context.requestedTokens ?? settings.contextTokens),
    formatNumber(settings.temperature),
    settings.maxTokens ?? '',
    formatNumber(result.answerChars)
  ].map(tableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function stackLines(stack) {
  if (!stack) {
    return ['Stack metadata was not collected.'];
  }
  const lines = [
    `- Benchmark Node: ${stack.system?.node ?? ''} on ${stack.system?.platform ?? ''}/${stack.system?.arch ?? ''}`,
    `- Gemma CLI: ${stack.gemmaCli?.versionText ?? 'unknown'} (${stack.gemmaCli?.label ?? stack.gemmaCli?.command ?? 'unknown'})`
  ];
  if (stack.gemmaCli?.defaults) {
    lines.push(`- Gemma CLI defaults: context=${stack.gemmaCli.defaults.contextTokens ?? ''}, temp=${stack.gemmaCli.defaults.temperature ?? ''}, top_p=${stack.gemmaCli.defaults.topP ?? ''}, top_k=${stack.gemmaCli.defaults.topK ?? ''}, max_tokens=${stack.gemmaCli.defaults.maxTokens ?? ''}, max_turns=${stack.gemmaCli.defaults.maxTurns ?? ''}`);
  }
  for (const [provider, metadata] of Object.entries(stack.providers ?? {})) {
    lines.push(`- ${provider}: ${providerSummary(metadata)}`);
    for (const [model, modelMetadata] of Object.entries(metadata.models ?? {})) {
      lines.push(`  - ${model}: ${modelSummary(modelMetadata)}`);
    }
  }
  return lines;
}

function providerSummary(metadata) {
  if (!metadata?.reachable) {
    return `unreachable${metadata?.error ? ` (${singleLine(metadata.error)})` : ''}`;
  }
  const parts = [
    metadata.endpoint,
    metadata.version ? `version ${metadata.version}` : undefined,
    metadata.commandVersion ? `command ${singleLine(metadata.commandVersion)}` : undefined,
    typeof metadata.listedModelCount === 'number' ? `${metadata.listedModelCount} visible models` : undefined
  ].filter(Boolean);
  return parts.join(', ');
}

function modelSummary(metadata) {
  if (!metadata) {
    return 'metadata unavailable';
  }
  const parts = [
    metadata.state,
    metadata.contextLength ? `context ${metadata.contextLength}` : undefined,
    metadata.maxContextLength ? `max context ${metadata.maxContextLength}` : undefined,
    metadata.temperature !== undefined ? `temp ${metadata.temperature}` : undefined,
    metadata.quantization ? `quant ${metadata.quantization}` : undefined,
    metadata.family ? `family ${metadata.family}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'metadata available';
}

function compactLmStudioRuntimeState(model) {
  if (!model) {
    return undefined;
  }
  const quantization = typeof model.quantization === 'object' && model.quantization
    ? model.quantization.name
    : model.quantization;
  return pruneUndefined({
    state: model.state ?? 'loaded',
    status: model.status,
    contextLength: model.contextLength ?? model.context_length,
    maxContextLength: model.maxContextLength ?? model.max_context_length,
    quantization,
    compatibilityType: model.compatibility_type,
    publisher: model.publisher
  });
}

function compactOllamaRuntimeState(output, model) {
  const line = output
    .split(/\r?\n/)
    .slice(1)
    .find((entry) => entry.trim().split(/\s+/)[0] === model);
  if (!line) {
    return undefined;
  }
  const parts = line.trim().split(/\s+/);
  return pruneUndefined({
    state: 'loaded',
    contextLength: Number.isFinite(Number(parts[6])) ? Number(parts[6]) : undefined,
    processor: parts.length >= 6 ? `${parts[4]} ${parts[5]}` : undefined
  });
}

function runtimeStateSummary(state) {
  if (!state) {
    return 'state unavailable';
  }
  if (state.error) {
    return `error ${singleLine(state.error)}`;
  }
  const parts = [
    state.state,
    state.status,
    state.contextLength ? `context ${state.contextLength}` : undefined,
    state.maxContextLength ? `max context ${state.maxContextLength}` : undefined,
    state.quantization ? `quant ${state.quantization}` : undefined,
    state.processor ? `processor ${state.processor}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'state available';
}

function resetSummary(reset) {
  if (!reset) {
    return 'not requested';
  }
  return Object.entries(reset)
    .map(([provider, result]) => {
      const unloaded = Array.isArray(result.unloadedModels) && result.unloadedModels.length > 0
        ? ` unloaded=${result.unloadedModels.join(',')}`
        : '';
      return `${provider}:${result.ok ? 'ok' : 'failed'}${unloaded}`;
    })
    .join(' ');
}

function firstOutputLatency(result) {
  const calls = result.modelCalls;
  if (Array.isArray(calls)) {
    const first = calls.find((call) => typeof call.firstOutputLatencyMs === 'number');
    return first?.firstOutputLatencyMs;
  }
  return undefined;
}

function countEvents(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function eventTimeMs(event) {
  if (!event?.timestamp) {
    return undefined;
  }
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function splitList(value) {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error('List arguments must include at least one value.');
  }
  return items;
}

function readProvider(value) {
  if (value === 'ollama' || value === 'lmstudio') {
    return value;
  }
  throw new Error('Provider values must be ollama or lmstudio.');
}

function modelsForProvider(options, provider) {
  return options.models ?? targetProviderModels[provider] ?? targetOllamaModelIds;
}

export function endpointForProvider(options, provider) {
  if (options.providerEndpoints?.[provider]) {
    return options.providerEndpoints[provider];
  }
  return options.providers.length === 1 ? options.endpoint : undefined;
}

function validateThinkModes(values) {
  for (const value of values) {
    if (value !== 'on' && value !== 'off' && value !== 'auto') {
      throw new Error('--think values must be on, off, or auto.');
    }
  }
}

export function unique(values) {
  return [...new Set(values)];
}

function normalizeRuntimeRoot(value) {
  return value.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function parseOllamaParameters(parametersText) {
  if (typeof parametersText !== 'string') {
    return {};
  }
  const parsed = {};
  for (const line of parametersText.split(/\r?\n/)) {
    const [key, rawValue] = line.trim().split(/\s+/, 2);
    if (!key || rawValue === undefined) {
      continue;
    }
    const numeric = Number(rawValue);
    parsed[key] = Number.isFinite(numeric) ? numeric : rawValue;
  }
  return parsed;
}

function findContextLength(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return undefined;
  }
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/(\.|_|^)context_length$/i.test(key) || /(\.|_|^)max_context_length$/i.test(key)) {
      const numeric = positiveNumber(value);
      if (numeric !== undefined) {
        return numeric;
      }
    }
  }
  return undefined;
}

function matchDefault(value, pattern) {
  return value.match(pattern)?.[1]?.trim();
}

function numberDefault(value, pattern) {
  const matched = matchDefault(value, pattern);
  if (!matched) {
    return undefined;
  }
  const parsed = Number(matched.replace(/_/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function safePathPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

export function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function estimateTokens(chars) {
  return round(chars / 4);
}

function rate(tokens, durationMs) {
  if (!durationMs || durationMs <= 0 || tokens <= 0) {
    return undefined;
  }
  return round(tokens / (durationMs / 1000));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value) {
  return Number(value.toFixed(2));
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function formatMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '';
}

export function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function singleLine(value) {
  return stripAnsi(String(value)).replace(/\s+/g, ' ').trim();
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function summarizeLmStudioCommandVersion(value) {
  const clean = singleLine(value);
  const commit = clean.match(/CLI commit:\s*([a-f0-9]+)/i)?.[1];
  return commit ? `lms CLI commit ${commit}` : clean;
}

export function shellQuoteCommand(parts) {
  return parts.map((part) => {
    const value = String(part);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function helpText() {
  return `Gemma model throughput benchmark

Usage:
  node gemma-model-throughput.mjs
  node gemma-model-throughput.mjs --providers ollama,lmstudio --think on,off

Options:
  --providers <csv>       Providers to test. Defaults to ollama. Supported: ollama,lmstudio.
  --provider <name>       Test one provider.
  --models <csv>          Models to test for every selected provider. Provider defaults are used when omitted.
  --model <name>          Test one model.
  --think <csv>           Thinking modes. Defaults to on,off.
  --endpoint <url>        Provider endpoint passed through to Gemma CLI when one provider is selected.
  --ollama-endpoint <url> Ollama endpoint for multi-provider runs.
  --lmstudio-endpoint <url> LM Studio endpoint for multi-provider runs.
  --cli-command <cmd>     Gemma CLI command. Defaults to local node_modules/.bin/gemma, then PATH gemma.
  --cli-path <path>       Development override for a built Gemma CLI index.js.
  --prompt <text>         Override the fixed code-generation prompt.
  --prompt-file <path>    Read the prompt from a file.
  --output <path>         Markdown report path.
  --timeout-ms <n>        Per-case timeout. Defaults to 1200000.
  --no-skip-missing       Run cases even when --list-models does not show the model.
  --keep-model-loaded     Do not run ollama stop after each case.
  --clean-runtime         Unload all Ollama and LM Studio models before and after each case.
  --dry-run               Write a report with commands without running models.
`;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const { output } = await runBenchmark(options);
  console.log(`Wrote benchmark report: ${output}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
