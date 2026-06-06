import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultInput = 'reports/unified-google-base-clean-runtime-local-fix-2026-06-06.md';

export function parseReportMarkdown(markdown) {
  const metadata = parseTopMetadata(markdown);
  const title = markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? 'Gemma Benchmark Report';
  const summary = linesInSection(markdown, 'Unified Run Summary')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
  const stack = linesInSection(markdown, 'Stack')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
  const runtimeMetadata = parseRuntimeMetadata(markdown);
  const fixtures = parseFixturesTable(markdown);
  const prompt = extractFence(markdown, 'Prompt', 'text') ?? '';
  const results = parseResultsTable(markdown);
  const notApplicable = parseNotApplicableTable(markdown);
  const resetEvidence = parseRuntimeResetEvidence(markdown);
  const modelStateEvidence = parseRuntimeModelStateEvidence(markdown);
  const commands = parseCommands(markdown);

  return {
    title,
    ...metadata,
    summary,
    stack,
    runtimeMetadata,
    fixtures,
    prompt,
    results,
    notApplicable,
    resetEvidence,
    modelStateEvidence,
    commands
  };
}

export function renderReportHtml(report) {
  const providerSummaries = summarizeProviders(report.results);
  const hasFixtures = report.fixtures.length > 0;
  const fastest = report.results
    .filter((row) => Number.isFinite(row.tokensPerSecond))
    .toSorted((a, b) => b.tokensPerSecond - a.tokensPerSecond)[0];
  const slowestFirstOutput = report.results
    .filter((row) => Number.isFinite(row.firstOutputMs))
    .toSorted((a, b) => b.firstOutputMs - a.firstOutputMs)[0];
  const lmStudio31bThinking = report.results.find((row) =>
    row.provider === 'lmstudio' && row.model === 'google/gemma-4-31b' && row.thinking === 'on'
  );
  const maxTokensPerSecond = Math.max(...report.results.map((row) => row.tokensPerSecond).filter(Number.isFinite), 1);
  const maxWallTokensPerSecond = Math.max(...report.results.map((row) => row.wallTokensPerSecond).filter(Number.isFinite), 1);
  const maxFirstOutput = Math.max(...report.results.map((row) => row.firstOutputMs).filter(Number.isFinite), 1);
  const modelInventory = modelInventoryRows(report.runtimeMetadata);
  const runtimeInventory = runtimeInventoryRows(report.runtimeMetadata);
  const environmentRows = environmentRowsFor(report);
  const generatedLabel = report.generatedAt ? new Date(report.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'Unknown';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemma Model Benchmark Report</title>
  <style>
${css()}
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-copy">
      <p class="kicker">Open Gemma Benchmark</p>
      <h1>${escapeHtml(report.title)}</h1>
      <p class="lede">${escapeHtml(reportLede(report))}</p>
    </div>
    <div class="hero-panel" aria-label="Run summary">
      <div>
        <span class="eyebrow">Generated</span>
        <strong>${escapeHtml(generatedLabel)}</strong>
      </div>
      <div>
        <span class="eyebrow">CLI</span>
        <strong>${escapeHtml(shortPath(report.cli ?? 'Unknown'))}</strong>
      </div>
      <div>
        <span class="eyebrow">Clean Runtime</span>
        <strong>${escapeHtml(report.cleanRuntimeReset ?? 'Unknown')}</strong>
      </div>
    </div>
  </header>

  <nav class="section-nav" aria-label="Report sections">
    <a href="#overview">Overview</a>
    ${hasFixtures ? '<a href="#fixtures">Fixtures</a>' : ''}
    <a href="#results">Results</a>
    <a href="#runtime">Runtime</a>
    <a href="#evidence">Evidence</a>
    <a href="#commands">Commands</a>
  </nav>

  <main>
    <section id="overview" class="section">
      <div class="section-heading">
        <p class="kicker">Overview</p>
        <h2>Run Verdict</h2>
      </div>
      <div class="stat-grid">
        ${statCard('Cases Completed', `${report.results.filter((row) => row.status === 'completed').length} / ${report.results.length}`, 'All planned provider/model/thinking cases.')}
        ${statCard('Fastest Tok/s', fastest ? `${formatNumber(fastest.tokensPerSecond)} tok/s` : 'n/a', fastest ? `${fastest.provider} / ${fastest.model} / ${fastest.thinking}` : 'No completed run')}
        ${statCard('Slowest First Output', slowestFirstOutput ? `${formatInteger(slowestFirstOutput.firstOutputMs)} ms` : 'n/a', slowestFirstOutput ? `${slowestFirstOutput.provider} / ${slowestFirstOutput.model} / ${slowestFirstOutput.thinking}` : 'No timing data')}
        ${statCard('LM Studio 31B Think On', lmStudio31bThinking ? `${formatInteger(lmStudio31bThinking.firstOutputMs)} ms first output` : 'n/a', lmStudio31bThinking ? `${formatNumber(lmStudio31bThinking.tokensPerSecond)} tok/s, ${formatInteger(lmStudio31bThinking.modelTimeMs)} ms model time` : 'Missing case')}
      </div>
      <div class="summary-list">
        ${report.summary.length > 0
          ? report.summary.map((item) => `<p>${inlineCode(escapeHtml(item))}</p>`).join('\n        ')
          : `<p>${escapeHtml('No unified summary section was present in this report.')}</p>`}
      </div>
      <div class="chart-panel">
        <div class="section-heading compact">
          <p class="kicker">Wall Throughput</p>
          <h2>All Cases By Wall Tok/s</h2>
        </div>
        <div class="bar-list">
          ${report.results
            .toSorted((a, b) => b.wallTokensPerSecond - a.wallTokensPerSecond)
            .map((row) => barRow(row, maxWallTokensPerSecond))
            .join('\n          ')}
        </div>
      </div>
    </section>

    ${hasFixtures ? `<section id="fixtures" class="section">
      <div class="section-heading">
        <p class="kicker">Reference Material</p>
        <h2>Fixtures</h2>
      </div>
      ${fixturesTable(report.fixtures)}
    </section>` : ''}

    <section id="results" class="section">
      <div class="section-heading split">
        <div>
          <p class="kicker">Sortable Matrix</p>
          <h2>Results</h2>
        </div>
        <label class="table-search">
          <span>Filter</span>
          <input id="resultFilter" type="search" placeholder="provider, model, status">
        </label>
      </div>
      <p class="section-note"><span id="resultCount">${report.results.length}</span> cases visible. Click any column header to sort.</p>
      ${resultsTable(report.results, { maxTokensPerSecond, maxWallTokensPerSecond, maxFirstOutput })}
      ${report.notApplicable.length > 0 ? notApplicableTable(report.notApplicable) : ''}
      ${sortableTable('providerSummary', 'Provider Summary', 'Averages are computed from completed rows in this report.', [
        col('provider', 'Provider'),
        numberCol('cases', 'Cases'),
        numberCol('completed', 'Completed'),
        numberCol('avgTokensPerSecond', 'Avg tok/s'),
        numberCol('avgWallTokensPerSecond', 'Avg wall tok/s'),
        numberCol('avgFirstOutputMs', 'Avg first output'),
        numberCol('avgModelTimeMs', 'Avg model time')
      ], providerSummaries, { compact: true })}
    </section>

    <section id="runtime" class="section">
      <div class="section-heading">
        <p class="kicker">Stack</p>
        <h2>Runtime And Configuration</h2>
      </div>
      ${sortableTable('environment', 'Environment And CLI', 'Captured from the report header and stack section.', [
        col('item', 'Item'),
        col('value', 'Value')
      ], environmentRows, { compact: true })}
      ${sortableTable('runtimeInventory', 'Runtime Inventory', 'Runtime APIs touched during this report.', [
        col('provider', 'Provider'),
        col('endpoint', 'Endpoint'),
        col('version', 'Version'),
        col('commandVersion', 'Command version'),
        numberCol('listedModelCount', 'Visible models'),
        col('loadedModels', 'Loaded before run')
      ], runtimeInventory, { compact: true })}
      ${sortableTable('modelInventory', 'Configured Model Inventory', 'Model metadata observed from the runtime APIs before benchmark cases ran.', [
        col('provider', 'Provider'),
        col('model', 'Model'),
        col('family', 'Family'),
        col('parameters', 'Params'),
        col('quantization', 'Quant'),
        numberCol('contextLength', 'Context'),
        numberCol('maxContextLength', 'Max context'),
        numberCol('temperature', 'Temp'),
        col('capabilities', 'Capabilities')
      ], modelInventory)}
      <details class="metadata-block">
        <summary>Raw runtime metadata JSON</summary>
        <pre>${escapeHtml(JSON.stringify(report.runtimeMetadata ?? {}, null, 2))}</pre>
      </details>
    </section>

    <section id="evidence" class="section">
      <div class="section-heading">
        <p class="kicker">Evidence</p>
        <h2>Runtime Reset And Loaded State</h2>
      </div>
      ${sortableTable('resetEvidence', 'Runtime Reset Evidence', 'Each row records before and after cleanup for one benchmark case.', [
        ...caseColumns(report.resetEvidence),
        col('before', 'Before'),
        col('after', 'After'),
        col('unloaded', 'Unloaded')
      ], report.resetEvidence)}
      ${sortableTable('modelStateEvidence', 'Runtime Model State Evidence', 'Loaded model state captured during each case.', [
        ...caseColumns(report.modelStateEvidence),
        col('state', 'State'),
        col('runtimeStatus', 'Runtime status'),
        numberCol('contextLength', 'Context'),
        numberCol('maxContextLength', 'Max context'),
        col('processor', 'Processor'),
        col('quantization', 'Quant')
      ], report.modelStateEvidence)}
    </section>

    <section id="commands" class="section">
      <div class="section-heading">
        <p class="kicker">Repro</p>
        <h2>Commands And Prompt</h2>
      </div>
      <div class="prompt-block">
        <span class="eyebrow">Prompt</span>
        <pre>${escapeHtml(report.prompt)}</pre>
      </div>
      ${sortableTable('commandsTable', 'Runnable Commands', 'The exact command recorded for each case. Use the copy button per row.', [
        ...caseColumns(report.commands),
        {
          key: 'command',
          label: 'Command',
          render: (row) => `<div class="command-cell"><button type="button" class="copy-btn">Copy</button><code>${escapeHtml(row.command)}</code></div>`,
          html: true
        }
      ], report.commands)}
    </section>
  </main>

  <script>
${js()}
  </script>
</body>
</html>`;
}

function parseTopMetadata(markdown) {
  const metadata = {};
  for (const line of markdown.split('\n').slice(0, 12)) {
    const [key, ...rest] = line.split(':');
    if (!rest.length) continue;
    const value = rest.join(':').trim();
    if (key === 'Generated') metadata.generatedAt = value;
    if (key === 'Category') metadata.category = value;
    if (key === 'Providers') metadata.providers = value;
    if (key === 'CLI') metadata.cli = value;
    if (key === 'Clean runtime reset') metadata.cleanRuntimeReset = value;
  }
  return metadata;
}

function parseRuntimeMetadata(markdown) {
  const block = extractFence(markdown, 'Runtime Metadata', 'json');
  if (!block) return {};
  try {
    return JSON.parse(block);
  } catch {
    return {};
  }
}

function parseResultsTable(markdown) {
  const lines = linesInSection(markdown, 'Results').filter((line) => line.startsWith('|'));
  const rows = parsePipeTable(lines);
  return rows.map((row) => ({
    provider: row.Provider,
    model: row.Model,
    fixture: row.Fixture,
    thinking: row.Thinking,
    status: row.Status,
    tokensPerSecond: numeric(row['Tok/s']),
    wallTokensPerSecond: numeric(row['Wall tok/s']),
    tokens: numeric(row.Tokens),
    source: row.Source,
    firstOutputMs: numeric(row['First output']),
    completionTimeMs: numeric(row['Completion time']),
    modelTimeMs: numeric(row['Model time']),
    context: numeric(row.Context),
    temperature: numeric(row.Temp),
    maxTokens: row['Max tokens'],
    answerChars: numeric(row['Answer chars']),
    outputOrError: row['Output / Error']
  }));
}

function parseFixturesTable(markdown) {
  const lines = linesInSection(markdown, 'Fixtures').filter((line) => line.startsWith('|'));
  return parsePipeTable(lines).map((row) => ({
    fixture: row.Fixture,
    kind: row.Kind,
    localFile: row['Local file'],
    source: row.Source,
    license: row.License,
    reference: row.Reference
  }));
}

function parseNotApplicableTable(markdown) {
  const lines = linesInSection(markdown, 'Not Applicable').filter((line) => line.startsWith('|'));
  return parsePipeTable(lines).map((row) => ({
    provider: row.Provider,
    model: row.Model,
    fixture: row.Fixture,
    thinking: row.Thinking,
    reason: row.Reason
  }));
}

function parseRuntimeResetEvidence(markdown) {
  return linesInSection(markdown, 'Runtime Reset Evidence')
    .filter((line) => line.startsWith('- '))
    .flatMap((line) => {
      const match = line.match(/^- (.+): before (.*?); after (.*)$/);
      if (!match) return [];
      const label = parseCaseLabel(match[1]);
      if (!label) return [];
      const after = match[3].trim();
      return [{
        ...label,
        before: match[2].trim(),
        after,
        unloaded: after.match(/unloaded=([^\s]+)/)?.[1] ?? ''
      }];
    });
}

function parseRuntimeModelStateEvidence(markdown) {
  return linesInSection(markdown, 'Runtime Model State Evidence')
    .filter((line) => line.startsWith('- '))
    .flatMap((line) => {
      const match = line.match(/^- (.+): (.*)$/);
      if (!match) return [];
      const label = parseCaseLabel(match[1]);
      if (!label) return [];
      const stateText = match[2];
      const details = stateText.split(',').map((part) => part.trim()).filter(Boolean);
      const state = details[0] ?? '';
      const runtimeStatus = details.find((part) => !/^context |^max context |^processor |^quant /.test(part) && part !== state) ?? '';
      return [{
        ...label,
        state,
        runtimeStatus,
        contextLength: numeric(stateText.match(/context (\d+)/)?.[1]),
        maxContextLength: numeric(stateText.match(/max context (\d+)/)?.[1]),
        processor: stateText.match(/processor ([^,]+)/)?.[1] ?? '',
        quantization: stateText.match(/quant ([^,]+)/)?.[1] ?? ''
      }];
    });
}

function parseCommands(markdown) {
  const section = sectionText(markdown, 'Commands');
  const matches = [...section.matchAll(/### (.+)\n\n```sh\n([\s\S]*?)\n```/g)];
  return matches.flatMap((match) => {
    const label = parseCaseLabel(match[1]);
    return label ? [{
      ...label,
      command: match[2].trim().split('\n')[0] ?? ''
    }] : [];
  });
}

function parseCaseLabel(label) {
  const parts = label.split(' / ').map((part) => part.trim()).filter(Boolean);
  const thinkPart = parts.at(-1)?.match(/^think (on|off|auto)$/);
  if (!thinkPart || parts.length < 3) {
    return undefined;
  }
  return {
    provider: parts[0],
    model: parts[1],
    fixture: parts.length > 3 ? parts.slice(2, -1).join(' / ') : '',
    thinking: thinkPart[1]
  };
}

function parsePipeTable(lines) {
  if (lines.length < 3) return [];
  const headers = splitPipeRow(lines[0]);
  return lines.slice(2).map((line) => {
    const cells = splitPipeRow(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function splitPipeRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function extractFence(markdown, heading, language) {
  const section = sectionText(markdown, heading);
  const match = section.match(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```'));
  return match?.[1];
}

function linesInSection(markdown, heading) {
  return sectionText(markdown, heading).split('\n').map((line) => line.trim()).filter(Boolean);
}

function sectionText(markdown, heading) {
  const headingText = `## ${heading}`;
  const start = markdown.indexOf(headingText);
  if (start < 0) return '';
  const bodyStart = markdown.indexOf('\n', start) + 1;
  const rest = markdown.slice(bodyStart);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function environmentRowsFor(report) {
  const rows = [
    { item: 'Generated', value: report.generatedAt ?? '' },
    { item: 'Providers', value: report.providers ?? '' },
    { item: 'CLI', value: report.cli ?? '' },
    { item: 'Clean runtime reset', value: report.cleanRuntimeReset ?? '' }
  ];
  for (const item of report.stack) {
    const splitAt = item.indexOf(': ');
    if (splitAt > 0) {
      rows.push({ item: item.slice(0, splitAt), value: item.slice(splitAt + 2) });
    }
  }
  return rows;
}

function runtimeInventoryRows(runtimeMetadata) {
  return Object.entries(runtimeMetadata ?? {}).map(([provider, data]) => ({
    provider,
    endpoint: data.endpoint ?? '',
    version: data.version ?? '',
    commandVersion: data.commandVersion ?? '',
    listedModelCount: data.listedModelCount ?? '',
    loadedModels: Array.isArray(data.loadedModels) && data.loadedModels.length > 0
      ? data.loadedModels.map((model) => model.name ?? model.model ?? model.modelKey ?? '').filter(Boolean).join(', ')
      : 'none'
  }));
}

function modelInventoryRows(runtimeMetadata) {
  return Object.entries(runtimeMetadata ?? {}).flatMap(([provider, data]) =>
    Object.entries(data.models ?? {}).map(([model, info]) => ({
      provider,
      model,
      family: info.family ?? info.rawDetails?.family ?? '',
      parameters: info.parameterSize ?? info.paramsString ?? info.rawDetails?.parameter_size ?? '',
      quantization: info.quantization?.name ?? info.quantization ?? info.rawDetails?.quantization_level ?? '',
      contextLength: info.loadedContextLength ?? info.contextLength ?? '',
      maxContextLength: info.maxContextLength ?? info.contextLength ?? '',
      temperature: info.temperature ?? info.parameters?.temperature ?? '',
      capabilities: Array.isArray(info.capabilities) ? info.capabilities.join(', ') : ''
    }))
  );
}

function summarizeProviders(results) {
  const groups = new Map();
  for (const row of results) {
    const group = groups.get(row.provider) ?? [];
    group.push(row);
    groups.set(row.provider, group);
  }
  return [...groups.entries()].map(([provider, rows]) => {
    const completed = rows.filter((row) => row.status === 'completed');
    return {
      provider,
      cases: rows.length,
      completed: completed.length,
      avgTokensPerSecond: average(completed.map((row) => row.tokensPerSecond)),
      avgWallTokensPerSecond: average(completed.map((row) => row.wallTokensPerSecond)),
      avgFirstOutputMs: average(completed.map((row) => row.firstOutputMs)),
      avgModelTimeMs: average(completed.map((row) => row.modelTimeMs))
    };
  });
}

function resultsTable(rows, context) {
  const hasFixture = rows.some((row) => row.fixture);
  const hasCompletionTime = rows.some((row) => Number.isFinite(row.completionTimeMs));
  const hasOutput = rows.some((row) => row.outputOrError);
  const columns = [
    {
      key: 'provider',
      label: 'Provider',
      render: (row) => badge(row.provider, `provider-${row.provider}`),
      html: true
    },
    col('model', 'Model'),
    ...(hasFixture ? [col('fixture', 'Fixture')] : []),
    {
      key: 'thinking',
      label: 'Thinking',
      render: (row) => badge(row.thinking, `think-${row.thinking}`),
      html: true
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => badge(row.status, `status-${row.status}`),
      html: true
    },
    metricCol('tokensPerSecond', 'Tok/s', context.maxTokensPerSecond),
    metricCol('wallTokensPerSecond', 'Wall tok/s', context.maxWallTokensPerSecond),
    numberCol('tokens', 'Tokens'),
    col('source', 'Source'),
    metricCol('firstOutputMs', 'First output', context.maxFirstOutput, { suffix: ' ms', inverse: true }),
    ...(hasCompletionTime ? [numberCol('completionTimeMs', 'Completion time')] : []),
    numberCol('modelTimeMs', 'Model time'),
    numberCol('context', 'Context'),
    numberCol('temperature', 'Temp'),
    col('maxTokens', 'Max tokens'),
    ...(hasOutput ? [longTextCol('outputOrError', 'Output / Error')] : [numberCol('answerChars', 'Answer chars')])
  ];
  const defaultSortColumn = columns.findIndex((column) => column.key === 'wallTokensPerSecond');
  return sortableTable('resultsTable', 'Detailed Results', 'Provider token usage is used when available. Media reports include the raw model output or provider error in the final column.', columns, rows, { defaultSortColumn });
}

function fixturesTable(rows) {
  return sortableTable('fixturesTable', 'Fixtures And References', 'Source files, licenses, and known reference descriptions or transcripts used for manual review.', [
    col('fixture', 'Fixture'),
    col('kind', 'Kind'),
    pathCol('localFile', 'Local file'),
    linkCol('source', 'Source'),
    longTextCol('license', 'License'),
    longTextCol('reference', 'Reference')
  ], rows);
}

function notApplicableTable(rows) {
  return sortableTable('notApplicableTable', 'Not Applicable Coverage', 'Cases excluded before execution because the runtime cannot deliver that modality to the model. These are not model failures.', [
    col('provider', 'Provider'),
    col('model', 'Model'),
    col('fixture', 'Fixture'),
    col('thinking', 'Thinking'),
    longTextCol('reason', 'Reason')
  ], rows, { compact: true });
}

function caseColumns(rows) {
  return [
    col('provider', 'Provider'),
    col('model', 'Model'),
    ...(rows.some((row) => row.fixture) ? [col('fixture', 'Fixture')] : []),
    col('thinking', 'Thinking')
  ];
}

function sortableTable(id, title, note, columns, rows, options = {}) {
  return `<div class="table-block ${options.compact ? 'compact-table' : ''}">
    <div class="table-title">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(note)}</p>
      </div>
      <span class="row-count">${rows.length} rows</span>
    </div>
    <div class="table-shell">
      <table id="${escapeAttr(id)}" class="sortable-table ${id === 'resultsTable' ? 'results-table' : ''}"${options.defaultSortColumn >= 0 ? ` data-default-sort-column="${options.defaultSortColumn}"` : ''}>
        <thead>
          <tr>
            ${columns.map((column, index) => `<th scope="col"><button type="button" data-column="${index}">${escapeHtml(column.label)} <span class="sort-mark" aria-hidden="true">--</span></button></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `<tr>${columns.map((column) => tableCell(column, row)).join('')}</tr>`).join('\n          ')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function tableCell(column, row) {
  const value = row[column.key];
  const sortValue = column.sortValue ? column.sortValue(row) : value;
  const rendered = column.render ? column.render(row) : value;
  const content = column.html ? rendered : escapeHtml(displayValue(rendered));
  const classes = [
    column.numeric ? 'numeric' : '',
    column.className ?? ''
  ].filter(Boolean).join(' ');
  return `<td${classes ? ` class="${escapeAttr(classes)}"` : ''} data-sort-value="${escapeAttr(sortToken(sortValue))}">${content}</td>`;
}

function col(key, label) {
  return { key, label };
}

function numberCol(key, label) {
  return {
    key,
    label,
    numeric: true,
    render: (row) => formatMaybeNumber(row[key]),
    sortValue: (row) => row[key]
  };
}

function longTextCol(key, label) {
  return {
    key,
    label,
    className: 'wrap-cell',
    sortValue: (row) => row[key]
  };
}

function pathCol(key, label) {
  return {
    key,
    label,
    html: true,
    className: 'wrap-cell path-cell',
    render: (row) => `<code>${escapeHtml(row[key])}</code>`
  };
}

function linkCol(key, label) {
  return {
    key,
    label,
    html: true,
    className: 'wrap-cell',
    render: (row) => {
      const value = row[key];
      return /^https?:\/\//.test(String(value))
        ? `<a href="${escapeAttr(value)}">${escapeHtml(value)}</a>`
        : escapeHtml(displayValue(value));
    }
  };
}

function metricCol(key, label, max, options = {}) {
  return {
    key,
    label,
    numeric: true,
    html: true,
    sortValue: (row) => row[key],
    render: (row) => {
      const value = row[key];
      const pct = Number.isFinite(value) ? Math.max(4, Math.min(100, (value / max) * 100)) : 0;
      const width = options.inverse ? 100 - pct + 4 : pct;
      return `<span class="metric-bar" style="--bar-width:${width}%"><span>${formatMaybeNumber(value)}${options.suffix ?? ''}</span></span>`;
    }
  };
}

function statCard(label, value, detail) {
  return `<article class="stat-card">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(detail)}</p>
  </article>`;
}

function barRow(row, max) {
  const width = Number.isFinite(row.wallTokensPerSecond) ? Math.max(3, (row.wallTokensPerSecond / max) * 100) : 0;
  return `<div class="bar-row">
    <span class="bar-label">${escapeHtml(`${row.provider} / ${row.model} / ${row.thinking}`)}</span>
    <span class="bar-track"><span style="width:${width}%"></span></span>
    <strong>${formatMaybeNumber(row.wallTokensPerSecond)}</strong>
  </div>`;
}

function reportLede(report) {
  if (report.category) {
    return `A self-contained ${report.category} benchmark dashboard for ${report.providers ?? 'the selected providers'}, including runtime metadata, sortable results, commands, and fixture references.`;
  }
  return 'A self-contained benchmark dashboard for Ollama and LM Studio across Google base model weights, with thinking on and off.';
}

function badge(text, className) {
  return `<span class="badge ${escapeAttr(className)}">${escapeHtml(text)}</span>`;
}

function inlineCode(text) {
  return text.replace(/`([^`]+)`/g, '<code>$1</code>');
}

function average(values) {
  const numericValues = values.filter(Number.isFinite);
  if (numericValues.length === 0) return '';
  return Number((numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length).toFixed(2));
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return '';
  const match = String(value).replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : '';
}

function formatMaybeNumber(value) {
  if (!Number.isFinite(value)) return displayValue(value);
  return Number.isInteger(value) ? formatInteger(value) : formatNumber(value);
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  return String(value);
}

function sortToken(value) {
  if (Number.isFinite(value)) return String(value);
  return displayValue(value).toLowerCase();
}

function shortPath(value) {
  const parts = String(value).split('/');
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : String(value);
}

function escapeHtml(value) {
  return displayValue(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function css() {
  return `
:root {
  --paper: #f4f7f6;
  --ink: #20211f;
  --muted: #646b67;
  --line: #d5ded9;
  --panel: #ffffff;
  --panel-2: #eef4f2;
  --green: #146b5b;
  --green-2: #d8ede7;
  --coral: #ef5a38;
  --amber: #c58a1b;
  --cyan: #087a8b;
  --shadow: 0 18px 45px rgba(20, 29, 25, 0.12);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    linear-gradient(rgba(20, 107, 91, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(239, 90, 56, 0.045) 1px, transparent 1px),
    var(--paper);
  background-size: 34px 34px, 34px 34px, auto;
  color: var(--ink);
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
  line-height: 1.45;
}

a {
  color: inherit;
}

code,
pre {
  font-family: "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
}

.hero {
  min-height: 72vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  align-items: end;
  gap: 32px;
  padding: 64px clamp(20px, 5vw, 72px) 48px;
  border-bottom: 1px solid var(--line);
}

.hero-copy {
  max-width: 980px;
}

.kicker,
.eyebrow {
  margin: 0;
  color: var(--green);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 18px;
  max-width: 900px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(3.2rem, 8vw, 7.2rem);
  line-height: 0.92;
  letter-spacing: 0;
}

.lede {
  max-width: 720px;
  margin-bottom: 0;
  color: var(--muted);
  font-size: clamp(1.05rem, 2vw, 1.35rem);
}

.hero-panel,
.stat-card,
.table-block,
.chart-panel,
.summary-list,
.metadata-block,
.prompt-block {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: var(--shadow);
}

.hero-panel {
  display: grid;
  gap: 18px;
  padding: 20px;
}

.hero-panel strong {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
}

.section-nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 10px clamp(14px, 5vw, 72px);
  border-bottom: 1px solid var(--line);
  background: rgba(244, 247, 246, 0.92);
  backdrop-filter: blur(14px);
}

.section-nav a {
  padding: 9px 13px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.92rem;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}

.section-nav a:hover {
  background: var(--green-2);
  color: var(--green);
}

main {
  padding: 36px clamp(14px, 4vw, 64px) 72px;
}

.section {
  margin: 0 auto 54px;
  max-width: 1480px;
}

.section-heading {
  margin-bottom: 18px;
}

.section-heading h2 {
  margin-bottom: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 4vw, 3.5rem);
  letter-spacing: 0;
}

.section-heading.compact h2 {
  font-size: 1.7rem;
}

.section-heading.split {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
}

.section-note {
  color: var(--muted);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.stat-card {
  min-height: 150px;
  padding: 18px;
}

.stat-card span {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 800;
  text-transform: uppercase;
}

.stat-card strong {
  display: block;
  margin: 12px 0 10px;
  color: var(--green);
  font-size: clamp(1.55rem, 3vw, 2.5rem);
  line-height: 1;
}

.stat-card p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 0.92rem;
}

.summary-list {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
  padding: 18px;
}

.summary-list p {
  margin: 0;
}

.summary-list code {
  color: var(--coral);
  font-weight: 800;
}

.chart-panel,
.prompt-block,
.metadata-block {
  padding: 18px;
}

.bar-list {
  display: grid;
  gap: 8px;
}

.bar-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(140px, 2fr) 72px;
  align-items: center;
  gap: 12px;
  font-size: 0.9rem;
}

.bar-label {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 11px;
  overflow: hidden;
  border-radius: 999px;
  background: #e4ebe8;
}

.bar-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--green), var(--coral));
}

.table-search {
  display: grid;
  gap: 6px;
  min-width: min(100%, 340px);
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}

.table-search input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 11px 12px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  text-transform: none;
}

.table-block {
  margin-bottom: 18px;
  overflow: hidden;
}

.table-title {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

.table-title h3 {
  margin-bottom: 3px;
  font-size: 1.05rem;
}

.table-title p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.row-count {
  flex: none;
  color: var(--green);
  font-size: 0.82rem;
  font-weight: 800;
}

.table-shell {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

th,
td {
  border-bottom: 1px solid var(--line);
  padding: 10px 12px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
}

td.wrap-cell {
  min-width: 280px;
  max-width: 680px;
  white-space: normal;
  overflow-wrap: anywhere;
}

td.path-cell code {
  white-space: normal;
}

th {
  position: sticky;
  top: 42px;
  z-index: 2;
  background: #f8faf9;
}

th button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 900;
  text-align: left;
  text-transform: uppercase;
}

tbody tr:hover {
  background: #f8fbfa;
}

.numeric {
  text-align: right;
}

.sort-mark {
  color: var(--coral);
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 0.78rem;
  font-weight: 900;
  text-transform: uppercase;
}

.provider-ollama {
  background: #d8ede7;
  color: #0f594c;
}

.provider-lmstudio {
  background: #fde1d8;
  color: #9b351f;
}

.think-on {
  background: #f5e8c9;
  color: #815a11;
}

.think-off {
  background: #e6eaee;
  color: #3f464b;
}

.status-completed {
  background: #d8ede7;
  color: #0f594c;
}

.metric-bar {
  position: relative;
  display: block;
  min-width: 88px;
  padding: 4px 0;
  text-align: right;
}

.metric-bar::before {
  position: absolute;
  inset: 5px 0 5px auto;
  width: var(--bar-width);
  max-width: 100%;
  border-radius: 999px;
  background: rgba(20, 107, 91, 0.18);
  content: "";
}

.metric-bar span {
  position: relative;
}

.metadata-block summary {
  cursor: pointer;
  font-weight: 900;
}

.metadata-block pre,
.prompt-block pre {
  max-height: 520px;
  overflow: auto;
  margin: 14px 0 0;
  color: #27312e;
  font-size: 0.8rem;
  white-space: pre-wrap;
}

.command-cell {
  display: grid;
  grid-template-columns: auto minmax(420px, 1fr);
  align-items: start;
  gap: 10px;
}

.command-cell code {
  display: block;
  overflow: hidden;
  max-width: 980px;
  color: #27312e;
  text-overflow: ellipsis;
}

.copy-btn {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 9px;
  background: #fff;
  color: var(--green);
  cursor: pointer;
  font-weight: 900;
}

.copy-btn:hover {
  border-color: var(--green);
}

@media (max-width: 980px) {
  .hero {
    grid-template-columns: 1fr;
    min-height: auto;
    padding-top: 44px;
  }

  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .section-heading.split {
    display: grid;
    align-items: start;
  }
}

@media (max-width: 680px) {
  h1 {
    font-size: 3rem;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }

  .bar-row {
    grid-template-columns: 1fr;
    gap: 5px;
  }

  th,
  td {
    padding: 9px 10px;
  }

  .command-cell {
    grid-template-columns: 1fr;
  }
}
`;
}

function js() {
  return `
const tables = [...document.querySelectorAll('.sortable-table')];

for (const table of tables) {
  const headers = [...table.querySelectorAll('th button')];
  headers.forEach((button, index) => {
    button.addEventListener('click', () => sortTable(table, index));
  });
}

function sortTable(table, columnIndex) {
  const tbody = table.tBodies[0];
  const currentColumn = table.dataset.sortColumn;
  const currentDirection = table.dataset.sortDirection || 'asc';
  const direction = currentColumn === String(columnIndex) && currentDirection === 'asc' ? 'desc' : 'asc';
  const rows = [...tbody.rows].map((row, index) => ({ row, index }));

  rows.sort((a, b) => {
    const left = cellSortValue(a.row.cells[columnIndex]);
    const right = cellSortValue(b.row.cells[columnIndex]);
    const result = compareValues(left, right);
    return direction === 'asc' ? result || a.index - b.index : -result || a.index - b.index;
  });

  tbody.append(...rows.map((item) => item.row));
  table.dataset.sortColumn = String(columnIndex);
  table.dataset.sortDirection = direction;
  updateSortMarks(table, columnIndex, direction);
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

function updateSortMarks(table, columnIndex, direction) {
  table.querySelectorAll('.sort-mark').forEach((mark, index) => {
    mark.textContent = index === columnIndex ? (direction === 'asc' ? '^' : 'v') : '--';
  });
}

const resultFilter = document.querySelector('#resultFilter');
const resultCount = document.querySelector('#resultCount');
if (resultFilter) {
  resultFilter.addEventListener('input', () => {
    const needle = resultFilter.value.trim().toLowerCase();
    const rows = [...document.querySelectorAll('#resultsTable tbody tr')];
    let visible = 0;
    for (const row of rows) {
      const show = row.textContent.toLowerCase().includes(needle);
      row.hidden = !show;
      if (show) visible += 1;
    }
    if (resultCount) resultCount.textContent = String(visible);
  });
}

document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.parentElement?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1100);
    } catch {
      button.textContent = 'Select';
      setTimeout(() => { button.textContent = 'Copy'; }, 1100);
    }
  });
});

for (const table of tables) {
  if (table.id === 'resultsTable') {
    const defaultColumn = Number(table.dataset.defaultSortColumn || 5);
    sortTable(table, defaultColumn);
    break;
  }
}
`;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const input = path.resolve(args.input ?? defaultInput);
  const output = path.resolve(args.output ?? input.replace(/\.md$/i, '.html'));
  const markdown = await readFile(input, 'utf8');
  const report = parseReportMarkdown(markdown);
  const html = renderReportHtml(report);
  await writeFile(output, html, 'utf8');
  console.log(`Wrote static report site: ${output}`);
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') {
      parsed.input = args[++index];
    } else if (arg === '--output') {
      parsed.output = args[++index];
    } else if (!parsed.input) {
      parsed.input = arg;
    } else if (!parsed.output) {
      parsed.output = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
