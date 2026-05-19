#!/usr/bin/env node
// Build gemma-cli with the SDK inlined, then publish.
//
// @gemma-sdk/agent is workspace-private. The CLI's build.mjs bundles its code
// into dist/, so the published tarball has zero reference to the SDK package
// and installs cleanly from the registry.
//
// Usage:
//   node scripts/release.mjs --dry-run    # build + pack, do not publish
//   node scripts/release.mjs              # build + publish

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const cliDir = resolve(here, '..', 'packages', 'cli')

const dryRun = process.argv.includes('--dry-run')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    console.error(`[release] command failed: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))
console.log(`[release] preparing ${pkg.name}@${pkg.version}${dryRun ? ' (dry run)' : ''}`)

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
