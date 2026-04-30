import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  StartupLoadingOverlay,
  resolveStartupTasks,
  shouldShowStartupOverlay,
} from '../src/renderer/src/components/StartupLoadingOverlay'
import type { BootstrapState } from '../src/renderer/src/types'
import type { ReadAloudInspection } from '../src/shared/readAloud'

const BASE_BOOTSTRAP: BootstrapState = {
  status: 'loading_helper',
  ready: false,
  message: 'Loading helper model gemma4:e2b…',
  helperModelId: 'gemma4:e2b',
  helperRuntimeId: 'ollama-native',
  requiredPrimaryModelIds: ['gemma4:26b'],
  modelAvailabilityIssues: [],
  updatedAt: 0,
}

const READY_BOOTSTRAP: BootstrapState = {
  ...BASE_BOOTSTRAP,
  status: 'ready',
  ready: true,
  message: 'Helper model ready.',
}

const READ_ALOUD_INSTALLING: ReadAloudInspection = {
  supported: true,
  enabled: true,
  provider: 'kokoro-js',
  providerLabel: 'Kokoro',
  model: 'Kokoro-82M-v1.0-ONNX',
  modelLabel: 'Kokoro 82M v1.0',
  dtype: 'q8',
  backend: 'cpu',
  state: 'installing',
  healthy: false,
  busy: true,
  detail: 'Downloading Kokoro assets…',
  lastError: null,
  assetRoot: null,
  cacheDir: null,
  bundledBytes: null,
  installProgress: null,
  checkedAt: new Date(0).toISOString(),
}

const READ_ALOUD_READY: ReadAloudInspection = {
  ...READ_ALOUD_INSTALLING,
  state: 'ready',
  healthy: true,
  busy: false,
  detail: 'Kokoro ready.',
}

describe('StartupLoadingOverlay', () => {
  it('renders the overlay while bootstrap is still loading', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: BASE_BOOTSTRAP,
        readAloudEnabled: false,
        readAloudStatus: null,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('data-testid="startup-loading-overlay"')
    expect(markup).toContain('Getting Gemma Desktop ready')
    expect(markup).toContain('Loading helper model gemma4:e2b')
    expect(markup).toContain('0 of 1 ready')
    expect(markup).toContain('data-testid="startup-task-bootstrap"')
    expect(markup).toContain('data-task-status="in-progress"')
  })

  it('includes a dismiss control and is not aria-modal (non-blocking)', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: BASE_BOOTSTRAP,
        readAloudEnabled: false,
        readAloudStatus: null,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Dismiss"')
    expect(markup).toContain('aria-modal="false"')
    expect(markup).toContain('pointer-events-none')
    expect(markup).toContain('pointer-events-auto')
  })

  it('shows combined counter with bootstrap ready and read aloud still loading', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: READY_BOOTSTRAP,
        readAloudEnabled: true,
        readAloudStatus: READ_ALOUD_INSTALLING,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('1 of 2 ready')
    expect(markup).toContain('data-testid="startup-task-read-aloud"')
    expect(markup).toContain('Downloading Kokoro assets')
  })

  it('hides when dismissed', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: BASE_BOOTSTRAP,
        readAloudEnabled: true,
        readAloudStatus: READ_ALOUD_INSTALLING,
        dismissed: true,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toBe('')
  })

  it('hides when all tracked tasks are ready', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: READY_BOOTSTRAP,
        readAloudEnabled: true,
        readAloudStatus: READ_ALOUD_READY,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toBe('')
  })

  it('shows an error heading and retry button when bootstrap errored', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: {
          ...BASE_BOOTSTRAP,
          status: 'error',
          error: 'Ollama is unreachable',
        },
        readAloudEnabled: false,
        readAloudStatus: null,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('Gemma Desktop ran into an issue')
    expect(markup).toContain('Try again')
    expect(markup).toContain('Ollama is unreachable')
    expect(markup).toContain('data-task-status="error"')
  })

  it('shows a non-blocking warning when a saved runtime target is offline', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: {
          ...READY_BOOTSTRAP,
          status: 'warning',
          message: 'LM Studio is offline, so Gemma Desktop skipped warming qwen3:8b.',
        },
        readAloudEnabled: false,
        readAloudStatus: null,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('Gemma Desktop needs attention')
    expect(markup).toContain('LM Studio is offline')
    expect(markup).toContain('1 of 1 checked')
    expect(markup).toContain('Try again')
    expect(markup).toContain('data-task-status="warning"')
  })

  it('shows a clear startup warning when a selected primary model cannot load', () => {
    const message =
      'oMLX could not load gemma-4-26b-a4b-it-nvfp4. Reason: Model not loaded: gemma-4-26b-a4b-it-nvfp4. Chats using omlx-openai / gemma-4-26b-a4b-it-nvfp4 are paused until you switch them to another model or restart after the model is available.'
    const markup = renderToStaticMarkup(
      createElement(StartupLoadingOverlay, {
        bootstrap: {
          ...READY_BOOTSTRAP,
          status: 'warning',
          message,
          modelAvailabilityIssues: [{
            modelId: 'gemma-4-26b-a4b-it-nvfp4',
            runtimeId: 'omlx-openai',
            message,
            detectedAt: 1,
            source: 'startup',
          }],
        },
        readAloudEnabled: false,
        readAloudStatus: null,
        dismissed: false,
        onDismiss: () => {},
        onRetryBootstrap: () => {},
      }),
    )

    expect(markup).toContain('Gemma Desktop needs attention')
    expect(markup).toContain('oMLX could not load gemma-4-26b-a4b-it-nvfp4')
    expect(markup).toContain('Chats using omlx-openai / gemma-4-26b-a4b-it-nvfp4 are paused')
    expect(markup).toContain('whitespace-normal break-words')
    expect(markup).toContain('data-task-status="warning"')
  })
})

describe('resolveStartupTasks / shouldShowStartupOverlay', () => {
  it('omits read aloud when disabled', () => {
    const tasks = resolveStartupTasks({
      bootstrap: BASE_BOOTSTRAP,
      readAloudEnabled: false,
      readAloudStatus: READ_ALOUD_INSTALLING,
    })
    expect(tasks.map((t) => t.id)).toEqual(['bootstrap'])
  })

  it('includes read aloud when enabled with an inspection', () => {
    const tasks = resolveStartupTasks({
      bootstrap: BASE_BOOTSTRAP,
      readAloudEnabled: true,
      readAloudStatus: READ_ALOUD_INSTALLING,
    })
    expect(tasks.map((t) => t.id)).toEqual(['bootstrap', 'read-aloud'])
  })

  it('returns false from shouldShowStartupOverlay when everything is ready', () => {
    const tasks = resolveStartupTasks({
      bootstrap: READY_BOOTSTRAP,
      readAloudEnabled: true,
      readAloudStatus: READ_ALOUD_READY,
    })
    expect(shouldShowStartupOverlay(tasks)).toBe(false)
  })

  it('returns true when any task is still in progress', () => {
    const tasks = resolveStartupTasks({
      bootstrap: READY_BOOTSTRAP,
      readAloudEnabled: true,
      readAloudStatus: READ_ALOUD_INSTALLING,
    })
    expect(shouldShowStartupOverlay(tasks)).toBe(true)
  })

  it('returns true for warning tasks so users can see offline provider state', () => {
    const tasks = resolveStartupTasks({
      bootstrap: {
        ...READY_BOOTSTRAP,
        status: 'warning',
        message: 'Ollama is offline.',
      },
      readAloudEnabled: false,
      readAloudStatus: null,
    })

    expect(shouldShowStartupOverlay(tasks)).toBe(true)
  })
})
