export type TestRunner = 'vitest' | 'jest' | 'pnpm-vitest' | 'pnpm-jest' | 'yarn-vitest' | 'yarn-jest' | 'pytest' | 'go-test' | 'cargo-test' | 'unknown';

export interface RunnerProbeFs {
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string | undefined>;
}

export async function detectRunner(cwd: string, fs: RunnerProbeFs): Promise<TestRunner> {
  const pkgPath = `${cwd}/package.json`;
  if (await fs.exists(pkgPath)) {
    const raw = await fs.readFile(pkgPath);
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as {
          scripts?: Record<string, string>;
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
          packageManager?: string;
        };
        const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const pm = (pkg.packageManager ?? '').split('@')[0];
        if (allDeps.vitest) {
          if (pm === 'pnpm') return 'pnpm-vitest';
          if (pm === 'yarn') return 'yarn-vitest';
          return 'vitest';
        }
        if (allDeps.jest) {
          if (pm === 'pnpm') return 'pnpm-jest';
          if (pm === 'yarn') return 'yarn-jest';
          return 'jest';
        }
        const scripts = pkg.scripts ?? {};
        if (typeof scripts.test === 'string') {
          if (scripts.test.includes('vitest')) return 'vitest';
          if (scripts.test.includes('jest')) return 'jest';
        }
      } catch {
        // fall through
      }
    }
  }
  if (await fs.exists(`${cwd}/pyproject.toml`) || await fs.exists(`${cwd}/pytest.ini`) || await fs.exists(`${cwd}/setup.cfg`)) {
    return 'pytest';
  }
  if (await fs.exists(`${cwd}/go.mod`)) return 'go-test';
  if (await fs.exists(`${cwd}/Cargo.toml`)) return 'cargo-test';
  return 'unknown';
}

export interface RunnerCommand {
  command: string;
  args: string[];
}

export function buildRunnerCommand(runner: TestRunner, options: { file?: string; name?: string }): RunnerCommand | undefined {
  const file = options.file;
  const name = options.name;
  switch (runner) {
    case 'vitest':
      return { command: 'npx', args: ['vitest', 'run', '--reporter=json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'pnpm-vitest':
      return { command: 'pnpm', args: ['exec', 'vitest', 'run', '--reporter=json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'yarn-vitest':
      return { command: 'yarn', args: ['vitest', 'run', '--reporter=json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'jest':
      return { command: 'npx', args: ['jest', '--json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'pnpm-jest':
      return { command: 'pnpm', args: ['exec', 'jest', '--json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'yarn-jest':
      return { command: 'yarn', args: ['jest', '--json', ...(file ? [file] : []), ...(name ? ['-t', name] : [])] };
    case 'pytest':
      return { command: 'pytest', args: ['-q', ...(file ? [file] : []), ...(name ? ['-k', name] : [])] };
    case 'go-test':
      return { command: 'go', args: ['test', '-json', ...(file ? [file] : ['./...']), ...(name ? ['-run', name] : [])] };
    case 'cargo-test':
      return { command: 'cargo', args: ['test', ...(name ? [name] : []), ...(file ? ['--', file] : [])] };
    case 'unknown':
      return undefined;
  }
}

export interface ParsedTestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failures: Array<{ name: string; file?: string; message?: string }>;
}

export function parseRunnerOutput(runner: TestRunner, stdout: string, stderr: string, exitCode: number): ParsedTestSummary {
  if (runner === 'vitest' || runner === 'pnpm-vitest' || runner === 'yarn-vitest' || runner === 'jest' || runner === 'pnpm-jest' || runner === 'yarn-jest') {
    return parseJestVitestJson(stdout) ?? parseFromExitCode(stdout, stderr, exitCode);
  }
  if (runner === 'pytest') return parsePytest(stdout, stderr, exitCode);
  if (runner === 'go-test') return parseGoTestJson(stdout, stderr, exitCode);
  if (runner === 'cargo-test') return parseCargoTest(stdout, stderr, exitCode);
  return parseFromExitCode(stdout, stderr, exitCode);
}

function parseJestVitestJson(stdout: string): ParsedTestSummary | undefined {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) return undefined;
  try {
    const data = JSON.parse(stdout.slice(jsonStart)) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{
        testFilePath?: string;
        name?: string;
        assertionResults?: Array<{ status?: string; title?: string; fullName?: string; failureMessages?: string[] }>;
      }>;
    };
    const failures: ParsedTestSummary['failures'] = [];
    for (const file of data.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          failures.push({
            name: assertion.fullName ?? assertion.title ?? '(unnamed)',
            file: file.testFilePath ?? file.name,
            message: (assertion.failureMessages ?? [])[0]?.split('\n').slice(0, 4).join('\n')
          });
        }
      }
    }
    return {
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? failures.length,
      skipped: data.numPendingTests ?? 0,
      total: data.numTotalTests ?? (data.numPassedTests ?? 0) + (data.numFailedTests ?? 0) + (data.numPendingTests ?? 0),
      failures
    };
  } catch {
    return undefined;
  }
}

function parsePytest(stdout: string, _stderr: string, exitCode: number): ParsedTestSummary {
  const summary = stdout.match(/(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+skipped/g) ?? [];
  let passed = 0, failed = 0, skipped = 0;
  for (const piece of summary) {
    const passedMatch = piece.match(/(\d+)\s+passed/);
    const failedMatch = piece.match(/(\d+)\s+failed/);
    const skippedMatch = piece.match(/(\d+)\s+skipped/);
    if (passedMatch) passed = Number(passedMatch[1]);
    if (failedMatch) failed = Number(failedMatch[1]);
    if (skippedMatch) skipped = Number(skippedMatch[1]);
  }
  const failures: ParsedTestSummary['failures'] = [];
  for (const match of stdout.matchAll(/^FAILED\s+(.+?)(?:::(\S+))?(?:\s+-\s+(.*))?$/gm)) {
    const file = match[1]?.trim();
    const name = match[2]?.trim();
    failures.push({ file, name: name ?? file ?? '(unnamed)', message: match[3]?.trim() || undefined });
  }
  return { passed, failed: failed || (exitCode !== 0 ? failures.length || 1 : 0), skipped, total: passed + failed + skipped, failures };
}

function parseGoTestJson(stdout: string, _stderr: string, exitCode: number): ParsedTestSummary {
  let passed = 0, failed = 0, skipped = 0;
  const failures: ParsedTestSummary['failures'] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { Action?: string; Test?: string; Package?: string; Output?: string };
      if (event.Action === 'pass' && event.Test) passed += 1;
      else if (event.Action === 'fail' && event.Test) {
        failed += 1;
        failures.push({ name: event.Test, file: event.Package });
      } else if (event.Action === 'skip' && event.Test) skipped += 1;
    } catch {
      // ignore
    }
  }
  if (failed === 0 && exitCode !== 0) failed = 1;
  return { passed, failed, skipped, total: passed + failed + skipped, failures };
}

function parseCargoTest(stdout: string, _stderr: string, exitCode: number): ParsedTestSummary {
  const match = stdout.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+ignored/);
  const passed = match ? Number(match[1]) : 0;
  const failed = match ? Number(match[2]) : exitCode === 0 ? 0 : 1;
  const skipped = match ? Number(match[3]) : 0;
  const failures: ParsedTestSummary['failures'] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED/);
    if (m) failures.push({ name: m[1] });
  }
  return { passed, failed, skipped, total: passed + failed + skipped, failures };
}

function parseFromExitCode(stdout: string, stderr: string, exitCode: number): ParsedTestSummary {
  return {
    passed: 0,
    failed: exitCode === 0 ? 0 : 1,
    skipped: 0,
    total: 0,
    failures: exitCode === 0 ? [] : [{ name: 'unknown', message: (stderr || stdout).split('\n').slice(0, 4).join('\n') || `exit ${exitCode}` }]
  };
}
