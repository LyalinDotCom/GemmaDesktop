#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportMarkdown } from './gemma-report-site.mjs';

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const defaultReportsDir = path.join(benchmarkDir, 'reports');

const defaultInputs = {
  qatThroughput: path.join(defaultReportsDir, 'gemma-throughput-llamacpp-google-qat-q4_0-special-2026-06-08.md'),
  qatLargeContext: path.join(defaultReportsDir, 'gemma-large-context-llamacpp-google-qat-q4_0-2026-06-08.md'),
  throughputBaseline: path.join(defaultReportsDir, 'unified-google-base-clean-runtime-local-fix-2026-06-06.md'),
  largeContextBaseline: path.join(defaultReportsDir, 'gemma-large-context-comparison-full-lowbit-2026-06-08.md')
};

const memoryReference = [
  memoryRow('e2b', 'Gemma 4 E2B', 11.4, 2.9, 1.1, 0.84),
  memoryRow('e4b', 'Gemma 4 E4B', 17.9, 4.5, 2.5, 2.2),
  memoryRow('12b', 'Gemma 4 12B', 26.7, 6.7),
  memoryRow('26b', 'Gemma 4 26B A4B', 57.7, 14.4),
  memoryRow('31b', 'Gemma 4 31B', 69.9, 17.5)
];

async function main(argv) {
  const options = parseArgs(argv);
  const reports = {
    qatThroughput: await readReport(options.qatThroughput),
    qatLargeContext: await readOptionalReport(options.qatLargeContext),
    throughputBaseline: await readReport(options.throughputBaseline),
    largeContextBaseline: await readOptionalReport(options.largeContextBaseline)
  };
  const data = buildReportData(options, reports);
  const markdown = renderMarkdown(data);
  const html = renderHtml(data);
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, markdown, 'utf8');
  await writeFile(options.htmlOutput, html, 'utf8');
  console.log(`Wrote QAT special report: ${options.output}`);
  console.log(`Wrote QAT special report site: ${options.htmlOutput}`);
}

function parseArgs(argv) {
  const options = {
    ...defaultInputs,
    output: path.join(defaultReportsDir, `gemma-qat-q4-special-report-${dateStamp(new Date())}.md`),
    htmlOutput: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--qat-throughput':
        options.qatThroughput = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--qat-large-context':
        options.qatLargeContext = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--throughput-baseline':
        options.throughputBaseline = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--large-context-baseline':
        options.largeContextBaseline = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--output':
        options.output = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--html-output':
        options.htmlOutput = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--help':
      case '-h':
        console.log(helpText());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.htmlOutput) {
    options.htmlOutput = options.output.replace(/\.md$/i, '.html');
  }
  return options;
}

async function readReport(file) {
  const markdown = await readFile(file, 'utf8');
  return {
    file,
    report: parseReportMarkdown(markdown)
  };
}

async function readOptionalReport(file) {
  try {
    return await readReport(file);
  } catch (error) {
    return {
      file,
      missing: true,
      error: error instanceof Error ? error.message : String(error),
      report: {
        results: [],
        summary: [],
        runtimeMetadata: {},
        stack: []
      }
    };
  }
}

function buildReportData(options, reports) {
  const generatedAt = new Date().toISOString();
  const throughputRows = throughputRowsFor(reports);
  const largeContextRows = largeContextRowsFor(reports);
  const qatThroughputRows = throughputRows.filter((row) => row.modelClass === 'qat-q4_0');
  const qatLargeContextRows = largeContextRows.filter((row) => row.modelClass === 'qat-q4_0');
  return {
    generatedAt,
    inputs: options,
    sources: sourceRows(reports),
    supportNotes: supportNotes(),
    memoryRows: memoryRowsFor(reports.qatThroughput.report),
    throughputRows,
    throughputComparisonRows: throughputComparisonRows(qatThroughputRows, throughputRows),
    largeContextRows,
    largeContextComparisonRows: largeContextComparisonRows(qatLargeContextRows, largeContextRows),
    runtimeMetadata: {
      qatThroughput: reports.qatThroughput.report.runtimeMetadata,
      qatLargeContext: reports.qatLargeContext.report.runtimeMetadata,
      throughputBaseline: reports.throughputBaseline.report.runtimeMetadata,
      largeContextBaseline: reports.largeContextBaseline.report.runtimeMetadata
    },
    sourceReports: reports,
    stats: {
      qatThroughputCompleted: qatThroughputRows.filter((row) => row.status === 'completed').length,
      qatThroughputTotal: qatThroughputRows.length,
      qatLargeContextCompleted: qatLargeContextRows.filter((row) => row.status === 'completed').length,
      qatLargeContextTotal: qatLargeContextRows.length
    }
  };
}

function throughputRowsFor(reports) {
  const baseline = reports.throughputBaseline.report.results
    .map((row) => throughputRow(row, reports.throughputBaseline.file, 'regular'))
    .filter(Boolean);
  const qat = reports.qatThroughput.report.results
    .map((row) => throughputRow(row, reports.qatThroughput.file, 'qat-q4_0'))
    .filter(Boolean);
  return [...baseline, ...qat];
}

function throughputRow(row, sourceFile, modelClass) {
  const scale = scaleFromRow(row);
  if (!scale) {
    return undefined;
  }
  const resolvedClass = modelClass === 'regular' && row.provider === 'llamacpp'
    ? 'qat-q4_0'
    : modelClass;
  return {
    benchmark: 'throughput',
    sourceFile: path.basename(sourceFile),
    provider: row.provider,
    modelClass: resolvedClass,
    scale,
    model: row.model,
    thinking: row.thinking,
    status: row.status,
    tokensPerSecond: row.tokensPerSecond,
    wallTokensPerSecond: row.wallTokensPerSecond,
    tokens: row.tokens,
    firstOutputMs: row.firstOutputMs,
    completionTimeMs: row.completionTimeMs,
    modelTimeMs: row.modelTimeMs,
    context: row.context,
    answerChars: row.answerChars
  };
}

function throughputComparisonRows(qatRows, allRows) {
  return qatRows.map((qat) => {
    const regularRows = allRows.filter((row) =>
      row.modelClass === 'regular' &&
      row.scale === qat.scale &&
      row.thinking === qat.thinking &&
      row.status === 'completed'
    );
    const bestWall = bestBy(regularRows, (row) => row.wallTokensPerSecond);
    const bestFirst = bestBy(regularRows, (row) => -row.firstOutputMs);
    return {
      scale: qat.scale,
      thinking: qat.thinking,
      qatProvider: qat.provider,
      qatModel: qat.model,
      status: qat.status,
      qatWallTokensPerSecond: qat.wallTokensPerSecond,
      qatTokensPerSecond: qat.tokensPerSecond,
      qatFirstOutputMs: qat.firstOutputMs,
      qatContext: qat.context,
      bestRegularWallTokensPerSecond: bestWall?.wallTokensPerSecond,
      bestRegularProvider: bestWall?.provider,
      bestRegularModel: bestWall?.model,
      wallSpeedVsBestRegularPct: percentDiff(qat.wallTokensPerSecond, bestWall?.wallTokensPerSecond),
      bestRegularFirstOutputMs: bestFirst?.firstOutputMs,
      firstOutputVsBestRegularPct: percentDiff(qat.firstOutputMs, bestFirst?.firstOutputMs, { inverse: true })
    };
  });
}

function largeContextRowsFor(reports) {
  const baseline = reports.largeContextBaseline.report.results
    .filter((row) => row.family === 'gemma4' && (row.variant === 'regular' || row.variant === 'mlx'))
    .map((row) => largeContextRow(row, reports.largeContextBaseline.file))
    .filter(Boolean);
  const qat = reports.qatLargeContext.report.results
    .filter((row) => row.family === 'gemma4' && row.variant === 'qat-q4_0')
    .map((row) => largeContextRow(row, reports.qatLargeContext.file))
    .filter(Boolean);
  return [...baseline, ...qat];
}

function largeContextRow(row, sourceFile) {
  const scale = scaleFromRow(row);
  if (!scale) {
    return undefined;
  }
  const outputCheck = checkLargeContextOutput(row);
  return {
    benchmark: 'large-context',
    sourceFile: path.basename(sourceFile),
    provider: row.provider,
    modelClass: row.variant,
    scale,
    model: row.model,
    runtimeModelKey: row.runtimeModelKey,
    scenario: row.scenario,
    thinking: row.thinking,
    status: row.status,
    tokensPerSecond: row.tokensPerSecond,
    wallTokensPerSecond: row.wallTokensPerSecond,
    tokens: row.tokens,
    firstOutputMs: row.firstOutputMs,
    completionTimeMs: row.completionTimeMs,
    modelTimeMs: row.modelTimeMs,
    context: row.context,
    promptEstimatedTokens: row.promptEstimatedTokens,
    promptChars: row.promptChars,
    answerChars: row.answerChars,
    outputCheck,
    outputOrError: row.outputOrError
  };
}

function largeContextComparisonRows(qatRows, allRows) {
  return qatRows.map((qat) => {
    const regularRows = matchingLargeContextRows(allRows, qat, 'regular');
    const mlxRows = matchingLargeContextRows(allRows, qat, 'mlx');
    const bestRegular = bestBy(regularRows, (row) => row.wallTokensPerSecond);
    const bestMlx = bestBy(mlxRows, (row) => row.wallTokensPerSecond);
    return {
      scale: qat.scale,
      scenario: qat.scenario,
      thinking: qat.thinking,
      status: qat.status,
      qatWallTokensPerSecond: qat.wallTokensPerSecond,
      qatTokensPerSecond: qat.tokensPerSecond,
      qatFirstOutputMs: qat.firstOutputMs,
      qatCompletionTimeMs: qat.completionTimeMs,
      qatOutputCheck: qat.outputCheck,
      bestRegularWallTokensPerSecond: bestRegular?.wallTokensPerSecond,
      bestRegularProvider: bestRegular?.provider,
      bestRegularModel: bestRegular?.model,
      wallSpeedVsBestRegularPct: percentDiff(qat.wallTokensPerSecond, bestRegular?.wallTokensPerSecond),
      bestMlxWallTokensPerSecond: bestMlx?.wallTokensPerSecond,
      bestMlxProvider: bestMlx?.provider,
      bestMlxModel: bestMlx?.model,
      wallSpeedVsBestMlxPct: percentDiff(qat.wallTokensPerSecond, bestMlx?.wallTokensPerSecond)
    };
  });
}

function matchingLargeContextRows(rows, qat, modelClass) {
  return rows.filter((row) =>
    row.modelClass === modelClass &&
    row.scale === qat.scale &&
    row.scenario === qat.scenario &&
    row.thinking === qat.thinking &&
    row.status === 'completed'
  );
}

function memoryRowsFor(qatThroughputReport) {
  const metadata = qatThroughputReport.runtimeMetadata?.llamacpp?.models ?? {};
  return memoryReference.map((reference) => {
    const modelId = qatModelForScale(reference.scale);
    const fileSizeBytes = metadata[modelId]?.fileSizeBytes;
    const actualFileGb = bytesToGb(fileSizeBytes);
    return {
      ...reference,
      expectedReductionPct: percentReduction(reference.bf16Gb, reference.q4Gb),
      localQatFileGb: actualFileGb,
      localVsExpectedQ4Pct: percentDiff(actualFileGb, reference.q4Gb)
    };
  });
}

function sourceRows(reports) {
  return Object.entries(reports).map(([key, value]) => ({
    key,
    file: value.file,
    title: value.report.title,
    generatedAt: value.report.generatedAt,
    providers: value.report.providers,
    rows: value.report.results.length,
    completed: value.report.results.filter((row) => row.status === 'completed').length,
    status: value.missing ? `missing: ${value.error}` : 'loaded'
  }));
}

function supportNotes() {
  return [
    {
      runtime: 'llama.cpp',
      status: 'measured',
      note: 'All five Google QAT Q4_0 GGUF files were present locally and were served through a benchmark-managed llama-server per case.'
    },
    {
      runtime: 'Ollama',
      status: 'supported by upstream model pages, not measured here',
      note: 'Google Hugging Face pages advertise ollama run hf.co/...:Q4_0. The local benchmark did not import or create Ollama tags because benchmark scripts detect setup but do not assist setup.'
    },
    {
      runtime: 'LM Studio',
      status: 'partially installed locally, not measured for this five-model Q4_0 pass',
      note: 'LM Studio can open GGUF models from the Google pages, but local inventory was not a complete five-model QAT Q4_0 matrix. This report uses the complete llama.cpp path for the measured QAT rows.'
    },
    {
      runtime: 'LiteRT-LM',
      status: 'not applicable',
      note: 'The measured artifact is Google QAT Q4_0 GGUF. LiteRT-LM is tracked separately for its imported Gemma runtime path.'
    },
    {
      runtime: 'Media benchmarks',
      status: 'not measured',
      note: 'The current managed llama.cpp benchmark path covers text/completion metrics. Image/audio rows require separate runtime transport support and projector/media wiring, so this report does not treat missing media rows as model failures.'
    },
    {
      runtime: 'Memory interpretation',
      status: 'important caveat',
      note: 'The Q4_0 table and local GGUF file sizes describe model weight footprint, not total process residency. During the 262K-context 31B QAT rows, spot checks saw llama-server RSS around 45.9 GB to 53.4 GB because context/cache/runtime overhead is also resident.'
    }
  ];
}

function renderMarkdown(data) {
  const lines = [
    '# Gemma 4 QAT Q4_0 Special Report',
    '',
    `Generated: ${data.generatedAt}`,
    'Category: qat-q4_0-special',
    'Providers: llamacpp measured; Ollama/LM Studio noted where setup was incomplete',
    'CLI: mixed source reports',
    'Clean runtime reset: source report specific',
    '',
    '## Summary',
    '',
    `- QAT throughput rows: ${data.stats.qatThroughputCompleted} / ${data.stats.qatThroughputTotal} completed.`,
    `- QAT large-context rows: ${data.stats.qatLargeContextCompleted} / ${data.stats.qatLargeContextTotal} completed.`,
    '- Measurement path: Google QAT Q4_0 GGUF files served by benchmark-managed llama.cpp, with Gemma CLI defaults preserved.',
    '- Baseline comparison path: regular throughput rows from the clean Ollama/LM Studio base report; regular and MLX large-context rows from the low-bit large-context report.',
    '- Memory reference: user-provided Gemma 4 QAT table showing BF16, Q4_0, Mobile, and Mobile text-only in-memory sizes.',
    '',
    '## Source Reports',
    '',
    markdownTable(['Key', 'Status', 'File', 'Generated', 'Providers', 'Rows', 'Completed'], data.sources.map((row) => [
      row.key,
      row.status,
      row.file,
      row.generatedAt,
      row.providers,
      row.rows,
      row.completed
    ])),
    '',
    '## Runtime Support Notes',
    '',
    markdownTable(['Runtime', 'Status', 'Note'], data.supportNotes.map((row) => [row.runtime, row.status, row.note])),
    '',
    '## Memory Footprint Reference',
    '',
    markdownTable([
      'Scale',
      'Model',
      'BF16 GB',
      'Q4_0 GB',
      'Expected reduction',
      'Mobile GB',
      'Mobile text-only GB',
      'Local QAT file GB',
      'Local vs expected Q4_0'
    ], data.memoryRows.map((row) => [
      row.scale,
      row.model,
      row.bf16Gb,
      row.q4Gb,
      formatPct(row.expectedReductionPct),
      row.mobileGb ?? '',
      row.mobileTextOnlyGb ?? '',
      formatNumber(row.localQatFileGb),
      formatPct(row.localVsExpectedQ4Pct)
    ])),
    '',
    '## QAT Throughput Versus Regular Baseline',
    '',
    markdownTable([
      'Scale',
      'Thinking',
      'QAT status',
      'QAT wall tok/s',
      'QAT tok/s',
      'QAT first output ms',
      'QAT context',
      'Best regular wall tok/s',
      'Best regular provider',
      'Best regular model',
      'Wall speed vs regular',
      'Best regular first output ms',
      'First output vs regular'
    ], data.throughputComparisonRows.map((row) => [
      row.scale,
      row.thinking,
      row.status,
      formatNumber(row.qatWallTokensPerSecond),
      formatNumber(row.qatTokensPerSecond),
      formatNumber(row.qatFirstOutputMs),
      formatNumber(row.qatContext),
      formatNumber(row.bestRegularWallTokensPerSecond),
      row.bestRegularProvider ?? '',
      row.bestRegularModel ?? '',
      formatPct(row.wallSpeedVsBestRegularPct),
      formatNumber(row.bestRegularFirstOutputMs),
      formatPct(row.firstOutputVsBestRegularPct)
    ])),
    '',
    '## All Throughput Rows Used',
    '',
    markdownTable(metricHeaders(), data.throughputRows.map(metricRow)),
    '',
    '## QAT Large Context Versus Regular And MLX Baselines',
    '',
    markdownTable([
      'Scale',
      'Scenario',
      'Thinking',
      'QAT status',
      'QAT wall tok/s',
      'QAT tok/s',
      'QAT first output ms',
      'QAT completion ms',
      'QAT output check',
      'Best regular wall tok/s',
      'Best regular provider',
      'Best regular model',
      'Wall speed vs regular',
      'Best MLX wall tok/s',
      'Best MLX provider',
      'Best MLX model',
      'Wall speed vs MLX'
    ], data.largeContextComparisonRows.map((row) => [
      row.scale,
      row.scenario,
      row.thinking,
      row.status,
      formatNumber(row.qatWallTokensPerSecond),
      formatNumber(row.qatTokensPerSecond),
      formatNumber(row.qatFirstOutputMs),
      formatNumber(row.qatCompletionTimeMs),
      row.qatOutputCheck,
      formatNumber(row.bestRegularWallTokensPerSecond),
      row.bestRegularProvider ?? '',
      row.bestRegularModel ?? '',
      formatPct(row.wallSpeedVsBestRegularPct),
      formatNumber(row.bestMlxWallTokensPerSecond),
      row.bestMlxProvider ?? '',
      row.bestMlxModel ?? '',
      formatPct(row.wallSpeedVsBestMlxPct)
    ])),
    '',
    '## All Large Context Rows Used',
    '',
    markdownTable([
      ...metricHeaders().slice(0, 6),
      'Scenario',
      ...metricHeaders().slice(6),
      'Prompt est tokens',
      'Output check',
      'Output / Error'
    ], data.largeContextRows.map((row) => [
      row.benchmark,
      row.sourceFile,
      row.provider,
      row.modelClass,
      row.scale,
      row.model,
      row.scenario,
      row.thinking,
      row.status,
      formatNumber(row.wallTokensPerSecond),
      formatNumber(row.tokensPerSecond),
      formatNumber(row.tokens),
      formatNumber(row.firstOutputMs),
      formatNumber(row.completionTimeMs),
      formatNumber(row.modelTimeMs),
      formatNumber(row.context),
      formatNumber(row.promptEstimatedTokens),
      row.outputCheck,
      row.outputOrError ?? ''
    ])),
    '',
    '## Runtime Metadata',
    '',
    '```json',
    JSON.stringify(data.runtimeMetadata, null, 2),
    '```',
    ''
  ];
  return `${lines.join('\n')}\n`;
}

function renderHtml(data) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemma 4 QAT Q4_0 Special Report</title>
  <style>${htmlCss()}</style>
</head>
<body>
  <header>
    <p class="kicker">Open Gemma Benchmark</p>
    <h1>Gemma 4 QAT Q4_0</h1>
    <p class="lede">Measured Google QAT GGUF models on llama.cpp and compared them with saved regular and MLX baseline reports.</p>
    <div class="stats">
      ${stat('QAT Throughput', `${data.stats.qatThroughputCompleted}/${data.stats.qatThroughputTotal}`, 'Completed rows')}
      ${stat('QAT Large Context', `${data.stats.qatLargeContextCompleted}/${data.stats.qatLargeContextTotal}`, 'Completed rows')}
      ${stat('Runtime', 'llama.cpp', 'Managed per case')}
      ${stat('Generated', new Date(data.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }), 'America/New_York')}
    </div>
  </header>
  <nav>
    <a href="#support">Support</a>
    <a href="#memory">Memory</a>
    <a href="#throughput">Throughput</a>
    <a href="#large-context">Large Context</a>
    <a href="#sources">Sources</a>
    <a href="#metadata">Metadata</a>
  </nav>
  <main>
    <section id="support">
      <h2>Runtime Support Notes</h2>
      ${htmlTable('supportTable', ['Runtime', 'Status', 'Note'], data.supportNotes.map((row) => [row.runtime, row.status, row.note]))}
    </section>
    <section id="memory">
      <h2>Memory Footprint Reference</h2>
      ${htmlTable('memoryTable', ['Scale', 'Model', 'BF16 GB', 'Q4_0 GB', 'Expected reduction', 'Mobile GB', 'Mobile text-only GB', 'Local QAT file GB', 'Local vs expected Q4_0'], data.memoryRows.map((row) => [
        row.scale,
        row.model,
        row.bf16Gb,
        row.q4Gb,
        formatPct(row.expectedReductionPct),
        row.mobileGb ?? '',
        row.mobileTextOnlyGb ?? '',
        formatNumber(row.localQatFileGb),
        formatPct(row.localVsExpectedQ4Pct)
      ]))}
    </section>
    <section id="throughput">
      <h2>QAT Throughput Versus Regular Baseline</h2>
      ${htmlTable('throughputComparisonTable', ['Scale', 'Thinking', 'QAT status', 'QAT wall tok/s', 'QAT tok/s', 'QAT first output ms', 'QAT context', 'Best regular wall tok/s', 'Best regular provider', 'Best regular model', 'Wall speed vs regular', 'Best regular first output ms', 'First output vs regular'], data.throughputComparisonRows.map((row) => [
        row.scale,
        row.thinking,
        row.status,
        formatNumber(row.qatWallTokensPerSecond),
        formatNumber(row.qatTokensPerSecond),
        formatNumber(row.qatFirstOutputMs),
        formatNumber(row.qatContext),
        formatNumber(row.bestRegularWallTokensPerSecond),
        row.bestRegularProvider ?? '',
        row.bestRegularModel ?? '',
        formatPct(row.wallSpeedVsBestRegularPct),
        formatNumber(row.bestRegularFirstOutputMs),
        formatPct(row.firstOutputVsBestRegularPct)
      ]))}
      <h3>All Throughput Rows Used</h3>
      ${htmlTable('throughputRowsTable', metricHeaders(), data.throughputRows.map(metricRow))}
    </section>
    <section id="large-context">
      <h2>QAT Large Context Versus Regular And MLX Baselines</h2>
      ${htmlTable('largeContextComparisonTable', ['Scale', 'Scenario', 'Thinking', 'QAT status', 'QAT wall tok/s', 'QAT tok/s', 'QAT first output ms', 'QAT completion ms', 'QAT output check', 'Best regular wall tok/s', 'Best regular provider', 'Best regular model', 'Wall speed vs regular', 'Best MLX wall tok/s', 'Best MLX provider', 'Best MLX model', 'Wall speed vs MLX'], data.largeContextComparisonRows.map((row) => [
        row.scale,
        row.scenario,
        row.thinking,
        row.status,
        formatNumber(row.qatWallTokensPerSecond),
        formatNumber(row.qatTokensPerSecond),
        formatNumber(row.qatFirstOutputMs),
        formatNumber(row.qatCompletionTimeMs),
        row.qatOutputCheck,
        formatNumber(row.bestRegularWallTokensPerSecond),
        row.bestRegularProvider ?? '',
        row.bestRegularModel ?? '',
        formatPct(row.wallSpeedVsBestRegularPct),
        formatNumber(row.bestMlxWallTokensPerSecond),
        row.bestMlxProvider ?? '',
        row.bestMlxModel ?? '',
        formatPct(row.wallSpeedVsBestMlxPct)
      ]))}
      <h3>All Large Context Rows Used</h3>
      ${htmlTable('largeContextRowsTable', [...metricHeaders().slice(0, 6), 'Scenario', ...metricHeaders().slice(6), 'Prompt est tokens', 'Output check', 'Output / Error'], data.largeContextRows.map((row) => [
        row.benchmark,
        row.sourceFile,
        row.provider,
        row.modelClass,
        row.scale,
        row.model,
        row.scenario,
        row.thinking,
        row.status,
        formatNumber(row.wallTokensPerSecond),
        formatNumber(row.tokensPerSecond),
        formatNumber(row.tokens),
        formatNumber(row.firstOutputMs),
        formatNumber(row.completionTimeMs),
        formatNumber(row.modelTimeMs),
        formatNumber(row.context),
        formatNumber(row.promptEstimatedTokens),
        row.outputCheck,
        row.outputOrError ?? ''
      ]))}
    </section>
    <section id="sources">
      <h2>Source Reports</h2>
      ${htmlTable('sourcesTable', ['Key', 'Status', 'File', 'Generated', 'Providers', 'Rows', 'Completed'], data.sources.map((row) => [
        row.key,
        row.status,
        row.file,
        row.generatedAt,
        row.providers,
        row.rows,
        row.completed
      ]))}
    </section>
    <section id="metadata">
      <h2>Runtime Metadata</h2>
      <pre>${escapeHtml(JSON.stringify(data.runtimeMetadata, null, 2))}</pre>
    </section>
  </main>
  <script>${htmlJs()}</script>
</body>
</html>`;
}

function metricHeaders() {
  return ['Benchmark', 'Source report', 'Provider', 'Class', 'Scale', 'Model', 'Thinking', 'Status', 'Wall tok/s', 'Tok/s', 'Tokens', 'First output ms', 'Completion ms', 'Model time ms', 'Context'];
}

function metricRow(row) {
  return [
    row.benchmark,
    row.sourceFile,
    row.provider,
    row.modelClass,
    row.scale,
    row.model,
    row.thinking,
    row.status,
    formatNumber(row.wallTokensPerSecond),
    formatNumber(row.tokensPerSecond),
    formatNumber(row.tokens),
    formatNumber(row.firstOutputMs),
    formatNumber(row.completionTimeMs),
    formatNumber(row.modelTimeMs),
    formatNumber(row.context)
  ];
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`)
  ].join('\n');
}

function htmlTable(id, headers, rows) {
  return `<div class="table-shell"><table id="${escapeAttr(id)}" class="sortable-table">
    <thead><tr>${headers.map((header, index) => `<th><button type="button" data-column="${index}">${escapeHtml(header)} <span class="sort-mark">--</span></button></th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map(htmlCell).join('')}</tr>`).join('\n')}</tbody>
  </table></div>`;
}

function htmlCell(value) {
  return `<td data-sort-value="${escapeAttr(sortToken(value))}">${escapeHtml(displayValue(value))}</td>`;
}

function stat(label, value, note) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(note)}</p></article>`;
}

function scaleFromRow(row) {
  if (row.scale) {
    return row.scale.toLowerCase();
  }
  const value = `${row.model ?? ''}`.toLowerCase();
  if (value.includes('e2b')) return 'e2b';
  if (value.includes('e4b')) return 'e4b';
  if (value.includes('12b')) return '12b';
  if (value.includes('26b')) return '26b';
  if (value.includes('31b')) return '31b';
  return undefined;
}

function qatModelForScale(scale) {
  return {
    e2b: 'google/gemma-4-E2B-it-qat-q4_0-gguf',
    e4b: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
    '12b': 'google/gemma-4-12B-it-qat-q4_0-gguf',
    '26b': 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
    '31b': 'google/gemma-4-31B-it-qat-q4_0-gguf'
  }[scale];
}

function checkLargeContextOutput(row) {
  if (row.status !== 'completed') {
    return row.status;
  }
  const parsed = parseJsonish(row.outputOrError);
  if (!parsed) {
    return 'unparsed output';
  }
  const expectedNeedles = row.scenario === 'prefill-80k' ? 17 : 0;
  const count = Number(parsed.needle_count);
  const status = parsed.status;
  if (status !== 'ok') {
    return `status=${status ?? 'missing'}`;
  }
  if (count !== expectedNeedles) {
    return `needle_count=${Number.isFinite(count) ? count : 'missing'} expected=${expectedNeedles}`;
  }
  return 'ok';
}

function parseJsonish(value) {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    const match = String(value).match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function bestBy(rows, scoreFor) {
  let best;
  let bestScore = -Infinity;
  for (const row of rows) {
    const score = scoreFor(row);
    if (!Number.isFinite(score)) {
      continue;
    }
    if (!best || score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function memoryRow(scale, model, bf16Gb, q4Gb, mobileGb, mobileTextOnlyGb) {
  return { scale, model, bf16Gb, q4Gb, mobileGb, mobileTextOnlyGb };
}

function percentReduction(base, value) {
  if (!Number.isFinite(base) || !Number.isFinite(value) || base === 0) {
    return undefined;
  }
  return ((base - value) / base) * 100;
}

function percentDiff(value, baseline, options = {}) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return undefined;
  }
  const diff = ((value - baseline) / baseline) * 100;
  return options.inverse ? -diff : diff;
}

function bytesToGb(value) {
  return Number.isFinite(value) ? value / 1_000_000_000 : undefined;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
}

function formatPct(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10);
}

function markdownCell(value) {
  return displayValue(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function displayValue(value) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '';
  }
  return String(value);
}

function sortToken(value) {
  const displayed = displayValue(value).replace(/,/g, '');
  const pct = displayed.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (pct) {
    return pct[1];
  }
  return displayed;
}

function escapeHtml(value) {
  return displayValue(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function htmlCss() {
  return `
:root {
  --bg: #f6f7f4;
  --ink: #202421;
  --muted: #66716b;
  --line: #d8dfda;
  --panel: #ffffff;
  --accent: #146b5b;
  --accent-soft: #e3f0eb;
  --warn: #b15f1b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
  line-height: 1.45;
}
header {
  padding: 48px clamp(18px, 5vw, 72px) 34px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, #ffffff 0%, var(--bg) 100%);
}
.kicker {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
h1 {
  margin: 0 0 14px;
  max-width: 900px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(3rem, 7vw, 6.5rem);
  line-height: 0.94;
  letter-spacing: 0;
}
.lede {
  max-width: 820px;
  margin: 0;
  color: var(--muted);
  font-size: 1.15rem;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 28px;
}
.stats article,
.table-shell,
pre {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.stats article {
  min-height: 128px;
  padding: 16px;
}
.stats span {
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}
.stats strong {
  display: block;
  margin: 10px 0;
  color: var(--accent);
  font-size: 1.55rem;
  line-height: 1.1;
}
.stats p {
  margin: 0;
  color: var(--muted);
}
nav {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 10px clamp(14px, 5vw, 72px);
  border-bottom: 1px solid var(--line);
  background: rgba(246, 247, 244, 0.94);
}
nav a {
  padding: 8px 12px;
  border-radius: 999px;
  color: var(--muted);
  font-weight: 800;
  text-decoration: none;
  white-space: nowrap;
}
nav a:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
main {
  padding: 32px clamp(14px, 4vw, 64px) 72px;
}
section {
  max-width: 1500px;
  margin: 0 auto 44px;
}
h2 {
  margin: 0 0 14px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 4vw, 3.2rem);
  letter-spacing: 0;
}
h3 {
  margin: 26px 0 12px;
  font-size: 1.1rem;
}
.table-shell {
  overflow: auto;
  margin-bottom: 18px;
}
table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
}
th,
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  font-size: 0.9rem;
}
th {
  position: sticky;
  top: 43px;
  z-index: 1;
  background: #edf3ef;
}
th button {
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-weight: 900;
  text-align: left;
  cursor: pointer;
}
td {
  overflow-wrap: anywhere;
}
tr:hover td {
  background: #fafcfb;
}
pre {
  max-height: 620px;
  overflow: auto;
  padding: 16px;
  color: #26302b;
  font-family: "SFMono-Regular", "Cascadia Code", monospace;
  font-size: 0.82rem;
}
@media (max-width: 900px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .stats { grid-template-columns: 1fr; }
  th, td { padding: 9px 10px; }
}
`;
}

function htmlJs() {
  return `
for (const table of document.querySelectorAll('.sortable-table')) {
  table.querySelectorAll('th button').forEach((button, index) => {
    button.addEventListener('click', () => sortTable(table, index));
  });
}

function sortTable(table, columnIndex) {
  const tbody = table.tBodies[0];
  const currentColumn = table.dataset.sortColumn;
  const currentDirection = table.dataset.sortDirection || 'asc';
  const direction = currentColumn === String(columnIndex) && currentDirection === 'asc' ? 'desc' : 'asc';
  const rows = [...tbody.rows].map((row, index) => ({ row, index }));
  rows.sort((left, right) => {
    const result = compareValues(cellSortValue(left.row.cells[columnIndex]), cellSortValue(right.row.cells[columnIndex]));
    return direction === 'asc' ? result || left.index - right.index : -result || left.index - right.index;
  });
  tbody.append(...rows.map((item) => item.row));
  table.dataset.sortColumn = String(columnIndex);
  table.dataset.sortDirection = direction;
  table.querySelectorAll('.sort-mark').forEach((mark, index) => {
    mark.textContent = index === columnIndex ? (direction === 'asc' ? '^' : 'v') : '--';
  });
}

function cellSortValue(cell) {
  const raw = cell?.dataset.sortValue ?? '';
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw.toLowerCase();
}

function compareValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}
`;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function helpText() {
  return `Gemma QAT Q4_0 special report generator

Usage:
  node gemma-qat-q4-special-report.mjs --output reports/gemma-qat-q4-special-report.md

Options:
  --qat-throughput <path>         Fresh QAT throughput report.
  --qat-large-context <path>      Fresh QAT large-context report.
  --throughput-baseline <path>    Regular throughput baseline report.
  --large-context-baseline <path> Regular/MLX large-context baseline report.
  --output <path>                 Markdown output path.
  --html-output <path>            Static HTML output path.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
