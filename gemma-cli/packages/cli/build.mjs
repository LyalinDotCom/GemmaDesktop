// Bundles the CLI into a self-contained dist/.
//
// @gemma-sdk/agent is workspace-private and gets inlined here so the published
// gemma-cli package has zero reference to it. Anything declared in this
// package's runtime `dependencies` stays external — those are the only modules
// npm installs alongside gemma-cli at consume time.

import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

const external = Object.keys(pkg.dependencies ?? {})

rmSync(join(here, 'dist'), { recursive: true, force: true })

// Some bundled deps may still call require() internally; ESM has no global
// require, so shim it from import.meta.url.
const requireShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  jsx: 'automatic',
  outdir: join(here, 'dist'),
  logLevel: 'info',
  legalComments: 'none',
  sourcemap: false,
  treeShaking: true,
}

// src/index.ts already carries `#!/usr/bin/env node`; esbuild lifts source
// shebangs to the top of the output for us, so don't duplicate it in the banner.
await build({
  ...common,
  entryPoints: [join(here, 'src/index.ts')],
  banner: { js: requireShim },
})

await build({
  ...common,
  entryPoints: [join(here, 'src/tuiSnapshot.ts')],
  banner: { js: requireShim },
})
