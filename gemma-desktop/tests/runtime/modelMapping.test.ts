import { describe, expect, it } from 'vitest'
import {
  createConfiguredRuntimeAdapters,
  createConfiguredRuntimeProviders,
  mapModels,
  type RuntimeAdapterSettings,
} from '../../src/main/modelMapping'

function settings(): RuntimeAdapterSettings {
  return {
    runtimes: {
      ollama: { endpoint: 'http://localhost:11435' },
      lmstudio: { endpoint: 'http://localhost:1235' },
      llamacpp: { endpoint: 'http://localhost:8081' },
      omlx: { endpoint: 'http://localhost:8001', apiKey: 'test-key' },
    },
  }
}

describe('desktop runtime provider mapping', () => {
  it('keeps the legacy runtime adapter helper in desktop inference priority order', () => {
    const adapters = createConfiguredRuntimeAdapters(settings())

    expect(adapters.map((adapter) => adapter.identity.id)).toEqual([
      'ollama-openai',
      'ollama-native',
      'lmstudio-openai',
      'lmstudio-native',
      'llamacpp-server',
      'omlx-openai',
      'gemini-api',
    ])
    expect(adapters.map((adapter) => adapter.identity.endpoint)).toEqual([
      'http://localhost:11435/v1',
      'http://localhost:11435',
      'http://localhost:1235/v1',
      'http://localhost:1235',
      'http://localhost:8081',
      'http://localhost:8001/v1',
      'https://generativelanguage.googleapis.com/v1beta',
    ])
  })

  it('uses separate model discovery providers for inventory', () => {
    const providers = createConfiguredRuntimeProviders(settings())

    expect(providers.inferenceAdapters.map((adapter) => adapter.identity.id)).toEqual([
      'ollama-openai',
      'ollama-native',
      'lmstudio-openai',
      'lmstudio-native',
      'llamacpp-server',
      'omlx-openai',
      'gemini-api',
    ])
    expect(providers.modelDiscoveryProviders.map((provider) => provider.identity.id)).toEqual([
      'ollama-openai',
      'lmstudio-openai',
      'llamacpp-server',
      'omlx-openai',
      'gemini-api',
    ])
  })

  it('maps hosted Gemini multimodal capabilities into desktop attachment support', () => {
    const models = mapModels([
      {
        runtime: {
          id: 'gemini-api',
          displayName: 'Gemini API',
        },
        loadedInstances: [],
        models: [
          {
            id: 'gemini-3.5-flash',
            runtimeId: 'gemini-api',
            kind: 'llm',
            metadata: {
              displayName: 'Gemini 3.5 Flash',
              inputTokenLimit: 1_048_576,
              maxContextLength: 1_048_576,
            },
            capabilities: [
              { id: 'inference.chat', status: 'supported' },
              { id: 'model.input.image', status: 'supported' },
              { id: 'model.input.audio', status: 'supported' },
              { id: 'model.input.video', status: 'supported' },
              { id: 'model.input.pdf', status: 'supported' },
            ],
          },
        ],
      },
    ], null, [])

    expect(models[0]).toMatchObject({
      id: 'gemini-3.5-flash',
      runtimeId: 'gemini-api',
      contextLength: 1_048_576,
      attachmentSupport: {
        image: true,
        audio: true,
        video: true,
      },
    })
  })
})
