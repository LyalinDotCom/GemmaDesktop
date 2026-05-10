#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')

const MODEL_ID = 'Kokoro-82M-v1.0-ONNX'
const MODEL_LABEL = 'Kokoro 82M'
const MODEL_DTYPE = 'q8'
const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const BASE_URL =
  `https://huggingface.co/onnx-community/${MODEL_ID}/resolve/${MODEL_REVISION}`

const ASSET_ROOT = path.resolve(
  __dirname,
  '..',
  '.cache',
  'read-aloud-assets',
  MODEL_ID,
)

const ASSET_FILES = [
  {
    path: 'config.json',
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
    sizeBytes: 44,
  },
  {
    path: 'tokenizer.json',
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
    sizeBytes: 3497,
  },
  {
    path: 'tokenizer_config.json',
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    sizeBytes: 113,
  },
  {
    path: 'onnx/model_quantized.onnx',
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
    sizeBytes: 92361116,
  },
] 

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true })
}

async function hashFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let sizeBytes = 0
    const stream = fs.createReadStream(filePath)

    stream.on('data', (chunk) => {
      hash.update(chunk)
      sizeBytes += chunk.length
    })
    stream.on('error', reject)
    stream.on('end', () => {
      resolve({
        sha256: hash.digest('hex'),
        sizeBytes,
      })
    })
  })
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function verifyExistingFile(targetPath, asset) {
  if (!await pathExists(targetPath)) {
    return false
  }

  const actual = await hashFile(targetPath)
  return actual.sha256 === asset.sha256 && actual.sizeBytes === asset.sizeBytes
}

async function downloadAsset(asset) {
  const url = `${BASE_URL}/${asset.path}`
  const destinationPath = path.join(ASSET_ROOT, asset.path)
  const tempPath = `${destinationPath}.download-${process.pid}`

  await ensureDir(path.dirname(destinationPath))

  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.path}: HTTP ${response.status}`)
  }

  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  const output = fs.createWriteStream(tempPath)
  const source = Readable.fromWeb(response.body)

  await new Promise((resolve, reject) => {
    source.on('data', (chunk) => {
      hash.update(chunk)
      sizeBytes += chunk.length
    })
    source.on('error', reject)
    output.on('error', reject)
    output.on('finish', resolve)
    source.pipe(output)
  })

  const sha256 = hash.digest('hex')
  if (sha256 !== asset.sha256 || sizeBytes !== asset.sizeBytes) {
    await fsp.unlink(tempPath).catch(() => {})
    throw new Error(
      `Downloaded ${asset.path} but verification failed. Expected ${asset.sha256}/${asset.sizeBytes}, received ${sha256}/${sizeBytes}.`,
    )
  }

  await fsp.rename(tempPath, destinationPath)
}

async function writeManifest() {
  const files = ASSET_FILES.map((asset) => ({
    path: asset.path,
    sha256: asset.sha256,
    sizeBytes: asset.sizeBytes,
    url: `${BASE_URL}/${asset.path}`,
  }))
  const bundledBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const manifest = {
    version: 1,
    providerId: 'kokoro-js',
    providerLabel: 'Kokoro',
    modelId: MODEL_ID,
    modelLabel: MODEL_LABEL,
    dtype: MODEL_DTYPE,
    revision: MODEL_REVISION,
    preparedAt: new Date().toISOString(),
    bundledBytes,
    files,
  }

  await fsp.writeFile(
    path.join(ASSET_ROOT, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
}

async function main() {
  await ensureDir(ASSET_ROOT)

  console.log(`Preparing bundled read aloud assets in ${ASSET_ROOT}`)

  for (const asset of ASSET_FILES) {
    const targetPath = path.join(ASSET_ROOT, asset.path)
    const ready = await verifyExistingFile(targetPath, asset)

    if (ready) {
      console.log(`Verified ${asset.path}`)
      continue
    }

    console.log(`Downloading ${asset.path}`)
    await downloadAsset(asset)
    console.log(`Stored ${asset.path}`)
  }

  await writeManifest()
  console.log('Read aloud asset manifest updated.')
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Failed to prepare read aloud assets.',
  )
  process.exit(1)
})
