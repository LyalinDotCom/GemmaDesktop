#!/usr/bin/env node

/**
 * Prepares a clean staging app for electron-builder packaging.
 *
 * The @gemma-desktop/sdk-* packages are linked via file: from the GemmaDesktopSDK monorepo.
 * At runtime, these packages require dependencies that live in the monorepo
 * root's node_modules. Packaging directly from the app repo's node_modules mixes
 * those runtime dependencies with electron-builder's own toolchain dependencies,
 * which can produce an invalid shipped module graph.
 *
 * This script creates a staging app directory with:
 * - built app output
 * - resources and packaged assets
 * - a reconstructed runtime-only node_modules tree that matches Node resolution
 *   from the currently installed workspace
 *
 * Run before electron-builder: node scripts/prepare-pack.js
 */

const fs = require('fs')
const path = require('path')

const appRoot = path.resolve(__dirname, '..')
const stageRoot = path.join(appRoot, '.packaging', 'app')
const stageNodeModules = path.join(stageRoot, 'node_modules')
const stageConfigPath = path.join(stageRoot, 'electron-builder.yml')
const sourceConfigPath = path.join(appRoot, 'electron-builder.yml')
const sourcePackageJsonPath = path.join(appRoot, 'package.json')
const distDir = path.join(appRoot, 'dist')
const {
  resolvePackagedVersion,
} = require('./lib/packagingVersion')

const copiedPackages = []
const copiedPackageKeys = new Set()

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true })
  ensureDir(dirPath)
}

function copyDirectory(sourceDir, destDir) {
  fs.cpSync(sourceDir, destDir, {
    recursive: true,
    dereference: true,
    filter(sourcePath) {
      return path.basename(sourcePath) !== 'node_modules'
    }
  })
}

function packagePathParts(packageName) {
  return packageName.split('/')
}

function resolvePackageManifest(packageName, resolveFromDir) {
  let currentDir = resolveFromDir

  while (true) {
    const manifestPath = path.join(currentDir, 'node_modules', ...packagePathParts(packageName), 'package.json')

    if (fs.existsSync(manifestPath)) {
      return manifestPath
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }

    currentDir = parentDir
  }

  throw new Error(`Could not resolve ${packageName} from ${resolveFromDir}`)
}

function collectRuntimeDependencies(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {})
  ]
}

function copyDeclaredDependencies(packageJson, resolveFromDir, destNodeModulesDir) {
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    copyPackageTree(dependencyName, resolveFromDir, destNodeModulesDir)
  }

  for (const dependencyName of Object.keys(packageJson.optionalDependencies ?? {})) {
    try {
      copyPackageTree(dependencyName, resolveFromDir, destNodeModulesDir)
    } catch (error) {
      console.warn(`Skipping optional dependency ${dependencyName}: ${error.message}`)
    }
  }
}

function copyPackageTree(packageName, resolveFromDir, destNodeModulesDir) {
  const manifestPath = resolvePackageManifest(packageName, resolveFromDir)
  const sourcePackageDir = fs.realpathSync(path.dirname(manifestPath))
  const destPackageDir = path.join(destNodeModulesDir, ...packagePathParts(packageName))
  const visitKey = `${sourcePackageDir}=>${destPackageDir}`

  if (copiedPackageKeys.has(visitKey)) {
    return
  }

  copiedPackageKeys.add(visitKey)
  ensureDir(path.dirname(destPackageDir))
  fs.rmSync(destPackageDir, { recursive: true, force: true })
  copyDirectory(sourcePackageDir, destPackageDir)
  copiedPackages.push({
    packageName,
    sourcePackageDir,
    destPackageDir
  })

  const packageJson = readJson(manifestPath)
  const childNodeModulesDir = path.join(destPackageDir, 'node_modules')

  copyDeclaredDependencies(packageJson, sourcePackageDir, childNodeModulesDir)
}

function writeStagePackageJson(rootPackageJson, options = {}) {
  const electronVersion = readJson(resolvePackageManifest('electron', appRoot)).version
  const packagedVersion = resolvePackagedVersion({
    rootVersion: rootPackageJson.version,
    productName: rootPackageJson.productName,
    distDir,
    incrementInstallerVersion: options.incrementInstallerVersion === true,
  })
  const stagePackageJson = {
    name: rootPackageJson.name,
    productName: rootPackageJson.productName,
    version: packagedVersion,
    private: rootPackageJson.private,
    description: rootPackageJson.description,
    author: rootPackageJson.author,
    main: rootPackageJson.main,
    dependencies: rootPackageJson.dependencies,
    optionalDependencies: rootPackageJson.optionalDependencies,
    devDependencies: {
      electron: electronVersion
    }
  }

  fs.writeFileSync(
    path.join(stageRoot, 'package.json'),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`
  )

  return packagedVersion
}

function writeStageConfig() {
  const sourceConfig = fs.readFileSync(sourceConfigPath, 'utf8')
  const stageConfig = sourceConfig.replace('output: dist', 'output: ../../dist')

  fs.writeFileSync(stageConfigPath, stageConfig)
}

function copyStageAssets() {
  copyDirectory(path.join(appRoot, 'out'), path.join(stageRoot, 'out'))
  copyDirectory(path.join(appRoot, 'resources'), path.join(stageRoot, 'resources'))
  copyDirectory(path.join(appRoot, 'scripts'), path.join(stageRoot, 'scripts'))

  const readAloudAssetsDir = path.join(appRoot, '.cache', 'read-aloud-assets')
  if (fs.existsSync(readAloudAssetsDir)) {
    copyDirectory(readAloudAssetsDir, path.join(stageRoot, '.cache', 'read-aloud-assets'))
  }
}

function main() {
  const rootPackageJson = readJson(sourcePackageJsonPath)
  const incrementInstallerVersion = process.argv.includes('--increment-installer-version')

  resetDir(stageRoot)
  ensureDir(stageNodeModules)

  console.log('Preparing staged app for packaging...')
  copyStageAssets()
  const packagedVersion = writeStagePackageJson(rootPackageJson, {
    incrementInstallerVersion,
  })
  writeStageConfig()

  copyDeclaredDependencies(rootPackageJson, appRoot, stageNodeModules)

  if (packagedVersion !== rootPackageJson.version) {
    console.log(`Installer version: ${rootPackageJson.version} -> ${packagedVersion}`)
  } else {
    console.log(`Installer version: ${packagedVersion}`)
  }
  console.log(`Done. Staged ${copiedPackages.length} runtime packages in ${stageRoot}.`)
}

main()
