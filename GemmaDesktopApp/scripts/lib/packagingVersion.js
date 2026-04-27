const fs = require('fs')
const path = require('path')

function parseNumericVersion(version) {
  const trimmed = String(version ?? '').trim()
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `Unsupported package version "${version}". Use major.minor or major.minor.patch before building installers.`,
    )
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? '0'),
  }
}

function formatNumericVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deriveInstallerVersion(input) {
  const parsedRootVersion = parseNumericVersion(input.rootVersion)
  let nextPatch = parsedRootVersion.patch + 1

  if (input.distDir && fs.existsSync(input.distDir)) {
    const artifactPattern = new RegExp(
      `^${escapeRegex(input.productName)}-(\\d+\\.\\d+\\.\\d+)-.*\\.dmg$`,
    )

    for (const entry of fs.readdirSync(input.distDir)) {
      const match = artifactPattern.exec(entry)
      if (!match) {
        continue
      }

      const parsedArtifactVersion = parseNumericVersion(match[1])
      if (
        parsedArtifactVersion.major !== parsedRootVersion.major
        || parsedArtifactVersion.minor !== parsedRootVersion.minor
      ) {
        continue
      }

      nextPatch = Math.max(nextPatch, parsedArtifactVersion.patch + 1)
    }
  }

  return formatNumericVersion({
    major: parsedRootVersion.major,
    minor: parsedRootVersion.minor,
    patch: nextPatch,
  })
}

function resolvePackagedVersion(input) {
  if (!input.incrementInstallerVersion) {
    return formatNumericVersion(parseNumericVersion(input.rootVersion))
  }

  return deriveInstallerVersion(input)
}

module.exports = {
  deriveInstallerVersion,
  formatNumericVersion,
  parseNumericVersion,
  resolvePackagedVersion,
}
