import { describe, expect, it } from 'vitest'
import {
  readStartupSessionFlag,
  writeStartupSessionFlag,
} from '../../src/renderer/src/lib/startupSessionState'

class MemoryStorage implements Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const brokenStorage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('session storage unavailable')
  },
  removeItem: () => {
    throw new Error('session storage unavailable')
  },
  setItem: () => {
    throw new Error('session storage unavailable')
  },
}

describe('startup session state', () => {
  it('keeps startup acknowledgements for the current browser session only', () => {
    const storage = new MemoryStorage()

    expect(readStartupSessionFlag('startupRiskAccepted', storage)).toBe(false)
    expect(readStartupSessionFlag('startupOverlayDismissed', storage)).toBe(false)

    writeStartupSessionFlag('startupRiskAccepted', true, storage)
    writeStartupSessionFlag('startupOverlayDismissed', true, storage)

    expect(readStartupSessionFlag('startupRiskAccepted', storage)).toBe(true)
    expect(readStartupSessionFlag('startupOverlayDismissed', storage)).toBe(true)

    writeStartupSessionFlag('startupOverlayDismissed', false, storage)

    expect(readStartupSessionFlag('startupRiskAccepted', storage)).toBe(true)
    expect(readStartupSessionFlag('startupOverlayDismissed', storage)).toBe(false)
  })

  it('treats storage failures as a non-blocking startup convenience failure', () => {
    expect(readStartupSessionFlag('startupRiskAccepted', brokenStorage)).toBe(false)
    expect(() =>
      writeStartupSessionFlag('startupRiskAccepted', true, brokenStorage),
    ).not.toThrow()
  })
})
