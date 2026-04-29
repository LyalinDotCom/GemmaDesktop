import { describe, expect, it } from 'vitest'
import {
  askGeminiCli,
  ASK_GEMINI_DEFAULT_MODEL,
  ASK_GEMINI_EXECUTABLE,
} from '../src/main/geminiCli'

type MockExecFile = (
  file: string,
  args: string[],
  options: {
    cwd?: string
    timeout?: number
    maxBuffer?: number
  },
  callback: (
    error: (Error & {
      code?: number | string
      signal?: NodeJS.Signals | string | null
      killed?: boolean
      stdout?: string
      stderr?: string
    }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void

describe('askGeminiCli', () => {
  it('returns a structured success result from Gemini JSON output', async () => {
    let seenFile = ''
    let seenArgs: string[] = []

    const execFile: MockExecFile = (file, args, options, callback) => {
      seenFile = file
      seenArgs = args
      expect(options.cwd).toBe('/tmp/project')
      callback(
        null,
        JSON.stringify({
          session_id: 'session-1',
          response: 'Concrete answer from Gemini.',
          stats: {
            models: {
              [ASK_GEMINI_DEFAULT_MODEL]: {
                api: { totalRequests: 1 },
              },
            },
          },
        }),
        'Loaded cached credentials.\n',
      )
    }

    const result = await askGeminiCli(
      {
        question: 'How should I structure this refactor?',
        workingDirectory: '/tmp/project',
      },
      {
        execFile,
        now: (() => {
          let value = 100
          return () => {
            value += 25
            return value
          }
        })(),
      },
    )

    expect(seenFile).toBe(ASK_GEMINI_EXECUTABLE)
    expect(seenArgs).toContain('--output-format')
    expect(seenArgs).toContain('json')
    expect(seenArgs).toContain('--approval-mode')
    expect(seenArgs).toContain('plan')
    expect(seenArgs).toContain('--model')
    expect(seenArgs).toContain(ASK_GEMINI_DEFAULT_MODEL)
    expect(result).toMatchObject({
      ok: true,
      model: ASK_GEMINI_DEFAULT_MODEL,
      response: 'Concrete answer from Gemini.',
      sessionId: 'session-1',
    })
    if (result.ok) {
      expect(result.warnings).toContain('Gemini CLI used cached credentials.')
    }
  })

  it('passes YOLO approval mode through to Gemini CLI when requested', async () => {
    let seenArgs: string[] = []

    const execFile: MockExecFile = (_file, args, _options, callback) => {
      seenArgs = args
      callback(null, JSON.stringify({ response: 'YOLO answer.' }), '')
    }

    const result = await askGeminiCli(
      {
        question: 'Can you inspect and suggest?',
        workingDirectory: '/tmp/project',
        approvalMode: 'yolo',
      },
      { execFile },
    )

    expect(seenArgs).toContain('--approval-mode')
    expect(seenArgs).toContain('yolo')
    expect(result).toMatchObject({
      ok: true,
      response: 'YOLO answer.',
    })
  })

  it('treats missing gemini binary as a soft failure', async () => {
    const error = Object.assign(new Error('spawn gemini ENOENT'), {
      code: 'ENOENT',
    })

    const execFile: MockExecFile = (_file, _args, _options, callback) => {
      callback(error, '', '')
    }

    const result = await askGeminiCli(
      {
        question: 'Need help',
        workingDirectory: '/tmp/project',
      },
      { execFile },
    )

    expect(result).toMatchObject({
      ok: false,
      errorKind: 'missing_binary',
      retryable: false,
    })
  })

  it('retries Gemini with the login shell resolved executable when the app PATH cannot find it', async () => {
    const missingError = Object.assign(new Error('spawn gemini ENOENT'), {
      code: 'ENOENT',
    })
    const calls: Array<{ file: string; args: string[] }> = []
    const resolvedExecutable = '/Users/example/.nvm/versions/node/v24.14.1/bin/gemini'

    const execFile: MockExecFile = (file, args, _options, callback) => {
      calls.push({ file, args })

      if (calls.length === 1) {
        callback(missingError, '', '')
        return
      }

      if (calls.length === 2) {
        callback(null, `${resolvedExecutable}\n`, '')
        return
      }

      callback(
        null,
        JSON.stringify({
          response: 'Resolved Gemini answered.',
        }),
        '',
      )
    }

    const result = await askGeminiCli(
      {
        question: 'Need help',
        workingDirectory: '/tmp/project',
      },
      { execFile },
    )

    expect(calls[0]?.file).toBe(ASK_GEMINI_EXECUTABLE)
    expect(calls[1]?.args).toEqual(['-lic', `command -v ${ASK_GEMINI_EXECUTABLE}`])
    expect(calls[2]?.file).toBe(resolvedExecutable)
    expect(result).toMatchObject({
      ok: true,
      response: 'Resolved Gemini answered.',
    })
  })

  it('treats timeout as a retryable soft failure', async () => {
    const error = Object.assign(new Error('Command timed out'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      killed: true,
    })

    const execFile: MockExecFile = (_file, _args, _options, callback) => {
      callback(error, '', 'Attempt 1 failed with status 429.')
    }

    const result = await askGeminiCli(
      {
        question: 'Need help',
        workingDirectory: '/tmp/project',
      },
      { execFile },
    )

    expect(result).toMatchObject({
      ok: false,
      errorKind: 'timeout',
      retryable: true,
    })
  })

  it('classifies capacity exhaustion even when the CLI exits successfully without a response', async () => {
    const execFile: MockExecFile = (_file, _args, _options, callback) => {
      callback(
        null,
        '',
        `Attempt 1 failed with status 429. No capacity available for model ${ASK_GEMINI_DEFAULT_MODEL} on the server.`,
      )
    }

    const result = await askGeminiCli(
      {
        question: 'Need help',
        workingDirectory: '/tmp/project',
      },
      { execFile },
    )

    expect(result).toMatchObject({
      ok: false,
      errorKind: 'capacity_exhausted',
      retryable: true,
    })
  })

  it('returns a soft failure when stdout is not valid JSON', async () => {
    const execFile: MockExecFile = (_file, _args, _options, callback) => {
      callback(null, 'not-json', '')
    }

    const result = await askGeminiCli(
      {
        question: 'Need help',
        workingDirectory: '/tmp/project',
      },
      { execFile },
    )

    expect(result).toMatchObject({
      ok: false,
      errorKind: 'invalid_json',
      retryable: true,
    })
  })
})
