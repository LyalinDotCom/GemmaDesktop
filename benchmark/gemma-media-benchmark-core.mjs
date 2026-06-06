#!/usr/bin/env node
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureRuntimeModelState,
  cleanupModelAfterRun,
  collectStackMetadata,
  defaultThinkModes,
  endpointForProvider,
  formatMs,
  formatNumber,
  listAvailableModelsByProvider,
  metricsFromJsonStreamEvents,
  modelLoadedBeforeRun,
  parseJsonStreamEvents,
  resetTouchedRuntimeState,
  resolveGemmaCli,
  runProcess,
  safePathPart,
  shellQuoteCommand,
  singleLine,
  tableCell,
  targetOllamaModelIds,
  targetProviderModels,
  timestampForPath,
  unique
} from './gemma-model-throughput.mjs';

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchmarkDir, '..');
const defaultReportsDir = path.join(benchmarkDir, 'reports');
const defaultWorkspacesDir = path.join(benchmarkDir, 'workspaces');
const defaultFixturesDir = path.join(benchmarkDir, 'fixtures', 'media');

export const imageDescriptionFixtures = [{
  id: 'apollo-buzz-aldrin',
  kind: 'image',
  filename: 'apollo-buzz-aldrin.jpg',
  downloadUrl: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/AldrinOnMoon.jpg?width=900',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:AldrinOnMoon.jpg',
  license: 'Public domain, NASA',
  reference: 'NASA photo AS11-40-5869 showing Buzz Aldrin on the Moon during Apollo 11.'
}, {
  id: 'vangogh-starry-night',
  kind: 'image',
  filename: 'vangogh-starry-night.jpg',
  downloadUrl: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/VanGogh-starry%20night.jpg?width=900',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:VanGogh-starry_night.jpg',
  license: 'Public domain mark, faithful reproduction of public-domain artwork',
  reference: 'Vincent van Gogh, The Starry Night, an 1889 oil-on-canvas landscape painting.'
}, {
  id: 'cat-on-snow',
  kind: 'image',
  filename: 'cat-on-snow.jpg',
  downloadUrl: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Felis_catus-cat_on_snow.jpg?width=900',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg',
  license: 'CC BY-SA 3.0 / GNU FDL',
  reference: 'Domestic cat on snow, a ten-month-old female.'
}];

export const audioTranscriptionFixtures = [{
  id: 'apollo-one-small-step',
  kind: 'audio',
  filename: 'apollo-one-small-step.mp3',
  downloadUrl: 'https://www.nasa.gov/wp-content/uploads/2015/01/590331main_ringtone_smallStep.mp3',
  sourceUrl: 'https://www.nasa.gov/historical-sounds/',
  license: 'NASA media usage policy',
  reference: "Neil Armstrong: That's one small step for (a) man, one giant leap for mankind."
}];

export function parseMediaArgs(argv, definition) {
  const options = {
    category: definition.category,
    mediaKind: definition.mediaKind,
    providers: ['ollama'],
    endpoint: undefined,
    providerEndpoints: {},
    cliCommand: process.env.GEMMA_BENCHMARK_CLI,
    cliPath: undefined,
    models: undefined,
    thinkModes: [...defaultThinkModes],
    fixtureIds: definition.fixtures.map((fixture) => fixture.id),
    fixturesDir: defaultFixturesDir,
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
      case '--fixtures':
        options.fixtureIds = splitList(readValue(argv, ++i, arg));
        break;
      case '--fixture':
        options.fixtureIds = [readValue(argv, ++i, arg)];
        break;
      case '--fixtures-dir':
        options.fixturesDir = path.resolve(readValue(argv, ++i, arg));
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
  validateFixtures(options.fixtureIds, definition.fixtures);
  return options;
}

export function buildMediaBenchmarkPlan(options, definition, fixtures = selectedFixtures(options, definition)) {
  const runId = timestampForPath(new Date());
  return unique(options.providers).flatMap((provider) =>
    modelsForProvider(options, provider).flatMap((model) =>
      fixtures.flatMap((fixture) => options.thinkModes.map((think) => ({
        provider,
        model,
        fixture,
        think,
        workspace: path.join(
          options.workspacesDir,
          runId,
          `${provider}-${safePathPart(model)}-${safePathPart(fixture.id)}-think-${think}`
        )
      })))
    )
  );
}

export function buildMediaGemmaCliArgs(options, item, prompt) {
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
    prompt
  ];
  const endpoint = endpointForProvider(options, item.provider);
  if (endpoint) {
    args.splice(4, 0, '--endpoint', endpoint);
  }
  return args;
}

export async function runMediaBenchmark(rawOptions, definition) {
  const options = { ...rawOptions };
  const fixtures = selectedFixtures(options, definition);
  const resolvedFixtures = options.dryRun
    ? fixtures.map((fixture) => resolveFixturePath(fixture, options.fixturesDir))
    : await ensureMediaFixtures(fixtures, options.fixturesDir);
  const cli = resolveGemmaCli(options);
  if (!options.dryRun && options.cliPath) {
    await assertCliExists(options.cliPath);
  }

  const plan = buildMediaBenchmarkPlan(options, definition, resolvedFixtures);
  const availability = options.skipMissing && !options.dryRun
    ? await listAvailableModelsByProvider(options, unique(plan.map((item) => item.provider)))
    : new Map();
  const stack = await collectStackMetadata(options, cli, plan, availability);
  const results = [];

  for (const item of plan) {
    const prompt = definition.prompt(item.fixture);
    const commandArgs = buildMediaGemmaCliArgs(options, item, prompt);
    const fullCommandArgs = [...cli.baseArgs, ...commandArgs];
    const availableModels = availability.get(item.provider);
    if (availableModels?.error) {
      results.push(skipResult(item, cli, fullCommandArgs, availableModels.error));
      continue;
    }
    if (availableModels?.models && !availableModels.models.has(item.model)) {
      results.push(skipResult(item, cli, fullCommandArgs, 'model is not installed'));
      continue;
    }
    if (!modelSupportsMedia(stack, item.provider, item.model, definition.mediaKind)) {
      results.push(skipResult(item, cli, fullCommandArgs, `model is not tagged for ${definition.mediaKind} input`));
      continue;
    }
    if (options.dryRun) {
      results.push({
        provider: item.provider,
        model: item.model,
        fixtureId: item.fixture.id,
        fixtureReference: item.fixture.reference,
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
    const result = await runMediaBenchmarkCase(options, item, cli, commandArgs);
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
    category: definition.title,
    mediaKind: definition.mediaKind,
    providers: unique(plan.map((item) => item.provider)),
    cli: cli.label,
    resetRuntimeBetweenCases: options.resetRuntimeBetweenCases,
    stack,
    fixtures: resolvedFixtures,
    results
  };
  const output = options.output ?? path.join(options.reportsDir, `${definition.reportPrefix}-${timestampForPath(new Date())}.md`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, renderMediaMarkdownReport(report), 'utf8');
  return { report, output };
}

export function renderMediaMarkdownReport(report) {
  const lines = [
    `# ${report.category}`,
    '',
    `Generated: ${report.generatedAt}`,
    `Category: ${report.mediaKind}`,
    `Providers: ${report.providers.join(', ')}`,
    `CLI: ${report.cli}`,
    `Clean runtime reset: ${report.resetRuntimeBetweenCases ? 'enabled' : 'disabled'}`,
    'Prompt tokens are reported from provider usage when available; otherwise the benchmark falls back to an estimated 4 characters per token.',
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
    '## Fixtures',
    '',
    '| Fixture | Kind | Local file | Source | License | Reference |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.fixtures.map((fixture) => fixtureRow(fixture)),
    '',
    '## Results',
    '',
    '| Provider | Model | Fixture | Thinking | Status | Tok/s | Wall tok/s | Tokens | Source | First output | Completion time | Model time | Context | Temp | Max tokens | Output / Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.results.map((result) => mediaResultRow(result, report)),
    ''
  ];

  const notable = report.results.filter((result) => result.status !== 'completed');
  if (notable.length > 0) {
    lines.push('## Skips And Failures', '');
    for (const result of notable) {
      lines.push(`- ${result.provider} / ${result.model} / ${result.fixtureId} / think ${result.think}: ${result.status}${result.error ? ` - ${singleLine(result.error)}` : ''}`);
    }
    lines.push('');
  }

  if (report.resetRuntimeBetweenCases) {
    lines.push('## Runtime Reset Evidence', '');
    for (const result of report.results) {
      lines.push(`- ${result.provider} / ${result.model} / ${result.fixtureId} / think ${result.think}: before ${resetSummary(result.runtimeResetBefore)}; after ${resetSummary(result.cleanup)}`);
    }
    lines.push('');
  }

  const runtimeStateResults = report.results.filter((result) => result.runtimeModelState);
  if (runtimeStateResults.length > 0) {
    lines.push('## Runtime Model State Evidence', '');
    for (const result of runtimeStateResults) {
      lines.push(`- ${result.provider} / ${result.model} / ${result.fixtureId} / think ${result.think}: ${runtimeStateSummary(result.runtimeModelState)}`);
    }
    lines.push('');
  }

  lines.push('## Commands', '');
  for (const result of report.results) {
    lines.push(`### ${result.provider} / ${result.model} / ${result.fixtureId} / think ${result.think}`, '');
    lines.push('```sh');
    lines.push(shellQuoteCommand([result.command, ...result.commandArgs]));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function helpText(definition) {
  return `${definition.title}

Usage:
  node ${definition.entrypoint}
  node ${definition.entrypoint} --providers ollama,lmstudio --think on,off

Options:
  --providers <csv>       Providers to test. Defaults to ollama. Supported: ollama,lmstudio.
  --provider <name>       Test one provider.
  --models <csv>          Models to test for every selected provider. Provider defaults are used when omitted.
  --model <name>          Test one model.
  --think <csv>           Thinking modes. Defaults to on,off.
  --fixtures <csv>        Fixture ids to test. Defaults to all ${definition.mediaKind} fixtures.
  --fixture <id>          Test one fixture.
  --fixtures-dir <path>   Download/read media fixtures from this directory.
  --endpoint <url>        Provider endpoint passed through to Gemma CLI when one provider is selected.
  --ollama-endpoint <url> Ollama endpoint for multi-provider runs.
  --lmstudio-endpoint <url> LM Studio endpoint for multi-provider runs.
  --cli-command <cmd>     Gemma CLI command. Defaults to local node_modules/.bin/gemma, then PATH gemma.
  --cli-path <path>       Development override for a built Gemma CLI index.js.
  --output <path>         Markdown report path.
  --timeout-ms <n>        Per-case timeout. Defaults to 1200000.
  --no-skip-missing       Run cases even when --list-models does not show the model.
  --keep-model-loaded     Do not unload models after each case.
  --clean-runtime         Unload all Ollama and LM Studio models before and after each case.
  --dry-run               Write a report with commands without downloading fixtures or running models.
`;
}

async function runMediaBenchmarkCase(options, item, cli, commandArgs) {
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
  const started = events.findLast((event) => event.type === 'run_started');
  return {
    provider: item.provider,
    model: item.model,
    fixtureId: item.fixture.id,
    fixtureReference: item.fixture.reference,
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
    output: typeof result?.answer === 'string' ? result.answer : undefined,
    outputChars: typeof result?.answer === 'string' ? result.answer.length : undefined,
    metrics: runMetrics?.totals,
    modelCalls: runMetrics?.modelCalls,
    eventCounts: countEvents(events),
    error: failed?.data?.error?.message ?? failed?.data?.error ?? processResult.error ?? (processResult.stderr.trim() || undefined)
  };
}

async function ensureMediaFixtures(fixtures, fixturesDir) {
  await mkdir(fixturesDir, { recursive: true });
  const resolved = [];
  for (const fixture of fixtures) {
    const target = path.join(fixturesDir, fixture.filename);
    if (!(await fileHasBytes(target))) {
      await downloadFixture(fixture, target);
    }
    resolved.push({ ...fixture, localPath: target });
  }
  return resolved;
}

function resolveFixturePath(fixture, fixturesDir) {
  return { ...fixture, localPath: path.join(fixturesDir, fixture.filename) };
}

async function downloadFixture(fixture, target) {
  const response = await fetch(fixture.downloadUrl, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Unable to download ${fixture.id}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Unable to download ${fixture.id}: empty response`);
  }
  await writeFile(target, bytes);
}

async function fileHasBytes(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function selectedFixtures(options, definition) {
  const byId = new Map(definition.fixtures.map((fixture) => [fixture.id, fixture]));
  return options.fixtureIds.map((id) => byId.get(id)).filter(Boolean);
}

function validateFixtures(ids, fixtures) {
  const known = new Set(fixtures.map((fixture) => fixture.id));
  for (const id of ids) {
    if (!known.has(id)) {
      throw new Error(`Unknown fixture: ${id}`);
    }
  }
}

function skipResult(item, cli, commandArgs, error) {
  return {
    provider: item.provider,
    model: item.model,
    fixtureId: item.fixture.id,
    fixtureReference: item.fixture.reference,
    think: item.think,
    workspace: item.workspace,
    status: 'skipped',
    error,
    command: cli.command,
    commandArgs
  };
}

function modelSupportsMedia(stack, provider, model, mediaKind) {
  const metadata = stack?.providers?.[provider]?.models?.[model];
  const capabilities = normalizedCapabilities(metadata?.capabilities ?? metadata?.rawApiModel?.capabilities);
  if (mediaKind === 'image') {
    return capabilities.some((capability) => /vision|image|video/.test(capability))
      || inferModelFamilyMediaSupport(provider, model, mediaKind);
  }
  if (mediaKind === 'audio') {
    return capabilities.some((capability) => /audio|speech/.test(capability))
      || inferModelFamilyMediaSupport(provider, model, mediaKind);
  }
  return false;
}

function inferModelFamilyMediaSupport(provider, model, mediaKind) {
  if (provider !== 'lmstudio') {
    return false;
  }
  const signature = String(model)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const isGemma = signature.includes('gemma');
  const isGemma4 = signature.includes('gemma4');
  const isGemma3n = signature.includes('gemma3n');
  if (!isGemma) {
    return false;
  }
  if (mediaKind === 'image') {
    return isGemma4 || isGemma3n;
  }
  return isGemma3n || signature.includes('gemma4e2b') || signature.includes('gemma4e4b');
}

function normalizedCapabilities(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((capability) => {
      if (typeof capability === 'string') {
        return capability;
      }
      if (capability && typeof capability === 'object') {
        return capability.id ?? capability.name ?? capability.type ?? '';
      }
      return '';
    })
    .map((capability) => String(capability).toLowerCase())
    .filter(Boolean);
}

function fixtureRow(fixture) {
  return [
    fixture.id,
    fixture.kind,
    fixture.localPath,
    fixture.sourceUrl,
    fixture.license,
    fixture.reference
  ].map(tableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function mediaResultRow(result, report) {
  const metrics = result.metrics ?? {};
  const settings = result.settings ?? report.stack?.gemmaCli?.defaults ?? {};
  const context = result.context ?? {};
  const runtimeState = result.runtimeModelState ?? {};
  const outputOrError = result.status === 'completed'
    ? result.output
    : result.error;
  return [
    result.provider,
    result.model,
    result.fixtureId,
    result.think,
    result.status,
    formatNumber(metrics.tokensPerSecond),
    formatNumber(metrics.wallTokensPerSecond),
    formatNumber(metrics.metricOutputTokens),
    metrics.tokenSource ?? '',
    formatMs(firstOutputLatency(result)),
    formatMs(result.wallDurationMs),
    formatMs(metrics.modelCallDurationMs ?? result.cliDurationMs ?? result.wallDurationMs),
    formatNumber(runtimeState.contextLength ?? context.tokens ?? context.loadedTokens ?? context.requestedTokens ?? settings.contextTokens),
    formatNumber(settings.temperature),
    settings.maxTokens ?? '',
    singleLine(outputOrError ?? '')
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
  const capabilities = normalizedCapabilities(metadata.capabilities);
  const parts = [
    metadata.state,
    metadata.contextLength ? `context ${metadata.contextLength}` : undefined,
    metadata.maxContextLength ? `max context ${metadata.maxContextLength}` : undefined,
    metadata.temperature !== undefined ? `temp ${metadata.temperature}` : undefined,
    metadata.quantization ? `quant ${metadata.quantization}` : undefined,
    metadata.family ? `family ${metadata.family}` : undefined,
    capabilities.length > 0 ? `capabilities ${capabilities.join(',')}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'metadata available';
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

async function assertCliExists(cliPath) {
  try {
    await access(cliPath);
  } catch {
    throw new Error(`Gemma CLI build not found at ${cliPath}. Run npm run build:gemma-cli first.`);
  }
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

function validateThinkModes(values) {
  for (const value of values) {
    if (value !== 'on' && value !== 'off' && value !== 'auto') {
      throw new Error('--think values must be on, off, or auto.');
    }
  }
}

function readPositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}
