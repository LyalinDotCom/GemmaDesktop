import { describe, expect, it } from 'vitest';
import { buildRunnerCommand, detectRunner, parseRunnerOutput } from './runTests.js';

function fsFromMap(map: Record<string, string>) {
  return {
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(map, path),
    readFile: async (path: string) => map[path]
  };
}

describe('detectRunner', () => {
  it('detects vitest from devDependencies', async () => {
    const fs = fsFromMap({
      '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^1' } })
    });
    expect(await detectRunner('/repo', fs)).toBe('vitest');
  });

  it('detects jest from dependencies', async () => {
    const fs = fsFromMap({
      '/repo/package.json': JSON.stringify({ dependencies: { jest: '^29' } })
    });
    expect(await detectRunner('/repo', fs)).toBe('jest');
  });

  it('detects pytest from pyproject.toml', async () => {
    const fs = fsFromMap({ '/repo/pyproject.toml': '[project]' });
    expect(await detectRunner('/repo', fs)).toBe('pytest');
  });

  it('detects go-test from go.mod', async () => {
    const fs = fsFromMap({ '/repo/go.mod': 'module foo' });
    expect(await detectRunner('/repo', fs)).toBe('go-test');
  });

  it('detects cargo-test from Cargo.toml', async () => {
    const fs = fsFromMap({ '/repo/Cargo.toml': '[package]' });
    expect(await detectRunner('/repo', fs)).toBe('cargo-test');
  });

  it('returns unknown when nothing matches', async () => {
    expect(await detectRunner('/repo', fsFromMap({}))).toBe('unknown');
  });

  it('respects packageManager hint for pnpm', async () => {
    const fs = fsFromMap({
      '/repo/package.json': JSON.stringify({ packageManager: 'pnpm@9', devDependencies: { vitest: '^1' } })
    });
    expect(await detectRunner('/repo', fs)).toBe('pnpm-vitest');
  });
});

describe('buildRunnerCommand', () => {
  it('builds a vitest command with file and name filters', () => {
    expect(buildRunnerCommand('vitest', { file: 'src/x.test.ts', name: 'when async' })).toEqual({
      command: 'npx',
      args: ['vitest', 'run', '--reporter=json', 'src/x.test.ts', '-t', 'when async']
    });
  });

  it('builds a jest command with --json reporter', () => {
    expect(buildRunnerCommand('jest', {})).toEqual({ command: 'npx', args: ['jest', '--json'] });
  });

  it('builds a pytest -k filter', () => {
    expect(buildRunnerCommand('pytest', { name: 'TestThing' })).toEqual({ command: 'pytest', args: ['-q', '-k', 'TestThing'] });
  });

  it('builds a go test ./... command', () => {
    expect(buildRunnerCommand('go-test', {})).toEqual({ command: 'go', args: ['test', '-json', './...'] });
  });

  it('returns undefined for unknown runners', () => {
    expect(buildRunnerCommand('unknown', {})).toBeUndefined();
  });
});

describe('parseRunnerOutput', () => {
  it('parses vitest/jest JSON output and extracts failures', () => {
    const stdout = JSON.stringify({
      numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0,
      testResults: [{
        testFilePath: '/repo/src/foo.test.ts',
        assertionResults: [
          { status: 'passed', fullName: 'a' },
          { status: 'passed', fullName: 'b' },
          { status: 'failed', fullName: 'c', failureMessages: ['Error: boom\n  at line 1'] }
        ]
      }]
    });
    const summary = parseRunnerOutput('vitest', stdout, '', 1);
    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 0, total: 3 });
    expect(summary.failures).toEqual([{ name: 'c', file: '/repo/src/foo.test.ts', message: expect.stringContaining('boom') }]);
  });

  it('parses pytest summary line', () => {
    const stdout = '5 passed, 1 failed, 2 skipped in 0.01s\nFAILED tests/test_foo.py::test_bar - assertion failed';
    const summary = parseRunnerOutput('pytest', stdout, '', 1);
    expect(summary).toMatchObject({ passed: 5, failed: 1, skipped: 2 });
    expect(summary.failures[0]).toMatchObject({ file: 'tests/test_foo.py', name: 'test_bar' });
  });

  it('parses go test -json events', () => {
    const stdout = [
      JSON.stringify({ Action: 'pass', Test: 'TestA', Package: 'pkg' }),
      JSON.stringify({ Action: 'fail', Test: 'TestB', Package: 'pkg' })
    ].join('\n');
    const summary = parseRunnerOutput('go-test', stdout, '', 1);
    expect(summary).toMatchObject({ passed: 1, failed: 1 });
    expect(summary.failures[0]).toMatchObject({ name: 'TestB', file: 'pkg' });
  });

  it('parses cargo test result line', () => {
    const stdout = 'test result: ok. 4 passed; 1 failed; 2 ignored; 0 measured';
    const summary = parseRunnerOutput('cargo-test', stdout, '', 1);
    expect(summary).toMatchObject({ passed: 4, failed: 1, skipped: 2 });
  });

  it('falls back to exit code when no parser matches', () => {
    const summary = parseRunnerOutput('unknown', '', 'kaboom', 2);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]?.message).toContain('kaboom');
  });
});
