import { describe, expect, it } from 'vitest'
import {
  createConfiguredRuntimeAdapters,
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

describe('desktop runtime adapter mapping', () => {
  it('creates configured runtime adapters in desktop priority order', () => {
    const adapters = createConfiguredRuntimeAdapters(settings())

    expect(adapters.map((adapter) => adapter.identity.id)).toEqual([
      'ollama-native',
      'ollama-openai',
      'lmstudio-native',
      'lmstudio-openai',
      'llamacpp-server',
      'omlx-openai',
    ])
    expect(adapters.map((adapter) => adapter.identity.endpoint)).toEqual([
      'http://localhost:11435',
      'http://localhost:11435/v1',
      'http://localhost:1235',
      'http://localhost:1235/v1',
      'http://localhost:8081',
      'http://localhost:8001/v1',
    ])
  })
})
