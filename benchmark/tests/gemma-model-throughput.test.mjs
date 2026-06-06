import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBenchmarkPlan,
  buildGemmaCliArgs,
  metricsFromJsonStreamEvents,
  ollamaLoadedModels,
  ollamaPsIncludesModel,
  parseArgs,
  parseJsonStreamEvents,
  renderMarkdownReport,
  resolveGemmaCli,
  targetLmStudioModelIds
} from '../gemma-model-throughput.mjs';
import { parseReportMarkdown, renderReportHtml } from '../gemma-report-site.mjs';

test('parses the default model and thinking matrix', () => {
  const options = parseArgs([]);

  assert.deepEqual(options.providers, ['ollama']);
  assert.equal(options.models, undefined);
  assert.deepEqual(options.thinkModes, ['on', 'off']);
});

test('uses only Google base LM Studio model defaults for the target weights', () => {
  assert.deepEqual(targetLmStudioModelIds, [
    'google/gemma-4-e2b',
    'google/gemma-4-e4b',
    'google/gemma-4-12b',
    'google/gemma-4-26b-a4b',
    'google/gemma-4-31b'
  ]);
  assert.equal(targetLmStudioModelIds.every((model) => model.startsWith('google/')), true);
});

test('builds one benchmark case per model and thinking mode', () => {
  const options = parseArgs([
    '--providers',
    'ollama,lmstudio',
    '--think',
    'off',
    '--workspaces-dir',
    '/tmp/gemma-benchmark-workspaces'
  ]);

  const plan = buildBenchmarkPlan(options);

  assert.equal(plan.length, 10);
  assert.deepEqual(plan.map((item) => `${item.provider}:${item.model}:${item.think}`), [
    'ollama:gemma4:e2b:off',
    'ollama:gemma4:e4b:off',
    'ollama:gemma4:12b:off',
    'ollama:gemma4:26b:off',
    'ollama:gemma4:31b:off',
    'lmstudio:google/gemma-4-e2b:off',
    'lmstudio:google/gemma-4-e4b:off',
    'lmstudio:google/gemma-4-12b:off',
    'lmstudio:google/gemma-4-26b-a4b:off',
    'lmstudio:google/gemma-4-31b:off'
  ]);
  assert.match(plan[0].workspace, /ollama-gemma4-e2b-think-off$/);
});

test('uses a local npm-installed gemma binary before falling back to PATH', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gemma-benchmark-test-'));
  const binDir = path.join(temp, 'node_modules/.bin');
  const gemmaBin = path.join(binDir, process.platform === 'win32' ? 'gemma.cmd' : 'gemma');
  await mkdir(binDir, { recursive: true });
  await writeFile(gemmaBin, '', 'utf8');

  assert.equal(resolveGemmaCli(parseArgs([]), temp).command, gemmaBin);
});

test('builds Gemma CLI arguments without generation tuning flags', () => {
  const options = parseArgs([
    '--model',
    'gemma4:26b',
    '--think',
    'off',
    '--ollama-endpoint',
    'http://ollama.local:11434'
  ]);
  const [item] = buildBenchmarkPlan(options);

  assert.deepEqual(buildGemmaCliArgs(options, item), [
    '--provider',
    'ollama',
    '--model',
    'gemma4:26b',
    '--endpoint',
    'http://ollama.local:11434',
    '--think',
    'off',
    '--json-stream',
    '--cwd',
    item.workspace,
    '--prompt',
    options.prompt
  ]);

  assert.equal(buildGemmaCliArgs(options, item).includes('--max-tokens'), false);
  assert.equal(buildGemmaCliArgs(options, item).includes('--temperature'), false);
  assert.equal(buildGemmaCliArgs(options, item).includes('--max-turns'), false);
});

test('rejects generation tuning options so Gemma CLI defaults stay authoritative', () => {
  assert.throws(() => parseArgs(['--max-tokens', '512']), /Unknown option: --max-tokens/);
  assert.throws(() => parseArgs(['--temperature', '0.2']), /Unknown option: --temperature/);
  assert.throws(() => parseArgs(['--max-turns', '1']), /Unknown option: --max-turns/);
});

test('parses clean runtime reset without changing generation defaults', () => {
  const options = parseArgs(['--providers', 'ollama,lmstudio', '--clean-runtime']);

  assert.equal(options.resetRuntimeBetweenCases, true);
  assert.equal(options.keepModelLoaded, false);
  assert.throws(() => parseArgs(['--top-p', '0.8']), /Unknown option: --top-p/);
});

test('parses JSON stream events and ignores non-json lines', () => {
  const events = parseJsonStreamEvents([
    'human log line',
    '{"type":"run_started","data":{}}',
    '{"type":"run_completed","data":{"result":{"metrics":{"totals":{"tokensPerSecond":42}}}}}'
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.type), ['run_started', 'run_completed']);
  assert.equal(events[1].data.result.metrics.totals.tokensPerSecond, 42);
});

test('derives estimated metrics from published Gemma CLI JSON stream events', () => {
  const events = [{
    type: 'model_start',
    timestamp: '2026-06-06T00:00:00.000Z',
    data: { index: 0, finalization: false }
  }, {
    type: 'model_activity',
    timestamp: '2026-06-06T00:00:01.000Z',
    data: { index: 0, finalization: false, contentChars: 80, contentPreview: 'x' }
  }, {
    type: 'model_activity',
    timestamp: '2026-06-06T00:00:03.000Z',
    data: { index: 0, finalization: false, thinkingChars: 40, thinkingPreview: 'y', done: true, doneReason: 'stop' }
  }, {
    type: 'run_completed',
    timestamp: '2026-06-06T00:00:04.000Z',
    data: { result: { answer: 'ok' } }
  }];

  assert.deepEqual(metricsFromJsonStreamEvents(events), {
    totals: {
      wallDurationMs: 4000,
      modelCallDurationMs: 3000,
      generationDurationMs: 2000,
      contentChars: 80,
      thinkingChars: 40,
      estimatedOutputTokens: 30,
      metricOutputTokens: 30,
      tokenSource: 'estimate',
      tokensPerSecond: 15,
      wallTokensPerSecond: 7.5
    },
    modelCalls: [{
      index: 0,
      finalization: false,
      durationMs: 3000,
      firstOutputLatencyMs: 1000,
      generationDurationMs: 2000,
      contentChars: 80,
      thinkingChars: 40,
      estimatedOutputTokens: 30,
      metricOutputTokens: 30,
      tokenSource: 'estimate',
      tokensPerSecond: 15,
      wallTokensPerSecond: 10,
      done: true,
      doneReason: 'stop'
    }]
  });
});

test('renders a markdown report with metric rows and runnable commands', () => {
  const markdown = renderMarkdownReport({
    generatedAt: '2026-06-06T00:00:00.000Z',
    provider: 'ollama',
    cli: 'gemma',
    prompt: 'write code',
    results: [{
      provider: 'ollama',
      model: 'gemma4:e2b',
      think: 'off',
      status: 'completed',
      command: 'gemma',
      commandArgs: ['--provider', 'ollama', '--model', 'gemma4:e2b'],
      answerChars: 120,
      wallDurationMs: 2000,
      metrics: {
        tokensPerSecond: 30,
        wallTokensPerSecond: 20,
        metricOutputTokens: 40,
        tokenSource: 'provider',
        modelCallDurationMs: 1300
      },
      context: {
        tokens: 262144
      },
      runtimeModelState: {
        contextLength: 131072,
        maxContextLength: 131072,
        state: 'loaded',
        processor: '100% GPU'
      },
      settings: {
        temperature: 1,
        maxTokens: 'provider settings'
      }
    }]
  });

  assert.match(markdown, /# Gemma Model Throughput Benchmark/);
  assert.match(markdown, /\| ollama \| gemma4:e2b \| off \| completed \| 30 \| 20 \| 40 \| provider \|  \| 1300 ms \| 131072 \| 1 \| provider settings \| 120 \|/);
  assert.match(markdown, /## Runtime Model State Evidence/);
  assert.match(markdown, /ollama \/ gemma4:e2b \/ think off: loaded, context 131072, max context 131072, processor 100% GPU/);
  assert.match(markdown, /gemma --provider ollama --model gemma4:e2b/);
});

test('detects resident Ollama models by exact ps model name', () => {
  const output = [
    'NAME          ID              SIZE     PROCESSOR    CONTEXT    UNTIL',
    'gemma4:26b    5571076f3d70    19 GB    100% GPU     262144     Stopping...',
    'gemma4:e2b    7fbdbf8f5e45    7 GB     100% GPU     128000     5m'
  ].join('\n');

  assert.equal(ollamaPsIncludesModel(output, 'gemma4:26b'), true);
  assert.equal(ollamaPsIncludesModel(output, 'gemma4:12b'), false);
  assert.deepEqual(ollamaLoadedModels(output), ['gemma4:26b', 'gemma4:e2b']);
});

test('renders a self-contained sortable static report site from markdown', () => {
  const markdown = [
    '# Gemma Model Throughput Benchmark',
    '',
    'Generated: 2026-06-06T18:10:10.819Z',
    'Providers: ollama, lmstudio',
    'CLI: /tmp/gemma',
    'Clean runtime reset: enabled',
    '',
    '## Unified Run Summary',
    '',
    '- Result: 1 / 1 cases completed across Ollama and LM Studio.',
    '- Generation controls: the benchmark did not pass generation flags.',
    '',
    '## Stack',
    '',
    '- Benchmark Node: v24.14.1 on darwin/arm64',
    '- Gemma CLI defaults: context=262144, temp=1',
    '',
    '## Runtime Metadata',
    '',
    '```json',
    JSON.stringify({
      ollama: {
        endpoint: 'http://127.0.0.1:11434',
        version: '0.30.6',
        commandVersion: 'ollama version is 0.30.6',
        listedModelCount: 1,
        loadedModels: [],
        models: {
          'gemma4:e2b': {
            family: 'gemma4',
            parameterSize: '5.1B',
            quantization: 'Q4_K_M',
            contextLength: 131072,
            maxContextLength: 131072,
            temperature: 1,
            capabilities: ['completion', 'thinking']
          }
        }
      }
    }, null, 2),
    '```',
    '',
    '## Prompt',
    '',
    '```text',
    'Write a script.',
    '```',
    '',
    '## Results',
    '',
    '| Provider | Model | Thinking | Status | Tok/s | Wall tok/s | Tokens | Source | First output | Model time | Context | Temp | Max tokens | Answer chars |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |',
    '| ollama | gemma4:e2b | on | completed | 10 | 5 | 100 | provider | 2000 ms | 3000 ms | 131072 | 1 | provider settings | 500 |',
    '',
    '## Runtime Reset Evidence',
    '',
    '- ollama / gemma4:e2b / think on: before ollama:ok lmstudio:ok; after ollama:ok unloaded=gemma4:e2b lmstudio:ok',
    '',
    '## Runtime Model State Evidence',
    '',
    '- ollama / gemma4:e2b / think on: loaded, context 131072, processor 100% GPU',
    '',
    '## Commands',
    '',
    '### ollama / gemma4:e2b / think on',
    '',
    '```sh',
    'gemma --provider ollama --model gemma4:e2b --think on',
    '```'
  ].join('\n');

  const report = parseReportMarkdown(markdown);
  const html = renderReportHtml(report);

  assert.equal(report.results.length, 1);
  assert.equal(report.resetEvidence[0].unloaded, 'gemma4:e2b');
  assert.match(html, /<table id="resultsTable" class="sortable-table results-table">/);
  assert.match(html, /function sortTable/);
  assert.doesNotMatch(html, /<script src=/);
  assert.doesNotMatch(html, /<link rel=/);
});
