import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveInstallerVersion, resolvePackagedVersion } from '../scripts/lib/packagingVersion'

const tempDirs: string[] = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemma-desktop-packaging-version-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

describe('resolvePackagedVersion', () => {
  it('normalizes the root version when installer auto-increment is disabled', () => {
    expect(resolvePackagedVersion({
      rootVersion: '0.1',
      productName: 'Gemma Desktop',
      distDir: '/does/not/matter',
      incrementInstallerVersion: false,
    })).toBe('0.1.0')
  })

  it('starts installer builds at the next patch version', () => {
    expect(resolvePackagedVersion({
      rootVersion: '0.1',
      productName: 'Gemma Desktop',
      distDir: '/does/not/matter',
      incrementInstallerVersion: true,
    })).toBe('0.1.1')
  })
})

describe('deriveInstallerVersion', () => {
  it('bumps beyond the highest existing dmg patch for the same major.minor line', () => {
    const distDir = createTempDir()
    fs.writeFileSync(path.join(distDir, 'Gemma Desktop-0.1.0-arm64.dmg'), '')
    fs.writeFileSync(path.join(distDir, 'Gemma Desktop-0.1.3-arm64.dmg'), '')
    fs.writeFileSync(path.join(distDir, 'Gemma Desktop-0.2.7-arm64.dmg'), '')

    expect(deriveInstallerVersion({
      rootVersion: '0.1.0',
      productName: 'Gemma Desktop',
      distDir,
    })).toBe('0.1.4')
  })

  it('supports a manually nudged base version by starting from its next patch', () => {
    const distDir = createTempDir()
    fs.writeFileSync(path.join(distDir, 'Gemma Desktop-0.6.2-arm64.dmg'), '')

    expect(deriveInstallerVersion({
      rootVersion: '0.7.0',
      productName: 'Gemma Desktop',
      distDir,
    })).toBe('0.7.1')
  })
})
