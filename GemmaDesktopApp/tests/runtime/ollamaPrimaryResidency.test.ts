import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ipcSourcePath = path.resolve(process.cwd(), 'src/main/ipc.ts')

describe('Ollama primary residency tracking', () => {
  it('does not treat a managed profile mismatch as a missing resident model', () => {
    const ipcSource = fs.readFileSync(ipcSourcePath, 'utf8')
    const residencyCheck = ipcSource.match(
      /async function isTrackedModelTargetResident[\s\S]*?\n}\n\nasync function ensurePrimaryModelTargetLoadedUnlocked/,
    )?.[0]

    expect(residencyCheck).toBeDefined()
    expect(residencyCheck).toContain('return true')
    expect(residencyCheck).not.toContain('context that does not match the managed profile; reloading it')
    expect(residencyCheck).not.toContain('ollamaLoadedConfigMatchesManagedProfile')
  })

  it('does not reload an already-resident selected Ollama model just to correct context metadata', () => {
    const ipcSource = fs.readFileSync(ipcSourcePath, 'utf8')
    const ollamaLoadPath = ipcSource.match(
      /if \(target\.runtimeId === 'ollama-native' \|\| target\.runtimeId === 'ollama-openai'\) \{[\s\S]*?\n  \}\n\n  if \(isLmStudioModelRuntime/,
    )?.[0]

    expect(ollamaLoadPath).toBeDefined()
    expect(ollamaLoadPath).toContain('if (loadedModel) {')
    expect(ollamaLoadPath).toContain('message: \'Selected model is already loaded.\'')
    expect(ollamaLoadPath).not.toContain('Model is already loaded with the managed profile.')
    expect(ollamaLoadPath).not.toContain('await unloadOllamaModel(')
  })
})
