import { describe, expect, it } from 'vitest'
import {
  createConfiguredRuntimeAdapters,
  createConfiguredRuntimeProviders,
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
    ])
    expect(adapters.map((adapter) => adapter.identity.endpoint)).toEqual([
      'http://localhost:11435/v1',
      'http://localhost:11435',
      'http://localhost:1235/v1',
      'http://localhost:1235',
      'http://localhost:8081',
      'http://localhost:8001/v1',
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
    ])
    expect(providers.modelDiscoveryProviders.map((provider) => provider.identity.id)).toEqual([
      'ollama-openai',
      'lmstudio-openai',
      'llamacpp-server',
      'omlx-openai',
    ])
  })
})
