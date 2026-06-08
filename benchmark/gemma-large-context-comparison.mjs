#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureRuntimeModelState,
  cleanupModelAfterRun,
  collectStackMetadata,
  endpointForProvider,
  formatMs,
  formatNumber,
  listAvailableModelsByProvider,
  metricsFromJsonStreamEvents,
  modelLoadedBeforeRun,
  parseJsonStreamEvents,
  prepareRuntimeForCase,
  resetTouchedRuntimeState,
  resolveGemmaCli,
  runProcess,
  safePathPart,
  shellQuoteCommand,
  singleLine,
  tableCell,
  timestampForPath,
  unique
} from './gemma-model-throughput.mjs';

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchmarkDir, '..');
const defaultReportsDir = path.join(benchmarkDir, 'reports');
const defaultWorkspacesDir = path.join(benchmarkDir, 'workspaces');
const defaultLlamaCppModelsDir = process.env.GEMMA_BENCHMARK_LLAMACPP_MODELS_DIR
  ? path.resolve(process.env.GEMMA_BENCHMARK_LLAMACPP_MODELS_DIR)
  : undefined;

export const largeContextScenarios = [{
  id: 'control',
  label: 'Short control',
  targetEstimatedTokens: 450
}, {
  id: 'prefill-80k',
  label: 'Large prefill, about 80K estimated input tokens',
  targetEstimatedTokens: 80_000
}];

export const largeContextModelTargets = [
  target('ollama', 'gemma4', 'regular', '12b', ['gemma4:12b'], 'Gemma 4 12B'),
  target('ollama', 'gemma4', 'regular', '26b', ['gemma4:26b'], 'Gemma 4 26B'),
  target('ollama', 'gemma4', 'regular', '31b', ['gemma4:31b'], 'Gemma 4 31B'),
  target('ollama', 'gemma4', 'mlx', '12b', [
    'gemma4:12b-mlx',
    'gemma4:12b-nvfp4',
    'gemma4:12b-mxfp8',
    'gemma4:12b-mlx-bf16'
  ], 'Gemma 4 12B MLX'),
  target('ollama', 'gemma4', 'mlx', '26b', [
    'gemma4:26b-mlx',
    'gemma4:26b-nvfp4',
    'gemma4:26b-mxfp8',
    'gemma4:26b-mlx-bf16'
  ], 'Gemma 4 26B MLX'),
  target('ollama', 'gemma4', 'mlx', '31b', [
    'gemma4:31b-mlx',
    'gemma4:31b-nvfp4',
    'gemma4:31b-mxfp8',
    'gemma4:31b-mlx-bf16'
  ], 'Gemma 4 31B MLX'),
  target('ollama', 'qwen3.6', 'regular', '27b', [
    'qwen3.6:27b',
    'qwen3.6:27b-q4_K_M',
    'qwen3.6:27b-mtp-q4_K_M',
    'qwen3.6:27b-coding-mxfp8',
    'qwen3.6:27b-coding-bf16'
  ], 'Qwen 3.6 27B, nearest Gemma 26B comparison', ['qwen3.6', '27b']),
  target('ollama', 'qwen3.6', 'mlx', '27b', [
    'qwen3.6:27b-mlx',
    'qwen3.6:27b-nvfp4',
    'qwen3.6:27b-coding-nvfp4',
    'qwen3.6:27b-coding-mxfp8',
    'qwen3.6:27b-mlx-bf16'
  ], 'Qwen 3.6 27B MLX, nearest Gemma 26B comparison', ['qwen3.6', '27b', 'mlx']),
  target('ollama', 'qwen3.6', 'regular', '35b-a3b', [
    'qwen3.6:35b-a3b',
    'qwen3.6:35b',
    'qwen3.6:latest',
    'qwen3.6:35b-a3b-coding-bf16'
  ], 'Qwen 3.6 35B-A3B, nearest Gemma 31B comparison', ['qwen3.6', '35b-a3b']),
  target('ollama', 'qwen3.6', 'mlx', '35b-a3b', [
    'qwen3.6:35b-mlx',
    'qwen3.6:35b-a3b-mlx',
    'qwen3.6:35b-a3b-coding-nvfp4',
    'qwen3.6:35b-a3b-coding-mxfp8',
    'qwen3.6:35b-a3b-mlx-bf16'
  ], 'Qwen 3.6 35B-A3B MLX, nearest Gemma 31B comparison', ['qwen3.6', '35b-a3b', 'mlx']),

  target('llamacpp', 'gemma4', 'qat-q4_0', 'e2b', ['google/gemma-4-E2B-it-qat-q4_0-gguf'], 'Gemma 4 E2B QAT Q4_0 GGUF'),
  target('llamacpp', 'gemma4', 'qat-q4_0', 'e4b', ['google/gemma-4-E4B-it-qat-q4_0-gguf'], 'Gemma 4 E4B QAT Q4_0 GGUF'),
  target('llamacpp', 'gemma4', 'qat-q4_0', '12b', ['google/gemma-4-12B-it-qat-q4_0-gguf'], 'Gemma 4 12B QAT Q4_0 GGUF'),
  target('llamacpp', 'gemma4', 'qat-q4_0', '26b', ['google/gemma-4-26B-A4B-it-qat-q4_0-gguf'], 'Gemma 4 26B-A4B QAT Q4_0 GGUF'),
  target('llamacpp', 'gemma4', 'qat-q4_0', '31b', ['google/gemma-4-31B-it-qat-q4_0-gguf'], 'Gemma 4 31B QAT Q4_0 GGUF'),

  target('lmstudio', 'gemma4', 'regular', '12b', ['google/gemma-4-12b'], 'Gemma 4 12B'),
  target('lmstudio', 'gemma4', 'regular', '26b', ['google/gemma-4-26b-a4b'], 'Gemma 4 26B'),
  target('lmstudio', 'gemma4', 'regular', '31b', ['google/gemma-4-31b'], 'Gemma 4 31B'),
  target('lmstudio', 'gemma4', 'mlx', '12b', [
    'google/gemma-4-12b-mlx',
    'gemma-4-12b-it@4bit',
    'mlx-community/gemma-4-12B-it-4bit',
    'mlx-community/gemma-4-12B-it-8bit',
    'gemma-4-12b-it-txt-mlx',
    'jedisct1/gemma-4-12B-it-txt-mlx-8bit',
    'mlx-community/gemma-4-12b-it-bf16'
  ], 'Gemma 4 12B MLX', ['gemma-4', '12b', 'mlx'], {
    lmStudioVariantCandidates: [
      'gemma-4-12b-it@4bit',
      'mlx-community/gemma-4-12B-it-4bit',
      'mlx-community/gemma-4-12B-it-8bit',
      'gemma-4-12b-it-txt-mlx',
      'jedisct1/gemma-4-12B-it-txt-mlx-8bit',
      'mlx-community/gemma-4-12b-it-bf16'
    ],
    lmStudioIdentifier: 'benchmark-gemma4-12b-mlx'
  }),
  target('lmstudio', 'gemma4', 'mlx', '26b', [
    'google/gemma-4-26b-a4b-qat',
    'google/gemma-4-26b-a4b-mlx'
  ], 'Gemma 4 26B MLX'),
  target('lmstudio', 'gemma4', 'mlx', '31b', [
    'google/gemma-4-31b-mlx',
    'gemma-4-31b-it-mlx',
    'lmstudio-community/gemma-4-31B-it-MLX-4bit',
    'mlx-community/gemma-4-31b-it-4bit',
    'mlx-community/gemma-4-31b-it-8bit',
    'lmstudio-community/gemma-4-31B-it-MLX-8bit',
    'mlx-community/gemma-4-31b-it-bf16'
  ], 'Gemma 4 31B MLX', ['gemma-4', '31b', 'mlx'], {
    lmStudioVariantCandidates: [
      'gemma-4-31b-it-mlx',
      'lmstudio-community/gemma-4-31B-it-MLX-4bit',
      'mlx-community/gemma-4-31b-it-4bit',
      'mlx-community/gemma-4-31b-it-8bit',
      'lmstudio-community/gemma-4-31B-it-MLX-8bit',
      'mlx-community/gemma-4-31b-it-bf16'
    ],
    lmStudioIdentifier: 'benchmark-gemma4-31b-mlx'
  }),
  target('lmstudio', 'qwen3.6', 'regular', '27b', [
    'qwen/qwen3.6-27b'
  ], 'Qwen 3.6 27B GGUF, nearest Gemma 26B comparison', ['qwen3.6', '27b'], {
    lmStudioVariantCandidates: ['qwen/qwen3.6-27b@q4_k_m'],
    lmStudioIdentifier: 'benchmark-qwen36-27b-gguf'
  }),
  target('lmstudio', 'qwen3.6', 'mlx', '27b', [
    'qwen/qwen3.6-27b'
  ], 'Qwen 3.6 27B MLX, nearest Gemma 26B comparison', ['qwen3.6', '27b', 'mlx'], {
    lmStudioVariantCandidates: ['qwen/qwen3.6-27b@4bit'],
    lmStudioIdentifier: 'benchmark-qwen36-27b-mlx'
  }),
  target('lmstudio', 'qwen3.6', 'regular', '35b-a3b', [
    'qwen/qwen3.6-35b-a3b'
  ], 'Qwen 3.6 35B-A3B GGUF, nearest Gemma 31B comparison', ['qwen3.6', '35b-a3b'], {
    lmStudioVariantCandidates: ['qwen/qwen3.6-35b-a3b@q4_k_m'],
    lmStudioIdentifier: 'benchmark-qwen36-35b-a3b-gguf'
  }),
  target('lmstudio', 'qwen3.6', 'mlx', '35b-a3b', [
    'qwen/qwen3.6-35b-a3b'
  ], 'Qwen 3.6 35B-A3B MLX, nearest Gemma 31B comparison', ['qwen3.6', '35b-a3b', 'mlx'], {
    lmStudioVariantCandidates: ['qwen/qwen3.6-35b-a3b@4bit'],
    lmStudioIdentifier: 'benchmark-qwen36-35b-a3b-mlx'
  })
];

export function parseLargeContextArgs(argv) {
  const options = {
    providers: ['ollama', 'lmstudio'],
    endpoint: undefined,
    providerEndpoints: {},
    cliCommand: process.env.GEMMA_BENCHMARK_CLI,
    cliPath: undefined,
    models: undefined,
    targetIds: undefined,
    scenarios: largeContextScenarios.map((scenario) => scenario.id),
    thinkModes: ['on', 'off'],
    output: undefined,
    reportsDir: defaultReportsDir,
    workspacesDir: defaultWorkspacesDir,
    timeoutMs: 45 * 60 * 1000,
    skipMissing: true,
    keepModelLoaded: false,
    resetRuntimeBetweenCases: true,
    llamaCppModelsDir: defaultLlamaCppModelsDir,
    llamaCppServerCommand: process.env.GEMMA_BENCHMARK_LLAMACPP_SERVER ?? 'llama-server',
    llamaCppStartupTimeoutMs: 10 * 60 * 1000,
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
      case '--llamacpp-endpoint':
      case '--llama-cpp-endpoint':
        options.providerEndpoints.llamacpp = readValue(argv, ++i, arg);
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
      case '--targets':
        options.targetIds = splitList(readValue(argv, ++i, arg));
        break;
      case '--target':
        options.targetIds = [readValue(argv, ++i, arg)];
        break;
      case '--scenario':
        options.scenarios = [readScenario(readValue(argv, ++i, arg))];
        break;
      case '--scenarios':
        options.scenarios = splitList(readValue(argv, ++i, arg)).map(readScenario);
        break;
      case '--think':
        options.thinkModes = splitList(readValue(argv, ++i, arg));
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
      case '--llamacpp-models-dir':
      case '--llama-cpp-models-dir':
        options.llamaCppModelsDir = path.resolve(readValue(argv, ++i, arg));
        break;
      case '--llamacpp-server-command':
      case '--llama-cpp-server-command':
        options.llamaCppServerCommand = readValue(argv, ++i, arg);
        break;
      case '--llamacpp-startup-timeout-ms':
      case '--llama-cpp-startup-timeout-ms':
        options.llamaCppStartupTimeoutMs = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--no-skip-missing':
        options.skipMissing = false;
        break;
      case '--keep-model-loaded':
        options.keepModelLoaded = true;
        break;
      case '--clean-runtime':
      case '--reset-runtime-between-cases':
        options.resetRuntimeBetweenCases = true;
        break;
      case '--no-clean-runtime':
      case '--no-reset-runtime-between-cases':
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

  validateThinkModes(options.thinkModes);
  if (options.providers.length === 0) {
    throw new Error('At least one provider is required.');
  }
  return options;
}

export function buildLargeContextBenchmarkPlan(options, availability = new Map()) {
  const runId = timestampForPath(new Date());
  const scenarios = options.scenarios.map((id) => scenarioById(id));
  return largeContextModelTargets
    .filter((targetItem) => options.providers.includes(targetItem.provider))
    .filter((targetItem) => targetMatchesFilter(targetItem, options))
    .flatMap((targetItem) => {
      const resolved = resolveLargeContextTargetModel(targetItem, availability.get(targetItem.provider));
      return scenarios.flatMap((scenario) => options.thinkModes.map((think) => ({
        ...targetItem,
        ...resolved,
        scenario: scenario.id,
        scenarioLabel: scenario.label,
        scenarioTargetEstimatedTokens: scenario.targetEstimatedTokens,
        think,
        workspace: path.join(
          options.workspacesDir,
          runId,
          [
            targetItem.provider,
            safePathPart(resolved.model),
            safePathPart(scenario.id),
            `think-${think}`
          ].join('-')
        )
      })));
    });
}

export function resolveLargeContextTargetModel(targetItem, availableModels) {
  const modelSet = availableModels instanceof Set ? availableModels : availableModels?.models;
  const lmStudioVariantsByKey = availableModels instanceof Set ? undefined : availableModels?.lmStudioVariantsByKey;
  const lmStudioModelsByKey = availableModels instanceof Set ? undefined : availableModels?.lmStudioModelsByKey;

  if (targetItem.lmStudioVariantCandidates) {
    const defaultVariant = targetItem.lmStudioVariantCandidates[0];
    const defaultIdentifier = targetItem.lmStudioIdentifier ?? safePathPart(defaultVariant);
    if (!availableModels) {
      return {
        model: defaultIdentifier,
        runtimeModelKey: defaultVariant,
        lmStudioLoadModelKey: defaultVariant,
        selectedFrom: 'default-lmstudio-variant'
      };
    }
    if (!lmStudioVariantsByKey && !lmStudioModelsByKey) {
      return {
        model: defaultIdentifier,
        runtimeModelKey: defaultVariant,
        lmStudioLoadModelKey: defaultVariant,
        selectedFrom: 'missing-lmstudio-variant-inventory',
        missingCandidates: targetItem.lmStudioVariantCandidates
      };
    }
    const modelKey = targetItem.lmStudioVariantCandidates.find((candidate) => lmStudioModelsByKey?.has(candidate));
    if (modelKey) {
      const modelInfo = lmStudioModelsByKey.get(modelKey);
      const loadModelKey = modelInfo?.modelKey ?? modelKey;
      return {
        model: targetItem.lmStudioIdentifier ?? safePathPart(loadModelKey),
        runtimeModelKey: loadModelKey,
        lmStudioLoadModelKey: loadModelKey,
        lmStudioVariantFormat: modelInfo?.format,
        lmStudioVariantQuantization: quantizationName(modelInfo?.quantization),
        selectedFrom: 'installed-lmstudio-model'
      };
    }
    const variantKey = targetItem.lmStudioVariantCandidates.find((candidate) => lmStudioVariantsByKey?.has(candidate));
    if (variantKey) {
      const variantInfo = lmStudioVariantsByKey.get(variantKey);
      return {
        model: targetItem.lmStudioIdentifier ?? safePathPart(variantInfo?.modelKey ?? variantKey),
        runtimeModelKey: variantInfo?.modelKey ?? variantKey,
        lmStudioLoadModelKey: variantInfo?.modelKey ?? variantKey,
        lmStudioVariantFormat: variantInfo?.format,
        lmStudioVariantQuantization: quantizationName(variantInfo?.quantization),
        selectedFrom: 'installed-lmstudio-variant'
      };
    }
    return {
      model: defaultIdentifier,
      runtimeModelKey: defaultVariant,
      lmStudioLoadModelKey: defaultVariant,
      selectedFrom: 'missing-lmstudio-variant',
      missingCandidates: targetItem.lmStudioVariantCandidates
    };
  }

  if (!modelSet) {
    return { model: targetItem.candidates[0], selectedFrom: 'default-candidate' };
  }
  const exact = targetItem.candidates.find((candidate) => modelSet.has(candidate));
  if (exact) {
    return { model: exact, selectedFrom: 'installed-candidate' };
  }
  const fuzzyMatches = [...modelSet].filter((model) =>
    targetItem.matchTerms.every((term) => model.toLowerCase().includes(term.toLowerCase()))
  );
  if (fuzzyMatches.length === 1) {
    return { model: fuzzyMatches[0], selectedFrom: 'installed-fuzzy-match' };
  }
  return {
    model: targetItem.candidates[0],
    selectedFrom: fuzzyMatches.length > 1 ? 'ambiguous-fuzzy-match' : 'missing',
    missingCandidates: targetItem.candidates,
    ambiguousMatches: fuzzyMatches.length > 1 ? fuzzyMatches : undefined
  };
}

export function buildLargeContextGemmaCliArgs(options, item, prompt) {
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

export function buildLargeContextPrompt(scenarioId) {
  const scenario = scenarioById(scenarioId);
  const corpus = buildNeedleCorpus(scenario.targetEstimatedTokens);
  const prompt = [
    'You are participating in a local-model benchmark.',
    'Read the complete corpus below, then return only one compact JSON object.',
    'Use keys: status, needle_count, last_marker, note.',
    'Set status to "ok". Count every line containing NEEDLE_TOKEN. Use the exact FINAL_MARKER value as last_marker.',
    '',
    'CORPUS START',
    corpus.text,
    'CORPUS END'
  ].join('\n');
  return {
    scenario: scenario.id,
    label: scenario.label,
    targetEstimatedTokens: scenario.targetEstimatedTokens,
    prompt,
    promptChars: prompt.length,
    promptEstimatedTokens: estimateTokens(prompt.length),
    promptSha256: sha256(prompt),
    expectedNeedles: corpus.needleCount,
    expectedLastMarker: corpus.lastMarker
  };
}

export function renderLargeContextMarkdownReport(report) {
  const lines = [
    '# Gemma Large Context Comparison Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    'Category: large-context',
    `Providers: ${report.providers.join(', ')}`,
    `CLI: ${report.cli}`,
    `Clean runtime reset: ${report.resetRuntimeBetweenCases ? 'enabled' : 'disabled'}`,
    'Prompt tokens are reported from provider usage when available; otherwise the benchmark falls back to an estimated 4 characters per token.',
    '',
    '## Unified Run Summary',
    '',
    `- Result rows: ${report.results.filter((result) => result.status === 'completed').length} / ${report.results.length} completed.`,
    '- Scope: Ollama and LM Studio Gemma 4 regular/MLX targets at 12B, 26B, and 31B where installed, llama.cpp Google QAT Q4_0 GGUF targets where local files are present, plus nearest locally available Qwen 3.6 comparison targets.',
    '- Large-context scenario: about 80K estimated input tokens, built as deterministic local text and passed through Gemma CLI without generation-tuning flags.',
    '- Qwen comparison note: Qwen 3.6 does not currently expose a close 12B target in the local catalogs used by this benchmark; 27B and 35B-A3B are preserved as nearest comparison rows.',
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
    'Prompts are generated by scenario at run time. Full long-context prompt bodies are not embedded here to keep the report inspectable.',
    ...report.scenarios.map((scenario) =>
      `${scenario.id}: target=${scenario.targetEstimatedTokens} est tokens, actual=${scenario.promptEstimatedTokens} est tokens, chars=${scenario.promptChars}, sha256=${scenario.promptSha256}, expected needles=${scenario.expectedNeedles}, expected marker=${scenario.expectedLastMarker}`
    ),
    '```',
    '',
    '## Scenarios',
    '',
    '| Scenario | Label | Target est tokens | Prompt est tokens | Prompt chars | Expected needles | Expected marker | Prompt sha256 |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.scenarios.map((scenario) => [
      scenario.id,
      scenario.label,
      formatNumber(scenario.targetEstimatedTokens),
      formatNumber(scenario.promptEstimatedTokens),
      formatNumber(scenario.promptChars),
      formatNumber(scenario.expectedNeedles),
      scenario.expectedLastMarker,
      scenario.promptSha256
    ].map(tableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
    '## Results',
    '',
    '| Provider | Family | Variant | Scale | Model | Runtime key | Scenario | Thinking | Status | Tok/s | Wall tok/s | Tokens | Source | First output | Completion time | Model time | Context | Temp | Max tokens | Prompt est tokens | Prompt chars | Answer chars | Output / Error |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |',
    ...report.results.map((result) => largeContextResultRow(result, report)),
    ''
  ];

  const notable = report.results.filter((result) => result.status !== 'completed');
  if (notable.length > 0) {
    lines.push('## Skips And Failures', '');
    for (const result of notable) {
      lines.push(`- ${caseLabel(result)}: ${result.status}${result.error ? ` - ${singleLine(result.error)}` : ''}`);
    }
    lines.push('');
  }

  if (report.resetRuntimeBetweenCases) {
    lines.push('## Runtime Reset Evidence', '');
    for (const result of report.results) {
      lines.push(`- ${caseLabel(result)}: before ${resetSummary(result.runtimeResetBefore)}; after ${resetSummary(result.cleanup)}`);
    }
    lines.push('');
  }

  const runtimeStateResults = report.results.filter((result) => result.runtimeModelState);
  if (runtimeStateResults.length > 0) {
    lines.push('## Runtime Model State Evidence', '');
    for (const result of runtimeStateResults) {
      lines.push(`- ${caseLabel(result)}: ${runtimeStateSummary(result.runtimeModelState)}`);
    }
    lines.push('');
  }

  const preparedResults = report.results.filter((result) => result.runtimePreparation);
  if (preparedResults.length > 0) {
    lines.push('## Runtime Variant Load Evidence', '');
    for (const result of preparedResults) {
      lines.push(`- ${caseLabel(result)}: ${runtimePreparationSummary(result.runtimePreparation)}`);
    }
    lines.push('');
  }

  lines.push('## Commands', '');
  for (const result of report.results) {
    lines.push(`### ${caseLabel(result)}`, '');
    lines.push('```sh');
    lines.push(shellQuoteCommand([result.command, ...(result.commandDisplayArgs ?? result.commandArgs ?? [])]));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function runLargeContextBenchmark(rawOptions) {
  const options = { ...rawOptions };
  const cli = resolveGemmaCli(options);
  const targetProviders = unique(largeContextModelTargets
    .filter((targetItem) => options.providers.includes(targetItem.provider))
    .map((targetItem) => targetItem.provider));
  const availability = options.skipMissing && !options.dryRun
    ? await listAvailableModelsByProvider(options, targetProviders)
    : new Map();
  if (options.skipMissing && !options.dryRun && availability.has('lmstudio')) {
    await addLmStudioVariantAvailability(availability);
  }
  const plan = buildLargeContextBenchmarkPlan(options, availability);
  const stack = await collectStackMetadata(options, cli, plan, availability);
  const scenarioBundles = Object.fromEntries(options.scenarios.map((scenario) => {
    const bundle = buildLargeContextPrompt(scenario);
    return [scenario, bundle];
  }));
  const results = [];

  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    process.stderr.write(`[${index + 1}/${plan.length}] ${caseLabel(item)}\n`);
    const promptBundle = scenarioBundles[item.scenario];
    const commandArgs = buildLargeContextGemmaCliArgs(options, item, promptBundle.prompt);
    const fullCommandArgs = [...cli.baseArgs, ...commandArgs];
    const commandDisplayArgs = [...cli.baseArgs, ...displayArgsForPrompt(commandArgs, promptBundle)];
    const availableModels = availability.get(item.provider);
    const baseResult = {
      ...resultMetadata(item, promptBundle),
      command: cli.command,
      commandArgs: fullCommandArgs,
      commandDisplayArgs,
      workspace: item.workspace
    };

    if (availableModels?.error) {
      results.push({
        ...baseResult,
        status: 'skipped',
        error: availableModels.error
      });
      process.stderr.write(`  skipped: ${singleLine(availableModels.error)}\n`);
      continue;
    }
    if (item.selectedFrom === 'ambiguous-fuzzy-match') {
      results.push({
        ...baseResult,
        status: 'skipped',
        error: `ambiguous installed model match; candidates: ${item.ambiguousMatches.join(', ')}`
      });
      process.stderr.write('  skipped: ambiguous installed model match\n');
      continue;
    }
    if (item.selectedFrom === 'missing-lmstudio-variant-inventory') {
      results.push({
        ...baseResult,
        status: 'skipped',
        error: `unable to inspect LM Studio downloaded variants; candidates: ${item.missingCandidates?.join(', ') ?? item.lmStudioVariantCandidates.join(', ')}`
      });
      process.stderr.write('  skipped: unable to inspect LM Studio downloaded variants\n');
      continue;
    }
    if (item.selectedFrom === 'missing-lmstudio-variant') {
      results.push({
        ...baseResult,
        status: 'skipped',
        error: `LM Studio variant is not installed; candidates: ${item.missingCandidates?.join(', ') ?? item.lmStudioVariantCandidates.join(', ')}`
      });
      process.stderr.write('  skipped: LM Studio variant is not installed\n');
      continue;
    }
    if (!item.lmStudioLoadModelKey && availableModels?.models && !availableModels.models.has(item.model)) {
      results.push({
        ...baseResult,
        status: 'skipped',
        error: `model is not installed; candidates: ${item.missingCandidates?.join(', ') ?? item.candidates.join(', ')}`
      });
      process.stderr.write('  skipped: model is not installed\n');
      continue;
    }
    if (options.dryRun) {
      results.push({
        ...baseResult,
        status: 'dry-run'
      });
      process.stderr.write('  dry-run\n');
      continue;
    }

    await mkdir(item.workspace, { recursive: true });
    let runtimeResetBefore;
    let preparedRuntime;
    let loadedBeforeRun = false;
    let result;
    try {
      runtimeResetBefore = options.resetRuntimeBetweenCases
        ? await resetTouchedRuntimeState(options, options.providers)
        : undefined;
      preparedRuntime = await prepareLargeContextRuntimeForCase(options, item);
      loadedBeforeRun = preparedRuntime ? false : await modelLoadedBeforeRun(options, item);
      result = await runLargeContextCase(options, item, cli, commandArgs, promptBundle);
      result.runtimeModelState = await captureRuntimeModelState(options, item);
      if (preparedRuntime?.summary) {
        result.runtimePreparation = preparedRuntime.summary;
      }
    } catch (error) {
      result = {
        ...baseResult,
        status: 'failed',
        runtimePreparation: preparedRuntime?.summary,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (runtimeResetBefore) {
      result.runtimeResetBefore = runtimeResetBefore;
    }
    results.push(result);
    process.stderr.write(`  ${result.status}${result.error ? `: ${singleLine(result.error)}` : ''}\n`);
    if (!options.keepModelLoaded) {
      const providerCleanup = await cleanupModelAfterRun(options, item, loadedBeforeRun, preparedRuntime);
      result.cleanup = options.resetRuntimeBetweenCases
        ? {
            ...(await resetTouchedRuntimeState(options, options.providers)),
            [`${item.provider}:case`]: providerCleanup
          }
        : providerCleanup;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    category: 'large-context',
    providers: unique(plan.map((item) => item.provider)),
    cli: cli.label,
    resetRuntimeBetweenCases: options.resetRuntimeBetweenCases,
    stack,
    scenarios: Object.values(scenarioBundles),
    results
  };
  const output = options.output ?? path.join(options.reportsDir, `gemma-large-context-comparison-${timestampForPath(new Date())}.md`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, renderLargeContextMarkdownReport(report), 'utf8');
  return { report, output };
}

async function addLmStudioVariantAvailability(availability) {
  const entry = availability.get('lmstudio');
  if (!entry || entry.error) {
    return;
  }
  try {
    const models = await listLmStudioModels();
    const groups = await listLmStudioVariantGroups();
    const variants = groups.flatMap((group) => group.variants ?? []);
    entry.lmStudioModels = models;
    entry.lmStudioModelsByKey = indexLmStudioModelKeys(models);
    entry.lmStudioVariantGroups = groups;
    entry.lmStudioVariantsByKey = indexLmStudioModelKeys(variants);
  } catch (error) {
    entry.lmStudioVariantGroups = [];
    entry.lmStudioVariantError = error instanceof Error ? error.message : String(error);
  }
}

async function listLmStudioModels() {
  const result = await runProcess('lms', ['ls', '--json'], {
    cwd: repoRoot,
    timeoutMs: 60_000
  });
  if (result.exitCode !== 0) {
    throw new Error(result.error ?? (result.stderr.trim() || result.stdout.trim() || 'lms ls failed'));
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('lms ls --json returned a non-array payload.');
  }
  return parsed;
}

async function listLmStudioVariantGroups() {
  const result = await runProcess('lms', ['ls', '--variants', '--json'], {
    cwd: repoRoot,
    timeoutMs: 60_000
  });
  if (result.exitCode !== 0) {
    throw new Error(result.error ?? (result.stderr.trim() || result.stdout.trim() || 'lms ls --variants failed'));
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('lms ls --variants --json returned a non-array payload.');
  }
  return parsed;
}

function indexLmStudioModelKeys(models) {
  const index = new Map();
  for (const model of models) {
    for (const key of [model?.modelKey, model?.indexedModelIdentifier, model?.path].filter(Boolean)) {
      index.set(key, model);
    }
  }
  return index;
}

async function prepareLargeContextRuntimeForCase(options, item) {
  if (item.provider === 'llamacpp') {
    return prepareRuntimeForCase(options, item);
  }
  if (item.provider !== 'lmstudio' || !item.lmStudioLoadModelKey) {
    return undefined;
  }
  const sdkCwd = await findLmStudioSdkCwd();
  if (!sdkCwd) {
    throw new Error('LM Studio exact variant rows require the LM Studio SDK bundled with the local runtime; no @lmstudio/sdk install was found under ~/.lmstudio.');
  }
  const load = await loadLmStudioVariantWithSdk(sdkCwd, item.lmStudioLoadModelKey, item.model, options.timeoutMs);
  return {
    summary: {
      provider: 'lmstudio',
      managed: true,
      model: item.model,
      runtimeModelKey: item.lmStudioLoadModelKey,
      sdkCwd,
      ...load
    },
    cleanup: async () => unloadPreparedLmStudioIdentifier(item.model)
  };
}

async function findLmStudioSdkCwd() {
  const candidates = [
    process.env.GEMMA_BENCHMARK_LMSTUDIO_SDK_DIR,
    path.join(os.homedir(), '.lmstudio/extensions/plugins/lmstudio/rag-v1'),
    path.join(os.homedir(), 'Library/Application Support/LM Studio/extensions/plugins/lmstudio/rag-v1')
  ].filter(Boolean);
  for (const candidate of candidates) {
    const packagePath = path.join(candidate, 'node_modules/@lmstudio/sdk/package.json');
    try {
      await access(packagePath);
      return candidate;
    } catch {
      // Try the next local LM Studio SDK location.
    }
  }
  return undefined;
}

async function loadLmStudioVariantWithSdk(sdkCwd, modelKey, identifier, timeoutMs) {
  const script = `
(async () => {
  const { LMStudioClient } = require('@lmstudio/sdk');
  const [modelKey, identifier] = process.argv.slice(1);
  const client = new LMStudioClient();
  const model = await client.llm.load(modelKey, { identifier, ttl: 3600, verbose: false });
  const loadConfig = typeof model.getLoadConfig === 'function' ? await model.getLoadConfig() : undefined;
  const contextLength = typeof model.getContextLength === 'function' ? await model.getContextLength() : undefined;
  console.log(JSON.stringify({
    identifier: model.identifier,
    path: model.path,
    modelKey: model.modelKey,
    format: model.format,
    contextLength,
    maxContextLength: model.maxContextLength,
    quantization: model.quantization,
    loadConfig
  }));
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`;
  const result = await runProcess(process.execPath, ['-e', script, modelKey, identifier], {
    cwd: sdkCwd,
    timeoutMs
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to load LM Studio variant ${modelKey} as ${identifier}: ${singleLine(result.error ?? (result.stderr || result.stdout))}`);
  }
  const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`LM Studio variant loader did not return metadata for ${modelKey}.`);
  }
  return JSON.parse(line);
}

async function unloadPreparedLmStudioIdentifier(identifier) {
  const result = await runProcess('lms', ['unload', identifier], {
    cwd: repoRoot,
    timeoutMs: 60_000
  });
  return {
    ok: result.exitCode === 0,
    unloadedModels: result.exitCode === 0 ? [identifier] : [],
    output: [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim()
  };
}

async function runLargeContextCase(options, item, cli, commandArgs, promptBundle) {
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
  const output = typeof result?.answer === 'string' ? result.answer : undefined;
  const error = failed?.data?.error?.message ?? failed?.data?.error ?? processResult.error ?? (processResult.stderr.trim() || undefined);
  return {
    ...resultMetadata(item, promptBundle),
    workspace: item.workspace,
    status: processResult.timedOut
      ? 'timeout'
      : processResult.exitCode === 0 && result
        ? 'completed'
        : 'failed',
    command: cli.command,
    commandArgs: fullCommandArgs,
    commandDisplayArgs: [...cli.baseArgs, ...displayArgsForPrompt(commandArgs, promptBundle)],
    wallDurationMs: Date.now() - startedAt,
    cliDurationMs: result?.stats?.durationMs,
    selectedModel: result?.selectedModel ?? started?.data?.selectedModel,
    context: result?.context ?? started?.data?.context,
    settings: result?.settings ?? started?.data?.settings,
    answerChars: output?.length,
    output,
    metrics,
    modelCalls: runMetrics?.modelCalls,
    error
  };
}

function target(provider, family, variant, scale, candidates, description, matchTerms = [], extra = {}) {
  return {
    id: `${provider}:${family}:${variant}:${scale}`,
    provider,
    family,
    variant,
    scale,
    candidates,
    description,
    matchTerms: matchTerms.length > 0 ? matchTerms : candidates[0].split(/[:/_-]+/).filter(Boolean),
    ...extra
  };
}

function resultMetadata(item, promptBundle) {
  return {
    provider: item.provider,
    family: item.family,
    variant: item.variant,
    scale: item.scale,
    model: item.model,
    runtimeModelKey: item.runtimeModelKey,
    lmStudioLoadModelKey: item.lmStudioLoadModelKey,
    lmStudioVariantFormat: item.lmStudioVariantFormat,
    lmStudioVariantQuantization: item.lmStudioVariantQuantization,
    targetId: item.id,
    targetDescription: item.description,
    selectedFrom: item.selectedFrom,
    scenario: item.scenario,
    scenarioLabel: item.scenarioLabel,
    scenarioTargetEstimatedTokens: item.scenarioTargetEstimatedTokens,
    promptChars: promptBundle.promptChars,
    promptEstimatedTokens: promptBundle.promptEstimatedTokens,
    promptSha256: promptBundle.promptSha256,
    expectedNeedles: promptBundle.expectedNeedles,
    expectedLastMarker: promptBundle.expectedLastMarker,
    think: item.think
  };
}

function buildNeedleCorpus(targetEstimatedTokens) {
  const targetChars = Math.max(800, (targetEstimatedTokens * 4) - 900);
  const lines = [];
  let charCount = 0;
  let needleCount = 0;
  while (charCount < targetChars) {
    const lineNumber = lines.length + 1;
    let line;
    if (lineNumber % 89 === 0) {
      needleCount += 1;
      line = `line ${lineNumber}: NEEDLE_TOKEN marker=${String(needleCount).padStart(4, '0')} keep this count exact while scanning the benchmark corpus.`;
    } else {
      line = [
        `line ${lineNumber}:`,
        'ordinary benchmark context about local inference runtimes, model loading, prompt prefill, and response latency;',
        `checksum=${(lineNumber * 7919) % 104729};`,
        'do not summarize this line unless it contains the explicit marker token.'
      ].join(' ');
    }
    lines.push(line);
    charCount += line.length + 1;
  }
  const lastMarker = `FINAL_MARKER LC-${lines.length}-${needleCount}`;
  lines.push(lastMarker);
  return {
    text: lines.join('\n'),
    needleCount,
    lastMarker
  };
}

function largeContextResultRow(result, report) {
  const metrics = result.metrics ?? {};
  const settings = result.settings ?? report.stack?.gemmaCli?.defaults ?? {};
  const context = result.context ?? {};
  const runtimeState = result.runtimeModelState ?? {};
  return [
    result.provider,
    result.family,
    result.variant,
    result.scale,
    result.model,
    result.runtimeModelKey ?? result.lmStudioLoadModelKey ?? '',
    result.scenario,
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
    formatNumber(result.promptEstimatedTokens),
    formatNumber(result.promptChars),
    formatNumber(result.answerChars),
    singleLine(result.output ?? result.error ?? '')
  ].map(tableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function caseLabel(result) {
  return `${result.provider} / ${result.model} / scenario ${result.scenario} / think ${result.think}`;
}

function displayArgsForPrompt(commandArgs, promptBundle) {
  const args = [...commandArgs];
  const promptIndex = args.indexOf('--prompt');
  if (promptIndex >= 0) {
    args[promptIndex + 1] = `<${promptBundle.scenario} prompt omitted: chars=${promptBundle.promptChars} est_tokens=${promptBundle.promptEstimatedTokens} sha256=${promptBundle.promptSha256}>`;
  }
  return args;
}

function targetMatchesFilter(targetItem, options) {
  if (options.targetIds && !options.targetIds.includes(targetItem.id)) {
    return false;
  }
  if (!options.models) {
    return true;
  }
  return options.models.some((model) =>
    targetItem.candidates.includes(model)
    || targetItem.lmStudioVariantCandidates?.includes(model)
    || targetItem.lmStudioIdentifier === model
    || targetItem.id === model
    || targetItem.description.toLowerCase().includes(model.toLowerCase())
  );
}

function scenarioById(id) {
  const scenario = largeContextScenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${id}`);
  }
  return scenario;
}

function readScenario(value) {
  scenarioById(value);
  return value;
}

function validateThinkModes(values) {
  for (const value of values) {
    if (value !== 'on' && value !== 'off' && value !== 'auto') {
      throw new Error('--think values must be on, off, or auto.');
    }
  }
}

function readProvider(value) {
  const normalized = value.toLowerCase();
  if (normalized === 'ollama' || normalized === 'lmstudio' || normalized === 'llamacpp') {
    return normalized;
  }
  if (normalized === 'lm-studio' || normalized === 'lm_studio') {
    return 'lmstudio';
  }
  if (normalized === 'llama.cpp' || normalized === 'llama-cpp' || normalized === 'llama_cpp') {
    return 'llamacpp';
  }
  throw new Error('Provider values must be ollama, lmstudio, or llamacpp for this benchmark.');
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

function readPositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function estimateTokens(chars) {
  return Math.round(chars / 4);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function quantizationName(value) {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'object') {
    return value.name ?? value.quantization ?? JSON.stringify(value);
  }
  return String(value);
}

function firstOutputLatency(result) {
  const calls = result.modelCalls;
  if (Array.isArray(calls)) {
    const first = calls.find((call) => typeof call.firstOutputLatencyMs === 'number');
    return first?.firstOutputLatencyMs;
  }
  return undefined;
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
    metadata.parameterSize ?? metadata.parameters,
    metadata.quantization ? `quant ${metadata.quantization}` : undefined,
    Array.isArray(metadata.capabilities) && metadata.capabilities.length > 0 ? `capabilities ${metadata.capabilities.join(',')}` : undefined
  ].filter(Boolean);
  return parts.join(', ') || 'metadata unavailable';
}

function runtimeStateSummary(state) {
  if (!state) {
    return 'unavailable';
  }
  if (state.error) {
    return `error ${singleLine(state.error)}`;
  }
  const parts = [
    state.state,
    state.status,
    state.modelKey ? `model key ${state.modelKey}` : undefined,
    state.format ? `format ${state.format}` : undefined,
    state.contextLength ? `context ${state.contextLength}` : undefined,
    state.maxContextLength ? `max context ${state.maxContextLength}` : undefined,
    state.processor ? `processor ${state.processor}` : undefined,
    state.quantization ? `quant ${state.quantization}` : undefined
  ].filter(Boolean);
  return parts.join(', ') || 'unavailable';
}

function runtimePreparationSummary(preparation) {
  if (!preparation) {
    return 'unavailable';
  }
  const parts = [
    preparation.runtimeModelKey ? `loaded ${preparation.runtimeModelKey}` : undefined,
    preparation.identifier ? `as ${preparation.identifier}` : preparation.model ? `as ${preparation.model}` : undefined,
    preparation.format ? `format ${preparation.format}` : undefined,
    quantizationName(preparation.quantization) ? `quant ${quantizationName(preparation.quantization)}` : undefined,
    preparation.contextLength ? `context ${preparation.contextLength}` : undefined,
    preparation.maxContextLength ? `max context ${preparation.maxContextLength}` : undefined
  ].filter(Boolean);
  return parts.join(', ') || 'available';
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

function helpText() {
  return `Gemma large-context comparison benchmark

Usage:
  node gemma-large-context-comparison.mjs
  node gemma-large-context-comparison.mjs --scenario prefill-80k --think off
  node gemma-large-context-comparison.mjs --providers ollama,lmstudio --clean-runtime
  node gemma-large-context-comparison.mjs --providers llamacpp --llamacpp-models-dir /models/google-gemma4-gguf

Options:
  --provider <name>       Runtime provider: ollama, lmstudio, or llamacpp.
  --providers <csv>       Runtime providers. Defaults to ollama,lmstudio.
  --model <id>            Limit to targets that include a model candidate.
  --models <csv>          Limit to targets that include any model candidate.
  --target <id>           Limit to a target id such as ollama:gemma4:regular:26b.
  --targets <csv>         Limit to target ids.
  --scenario <id>         Scenario: control or prefill-80k.
  --scenarios <csv>       Scenario ids. Defaults to control,prefill-80k.
  --think <csv>           Thinking modes: on,off,auto. Defaults to on,off.
  --ollama-endpoint <url> Override Ollama endpoint.
  --lmstudio-endpoint <url> Override LM Studio endpoint.
  --llamacpp-endpoint <url> Override llama.cpp endpoint.
  --llamacpp-models-dir <path> Directory of Google-owned QAT GGUF files. When set, the benchmark starts llama-server per case.
  --llamacpp-server-command <cmd> llama-server command for managed llama.cpp cases. Defaults to llama-server.
  --llamacpp-startup-timeout-ms <number> Timeout while waiting for managed llama.cpp startup.
  --cli-path <path>       Use a local Gemma CLI JS entrypoint.
  --cli-command <cmd>     Use a Gemma CLI command from PATH.
  --output <path>         Markdown report path.
  --reports-dir <path>    Report output directory.
  --workspaces-dir <path> Workspace root.
  --timeout-ms <number>   Per-case timeout. Defaults to ${45 * 60 * 1000}.
  --no-skip-missing       Fail rows when models are missing instead of skipping them.
  --keep-model-loaded     Do not unload models after each case.
  --clean-runtime         Unload Ollama/LM Studio models before and after each case. Enabled by default.
  --no-clean-runtime      Disable clean runtime reset.
  --dry-run               Write a report with commands without running models.
  --help                  Show this help.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseLargeContextArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      process.exit(0);
    }
    const { output } = await runLargeContextBenchmark(options);
    console.log(`Wrote large-context benchmark report: ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
