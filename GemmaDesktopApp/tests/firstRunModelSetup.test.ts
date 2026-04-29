import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FirstRunModelSetup } from '../src/renderer/src/components/FirstRunModelSetup'
import type { ModelSummary, RuntimeSummary } from '../src/renderer/src/types'

const runtimes: RuntimeSummary[] = [
  {
    id: 'ollama-native',
    name: 'Ollama',
    status: 'running',
  },
  {
    id: 'omlx-openai',
    name: 'oMLX',
    status: 'stopped',
  },
]

const models: ModelSummary[] = [
  {
    id: 'gemma4:26b',
    name: 'Gemma 4 26B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    status: 'available',
  },
]

describe('FirstRunModelSetup', () => {
  it('asks users to choose a provider before downloading anything', () => {
    const markup = renderToStaticMarkup(
      createElement(FirstRunModelSetup, {
        runtimes,
        models,
        gemmaInstallStates: [],
        onChoose: () => {},
        onDismiss: () => {},
        onEnsureGemmaModel: async () => {},
      }),
    )

    expect(markup).toContain('Choose how Gemma Desktop should run models')
    expect(markup).toContain('Nothing will be downloaded until you ask for it.')
    expect(markup).toContain('Ollama')
    expect(markup).toContain('oMLX')
    expect(markup).toContain('LM Studio')
    expect(markup).toContain('Gemma 4 26B')
    expect(markup).toContain('Optional guided Gemma downloads')
    expect(markup).toContain('Decide Later')
  })
})
