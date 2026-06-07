#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportMarkdown } from './gemma-report-site.mjs';

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchmarkDir, '..');
const defaultReportsDir = path.join(benchmarkDir, 'reports');

const defaultSources = [
  ['throughput-ollama-lmstudio', 'unified-google-base-clean-runtime-local-fix-2026-06-06.md'],
  ['throughput-litertlm', 'gemma-throughput-litertlm-google-base-2026-06-07.md'],
  ['throughput-llamacpp', 'gemma-throughput-llamacpp-google-qat-gguf-2026-06-07.md'],
  ['image-description', 'gemma-image-description-google-base-clean-runtime-transport-fix-2026-06-06.md'],
  ['audio-transcription', 'gemma-audio-transcription-google-base-direct-media-fix-2026-06-07.md']
].map(([label, file]) => ({ label, path: path.join(defaultReportsDir, file) }));

async function main(argv) {
  const options = parseArgs(argv);
  const sources = options.sources.length > 0 ? options.sources : defaultSources;
  const output = options.output ?? path.join(defaultReportsDir, `combined-gemma-model-data-${dateStamp(new Date())}.md`);
  const reports = await Promise.all(sources.map(readSourceReport));
  const markdown = renderCombinedReport(reports);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, markdown, 'utf8');
  console.log(`Wrote combined report: ${output}`);
}

function parseArgs(argv) {
  const options = { output: undefined, sources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      options.output = path.resolve(readValue(argv, ++index, arg));
    } else if (arg === '--source') {
      options.sources.push(parseSource(readValue(argv, ++index, arg)));
    } else if (arg === '--help' || arg === '-h') {
      console.log(helpText());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseSource(value) {
  const splitAt = value.indexOf('=');
  if (splitAt <= 0) {
    throw new Error('--source must use label=/path/to/report.md');
  }
  return {
    label: value.slice(0, splitAt).trim(),
    path: path.resolve(value.slice(splitAt + 1).trim())
  };
}

async function readSourceReport(source) {
  const markdown = await readFile(source.path, 'utf8');
  return {
    ...source,
    relativePath: path.relative(repoRoot, source.path),
    report: parseReportMarkdown(markdown)
  };
}

function renderCombinedReport(sources) {
  const generatedAt = new Date().toISOString();
  const rows = sources.flatMap(({ label, report }) =>
    report.results.map((row) => ({ ...row, benchmark: label }))
  );
  const notApplicable = sources.flatMap(({ label, report }) =>
    report.notApplicable.map((row) => ({ ...row, benchmark: label }))
  );
  const fixtures = uniqueBy(
    sources.flatMap(({ report }) => report.fixtures),
    (row) => [row.kind, row.localFile, row.source, row.reference].join('\u0000')
  );
  const runtimeMetadata = {};
  for (const { label, report } of sources) {
    for (const [provider, metadata] of Object.entries(report.runtimeMetadata ?? {})) {
      runtimeMetadata[`${provider} · ${label}`] = metadata;
    }
  }
  const providers = unique([
    ...rows.map((row) => row.provider),
    ...notApplicable.map((row) => row.provider),
    ...Object.values(runtimeMetadata).flatMap((entry) => entry?.provider ? [entry.provider] : [])
  ].filter(Boolean));
  const completed = rows.filter((row) => row.status === 'completed').length;

  const lines = [
    '# Combined Gemma Model Data Report',
    '',
    `Generated: ${generatedAt}`,
    'Category: combined',
    `Providers: ${providers.join(', ')}`,
    'CLI: mixed source reports',
    'Clean runtime reset: mixed source reports',
    'Prompt tokens are reported from provider usage when available; otherwise source reports fall back to an estimated 4 characters per token.',
    '',
    '## Unified Run Summary',
    '',
    `- Result rows: ${completed} / ${rows.length} completed across ${sources.length} source reports.`,
    `- Not applicable rows: ${notApplicable.length}.`,
    `- Scope: current canonical throughput, image-description, and audio-transcription reports for Google Gemma model targets.`,
    '',
    '## Stack',
    '',
    ...sources.map(({ label, relativePath, report }) => `- ${label}: ${relativePath}, generated ${report.generatedAt ?? 'unknown'}, providers ${report.providers ?? 'unknown'}, clean runtime ${report.cleanRuntimeReset ?? 'unknown'}`),
    '',
    '## Runtime Metadata',
    '',
    'Provider and model configuration snapshots below are namespaced by source report so model inventory from every runtime is preserved.',
    '',
    '```json',
    JSON.stringify(runtimeMetadata, null, 2),
    '```',
    ''
  ];

  if (fixtures.length > 0) {
    lines.push(
      '## Fixtures',
      '',
      '| Fixture | Kind | Local file | Source | License | Reference |',
      '| --- | --- | --- | --- | --- | --- |',
      ...fixtures.map((row) => [
        row.fixture,
        row.kind,
        row.localFile,
        row.source,
        row.license,
        row.reference
      ].map(markdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
      ''
    );
  }

  lines.push(
    '## Results',
    '',
    '| Benchmark | Provider | Model | Fixture | Thinking | Status | Tok/s | Wall tok/s | Tokens | Source | First output | Completion time | Model time | Context | Temp | Max tokens | Answer chars | Output / Error |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |',
    ...rows.map(resultRow),
    ''
  );

  if (notApplicable.length > 0) {
    lines.push(
      '## Not Applicable',
      '',
      '| Benchmark | Provider | Model | Fixture | Thinking | Reason |',
      '| --- | --- | --- | --- | --- | --- |',
      ...notApplicable.map((row) => [
        row.benchmark,
        row.provider,
        row.model,
        row.fixture,
        row.thinking,
        row.reason
      ].map(markdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
      ''
    );
  }

  return `${lines.join('\n')}\n`;
}

function resultRow(row) {
  return [
    row.benchmark,
    row.provider,
    row.model,
    row.fixture,
    row.thinking,
    row.status,
    row.tokensPerSecond,
    row.wallTokensPerSecond,
    row.tokens,
    row.source,
    formatMsValue(row.firstOutputMs),
    formatMsValue(row.completionTimeMs),
    formatMsValue(row.modelTimeMs),
    row.context,
    row.temperature,
    row.maxTokens,
    row.answerChars,
    row.outputOrError
  ].map(markdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function markdownCell(value) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '';
  }
  return String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function formatMsValue(value) {
  return Number.isFinite(value) ? `${value} ms` : '';
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, keyFor) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10);
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function helpText() {
  return `Combined Gemma report generator

Usage:
  node benchmark/gemma-combine-reports.mjs
  node benchmark/gemma-combine-reports.mjs --output benchmark/reports/combined.md
  node benchmark/gemma-combine-reports.mjs --source label=/path/report.md --source other=/path/other.md
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
