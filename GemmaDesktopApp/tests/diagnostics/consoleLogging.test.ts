import { describe, expect, it } from 'vitest'
import {
  buildTimestampedConsoleArgs,
  formatErrorForConsole,
} from '../../src/main/consoleLogging'

describe('console logging helpers', () => {
  it('prefixes console output with an ISO timestamp', () => {
    const args = buildTimestampedConsoleArgs(
      ['hello'],
      new Date('2026-04-16T17:00:00.000Z'),
    )

    expect(args).toEqual([
      '[2026-04-16T17:00:00.000Z]',
      'hello',
    ])
  })

  it('formats nested error causes and metadata for console output', () => {
    const cause = new Error('Body Timeout Error') as Error & { code?: string }
    cause.name = 'BodyTimeoutError'
    cause.code = 'UND_ERR_BODY_TIMEOUT'

    const error = new TypeError('terminated') as TypeError & {
      cause?: unknown
      code?: string
    }
    error.cause = cause
    error.code = 'UND_ERR_ABORTED'

    const text = formatErrorForConsole(error)

    expect(text).toContain('TypeError: terminated')
    expect(text).toContain('code=UND_ERR_ABORTED')
    expect(text).toContain('cause:')
    expect(text).toContain('BodyTimeoutError: Body Timeout Error')
    expect(text).toContain('code=UND_ERR_BODY_TIMEOUT')
  })
})
