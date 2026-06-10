#!/usr/bin/env node
// Bump gemma-cli to the next publishable patch version, build it with the SDK
// inlined, then publish.
//
// @gemma-sdk/agent is workspace-private. The CLI's build.mjs bundles its code
// into dist/, so the published tarball has zero reference to the SDK package
// and installs cleanly from the registry.
//
// Usage:
//   node scripts/release.mjs --dry-run    # build + pack, do not publish
//   node scripts/release.mjs              # build + publish

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const releaseRoot = resolve(here, '..')
const repoRoot = resolve(here, '..', '..')
const cliDir = resolve(here, '..', 'packages', 'cli')
const workspacePackagePath = join(releaseRoot, 'package.json')
const cliPackagePath = join(cliDir, 'package.json')
const rootLockfilePath = join(repoRoot, 'package-lock.json')

const dryRun = process.argv.includes('--dry-run')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    console.error(`[release] command failed: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: version.includes('-'),
  }
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0
  }

  return left.prerelease ? -1 : 1
}

function incrementPatch(version) {
  const parsed = parseVersion(version)
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

function maxVersion(versions) {
  return versions.reduce(
    (max, version) => (!max || compareVersions(version, max) > 0 ? version : max),
    undefined
  )
}

function publishedVersions(packageName) {
  const result = spawnSync('npm', ['view', packageName, 'versions', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (output.includes('E404') || output.includes('404 Not Found')) {
      return []
    }

    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
    console.error(`[release] command failed: npm view ${packageName} versions --json`)
    process.exit(result.status ?? 1)
  }

  const parsed = JSON.parse(result.stdout || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

function syncVersion(version) {
  const workspacePackage = readJson(workspacePackagePath)
  const cliPackage = readJson(cliPackagePath)

  workspacePackage.version = version
  cliPackage.version = version

  writeJson(workspacePackagePath, workspacePackage)
  writeJson(cliPackagePath, cliPackage)

  if (existsSync(rootLockfilePath)) {
    const lockfile = readJson(rootLockfilePath)
    const cliLockEntry = lockfile.packages?.['gemma-cli/packages/cli']

    if (cliLockEntry) {
      cliLockEntry.version = version
      writeJson(rootLockfilePath, lockfile)
    }
  }
}

function nextPublishVersion(pkg) {
  const latestPublished = maxVersion(publishedVersions(pkg.name))
  if (!latestPublished) {
    return { version: pkg.version, latestPublished }
  }

  if (compareVersions(pkg.version, latestPublished) <= 0) {
    return { version: incrementPatch(latestPublished), latestPublished }
  }

  return { version: pkg.version, latestPublished }
}

let pkg = readJson(cliPackagePath)
const plannedVersion = nextPublishVersion(pkg)

if (dryRun && plannedVersion.version !== pkg.version) {
  console.log(
    `[release] latest published ${pkg.name} is ${plannedVersion.latestPublished}; publish would bump ${pkg.version} -> ${plannedVersion.version}`
  )
} else if (!dryRun && plannedVersion.version !== pkg.version) {
  console.log(
    `[release] latest published ${pkg.name} is ${plannedVersion.latestPublished}; bumping ${pkg.version} -> ${plannedVersion.version}`
  )
  syncVersion(plannedVersion.version)
  pkg = readJson(cliPackagePath)
}

const dryRunTarget =
  dryRun && plannedVersion.version !== pkg.version ? `; publish target ${plannedVersion.version}` : ''
console.log(`[release] preparing ${pkg.name}@${pkg.version}${dryRun ? ` (dry run${dryRunTarget})` : ''}`)

if (pkg.dependencies && Object.keys(pkg.dependencies).some((name) => name.startsWith('@gemma-sdk/'))) {
  console.error('[release] @gemma-sdk/* must not appear in published dependencies — it is workspace-private and must be bundled.')
  process.exit(1)
}

console.log('[release] building SDK + bundling CLI')
run('npm', ['run', 'build:gemma-cli'], { cwd: repoRoot })

if (!existsSync(join(cliDir, 'dist', 'index.js'))) {
  console.error('[release] expected dist/index.js after build')
  process.exit(1)
}

if (dryRun) {
  console.log('[release] dry run: packing without publishing')
  run('npm', ['pack', '--dry-run'], { cwd: cliDir })
  console.log('[release] done (dry run)')
  process.exit(0)
}

console.log('[release] publishing to npm')
run('npm', ['publish', '--access', 'public'], { cwd: cliDir })
console.log(`[release] published ${pkg.name}@${pkg.version}`)
