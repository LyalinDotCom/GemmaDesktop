import { describe, expect, it } from 'vitest'
import {
  describeOllamaServerConfigDrift,
  ollamaKeepAliveDurationsMatch,
  resolveExpectedOllamaServerKeepAlive,
  resolveOllamaRequestKeepAlive,
} from '../src/shared/ollamaServerConfig'

describe('Ollama server config helpers', () => {
  it('keeps app request keep-alive enabled by default', () => {
    expect(resolveOllamaRequestKeepAlive({})).toBe('24h')
    expect(resolveExpectedOllamaServerKeepAlive({})).toBe('24h')
  })

  it('falls back to Ollama default keep-alive when disabled', () => {
    expect(resolveOllamaRequestKeepAlive({ keepAliveEnabled: false })).toBeUndefined()
    expect(resolveExpectedOllamaServerKeepAlive({ keepAliveEnabled: false })).toBe('5m')
  })

  it('normalizes equivalent Ollama duration strings', () => {
    expect(ollamaKeepAliveDurationsMatch('5m0s', '5m')).toBe(true)
    expect(ollamaKeepAliveDurationsMatch('24h0m0s', '24h')).toBe(true)
  })

  it('describes server config drift from app settings', () => {
    expect(describeOllamaServerConfigDrift(
      {
        numParallel: 1,
        maxLoadedModels: 0,
        keepAlive: '5m0s',
      },
      {
        numParallel: 2,
        maxLoadedModels: 2,
        keepAliveEnabled: true,
      },
    )).toEqual([
      expect.objectContaining({ key: 'numParallel', expected: '2', actual: '1' }),
      expect.objectContaining({ key: 'maxLoadedModels', expected: '2', actual: '0' }),
      expect.objectContaining({ key: 'keepAlive', expected: '24h', actual: '5m0s' }),
    ])
  })
})
