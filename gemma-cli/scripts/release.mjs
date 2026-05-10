#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined;

const packages = [
  { name: 'gemma-cli-core', dir: 'packages/core' },
  { name: 'gemma-cli', dir: 'packages/cli' }
];

function log(message) {
  console.log(`[release] ${message}`);
}

function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ? resolve(repoRoot, options.cwd) : repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(detail || `${command} exited with ${result.status}`);
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(resolve(repoRoot, path), `${JSON.stringify(value, null, 2)}\n`);
}

function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Expected a stable semver version, got ${version}`);
  }
  const [, major, minor, patch] = match.map(Number);
  if (major !== 0) {
    throw new Error(`Gemma CLI publishes on the 0.x.y line before 1.0; got ${version}`);
  }
  return { major, minor, patch };
}

function nextPatch(version) {
  const parsed = parseReleaseVersion(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function ensureCleanGit() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'git status failed');
  }
  if (result.stdout.trim()) {
    throw new Error('Working tree must be clean before a real publish.');
  }
}

function ensureNpmAuth() {
  const result = spawnSync('npm', ['whoami'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.status !== 0) {
    throw new Error('npm is not authenticated. Run `npm adduser`, then retry `npm run release:publish`.');
  }
  log(`npm authenticated as ${result.stdout.trim()}`);
}

function packageVersionExists(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.status === 0) {
    return true;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes('E404') || output.includes('Not Found')) {
    return false;
  }
  throw new Error(output.trim() || `Could not check ${name}@${version}`);
}

function assertPackageState() {
  const root = readJson('package.json');
  const core = readJson('packages/core/package.json');
  const cli = readJson('packages/cli/package.json');

  if (root.private !== true) {
    throw new Error('The workspace root must stay private; publish packages from packages/* only.');
  }
  if (core.name !== 'gemma-cli-core' || cli.name !== 'gemma-cli') {
    throw new Error('Unexpected package names. Expected gemma-cli-core and gemma-cli.');
  }
  if (root.version !== core.version || root.version !== cli.version) {
    throw new Error(`Package versions must match. root=${root.version} core=${core.version} cli=${cli.version}`);
  }
  parseReleaseVersion(root.version);
  if (cli.dependencies?.['gemma-cli-core'] !== core.version) {
    throw new Error(`gemma-cli must depend on gemma-cli-core ${core.version}.`);
  }
  if (!existsSync(resolve(repoRoot, 'packages/cli/README.md'))) {
    throw new Error('packages/cli/README.md is required for npm publish.');
  }
  return { version: root.version, nextVersion: nextPatch(root.version) };
}

function publishedState(version) {
  return Object.fromEntries(packages.map((pkg) => [pkg.name, packageVersionExists(pkg.name, version)]));
}

function assertPublishableState(state, version) {
  const corePublished = state['gemma-cli-core'];
  const cliPublished = state['gemma-cli'];
  if (corePublished && cliPublished) {
    throw new Error(`gemma-cli and gemma-cli-core ${version} already exist on npm. Bump the version before publishing.`);
  }
  if (cliPublished && !corePublished) {
    throw new Error(`gemma-cli ${version} exists but gemma-cli-core ${version} does not; refusing inconsistent publish state.`);
  }
  if (corePublished && !cliPublished) {
    log(`gemma-cli-core ${version} is already published; release will resume by publishing gemma-cli`);
  }
}

function packDryRun() {
  for (const pkg of packages) {
    run('npm', ['pack', '--dry-run'], { cwd: pkg.dir });
  }
}

function publishPackages(state, version) {
  for (const pkg of packages) {
    if (state[pkg.name]) {
      log(`${pkg.name} ${version} already published; skipping`);
      continue;
    }
    const publishArgs = ['publish', '--access', 'public'];
    if (otp) {
      publishArgs.push('--otp', otp);
    }
    run('npm', publishArgs, { cwd: pkg.dir });
  }
}

function bumpToNextVersion(nextVersion) {
  const root = readJson('package.json');
  const core = readJson('packages/core/package.json');
  const cli = readJson('packages/cli/package.json');

  root.version = nextVersion;
  core.version = nextVersion;
  cli.version = nextVersion;
  cli.dependencies['gemma-cli-core'] = nextVersion;

  writeJson('package.json', root);
  writeJson('packages/core/package.json', core);
  writeJson('packages/cli/package.json', cli);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
  run('git', ['add', 'package.json', 'package-lock.json', 'packages/core/package.json', 'packages/cli/package.json']);
  run('git', [
    'commit',
    '-m',
    `Start ${nextVersion} development after npm publish`,
    '-m',
    `Published gemma-cli and gemma-cli-core, then bumped the workspace to ${nextVersion} so the next publish cannot accidentally reuse the same 0.x.y version.`
  ]);
}

try {
  if (!dryRun) {
    ensureCleanGit();
    ensureNpmAuth();
  }
  const { version, nextVersion } = assertPackageState();
  log(`release version ${version}`);
  log(`next development version ${nextVersion}`);
  const state = publishedState(version);
  assertPublishableState(state, version);
  run('npm', ['run', 'build']);
  run('npm', ['test']);
  packDryRun();

  if (dryRun) {
    log('dry run complete; no packages published and no version bump committed');
    process.exit(0);
  }

  publishPackages(state, version);
  bumpToNextVersion(nextVersion);
  log(`published ${version} and committed ${nextVersion} development bump`);
} catch (error) {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
