import { describe, expect, it } from 'vitest'
import type {
  EnvironmentInspectionResult,
  RuntimeInspectionResult,
} from '@gemma-desktop/sdk-core'
import {
  buildDoctorReport,
  collectDoctorCommandChecks,
} from '../../src/main/doctor'
import { getDefaultLmStudioSettings } from '../../src/shared/lmstudioRuntimeConfig'
import { getDefaultOllamaSettings } from '../../src/shared/ollamaRuntimeConfig'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '../../src/shared/sessionModelDefaults'
import type { SpeechInspection } from '../../src/shared/speech'
import type { ReadAloudInspection } from '../../src/shared/readAloud'

function makeRuntime(
  input: Partial<RuntimeInspectionResult> & Pick<RuntimeInspectionResult, 'runtime'>,
): RuntimeInspectionResult {
  return {
    installed: false,
    reachable: false,
    healthy: false,
    version: undefined,
    capabilities: [],
    models: [],
    loadedInstances: [],
    warnings: [],
    diagnosis: [],
    ...input,
  }
}

function makeEnvironment(
  runtimes: RuntimeInspectionResult[],
): EnvironmentInspectionResult {
  return {
    inspectedAt: '2026-04-06T15:04:22.381Z',
    machine: {
      platform: 'darwin',
      release: '24.4.0',
      arch: 'arm64',
      totalMemoryBytes: 64 * 1024 * 1024 * 1024,
      cpuModel: 'Apple M4 Pro',
      cpuCount: 12,
      hostname: 'gemma-desktop-dev',
    },
    runtimes,
    warnings: [],
    diagnosis: [],
  }
}

function makeSettings(input?: Partial<{
  enabled: boolean
  state: 'idle' | 'ready' | 'error'
  message: string
  checkedAt: number
  readAloudEnabled: boolean
  maxLoadedModels: number
  numParallel: number
  keepAliveEnabled: boolean
}>): {
  modelSelection: typeof DEFAULT_MODEL_SELECTION_SETTINGS
  ollama: ReturnType<typeof getDefaultOllamaSettings>
  lmstudio: ReturnType<typeof getDefaultLmStudioSettings>
  runtimes: {
    ollama: {
      numParallel: number
      maxLoadedModels: number
      keepAliveEnabled: boolean
    }
  }
  readAloud: {
    enabled: boolean
  }
  tools: {
    chromeMcp: {
      enabled: boolean
      lastStatus?: {
        state: 'idle' | 'ready' | 'error'
        message: string
        checkedAt: number
      }
    }
  }
} {
  return {
    modelSelection: {
      mainModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.mainModel },
      helperModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.helperModel },
      helperModelEnabled: DEFAULT_MODEL_SELECTION_SETTINGS.helperModelEnabled,
    },
    ollama: getDefaultOllamaSettings(),
    lmstudio: getDefaultLmStudioSettings(),
    runtimes: {
      ollama: {
        numParallel: input?.numParallel ?? 2,
        maxLoadedModels: input?.maxLoadedModels ?? 1,
        keepAliveEnabled: input?.keepAliveEnabled ?? true,
      },
    },
    readAloud: {
      enabled: input?.readAloudEnabled ?? true,
    },
    tools: {
      chromeMcp: {
        enabled: input?.enabled ?? true,
        lastStatus: input?.state
          ? {
              state: input.state,
              message: input.message ?? 'status',
              checkedAt: input.checkedAt ?? 1,
            }
          : undefined,
      },
    },
  }
}

function makeSpeech(input?: Partial<SpeechInspection>): SpeechInspection {
  return {
    supported: true,
    enabled: false,
    provider: 'managed-whisper-cpp',
    providerLabel: 'Managed whisper.cpp',
    model: 'large-v3-turbo-q5_0',
    modelLabel: 'large-v3-turbo-q5_0',
    installState: 'not_installed',
    installed: false,
    healthy: false,
    busy: false,
    detail: 'Speech input is disabled for this test.',
    lastError: null,
    runtimeVersion: null,
    networkDownloadBytes: null,
    diskUsageBytes: null,
    installLocation: null,
    checkedAt: '2026-04-06T15:04:22.381Z',
    ...input,
  }
}

function makeReadAloud(
  input?: Partial<ReadAloudInspection>,
): ReadAloudInspection {
  return {
    supported: true,
    enabled: true,
    provider: 'kokoro-js',
    providerLabel: 'Kokoro',
    model: 'Kokoro-82M-v1.0-ONNX',
    modelLabel: 'Kokoro 82M',
    dtype: 'q8',
    backend: 'cpu',
    state: 'ready',
    healthy: true,
    busy: false,
    detail: 'Bundled Kokoro voice output is ready.',
    lastError: null,
    assetRoot: '/tmp/read-aloud-assets/Kokoro-82M-v1.0-ONNX',
    cacheDir: '/tmp/read-aloud-cache',
    bundledBytes: 92_364_770,
    installProgress: null,
    checkedAt: '2026-04-06T15:04:22.381Z',
    ...input,
  }
}

describe('doctor helpers', () => {
  it('checks node, npm, and npx availability from the app environment', async () => {
    const checks = await collectDoctorCommandChecks(async (command) => {
      if (command === 'node') return 'v22.15.0'
      if (command === 'npm') return '10.9.2'

      const error = Object.assign(new Error('spawn npx ENOENT'), {
        code: 'ENOENT',
      })
      throw error
    })

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'node',
        status: 'available',
        version: '22.15.0',
      }),
      expect.objectContaining({
        id: 'npm',
        status: 'available',
        version: '10.9.2',
      }),
      expect.objectContaining({
        id: 'npx',
        status: 'missing',
      }),
    ])
    expect(checks[2]?.hint).toContain('Install Node.js')
  })

  it('groups runtime variants by family and deduplicates visible models', () => {
    const environment = makeEnvironment([
      makeRuntime({
        runtime: {
          id: 'ollama-native',
          family: 'ollama',
          kind: 'native',
          displayName: 'Ollama Native',
          endpoint: 'http://127.0.0.1:11434',
        },
        installed: true,
        reachable: true,
        healthy: true,
        version: 'ollama version is 0.6.5',
        models: [
          {
            id: 'qwen3:8b',
            runtimeId: 'ollama-native',
            kind: 'llm',
            availability: 'available',
            metadata: {
              name: 'Qwen3 8B',
              parameterCount: '8B',
              quantization: { name: 'Q4_K_M' },
              contextLength: 32768,
            },
            capabilities: [],
          },
        ],
        loadedInstances: [
          {
            id: 'load-1',
            modelId: 'qwen3:8b',
            runtimeId: 'ollama-native',
            status: 'loaded',
            config: { num_ctx: 32768 },
            capabilities: [],
          },
        ],
      }),
      makeRuntime({
        runtime: {
          id: 'ollama-openai',
          family: 'ollama',
          kind: 'openai-compatible',
          displayName: 'Ollama OpenAI-Compatible',
          endpoint: 'http://127.0.0.1:11434/v1',
        },
        installed: true,
        reachable: false,
        healthy: false,
        version: '0.6.5',
        warnings: ['OpenAI-compatible endpoint is not responding'],
        models: [
          {
            id: 'qwen3:8b',
            runtimeId: 'ollama-openai',
            kind: 'llm',
            availability: 'visible',
            metadata: {
              name: 'Qwen3 8B',
              parameterCount: '8B',
            },
            capabilities: [],
          },
        ],
      }),
      makeRuntime({
        runtime: {
          id: 'lmstudio-native',
          family: 'lmstudio',
          kind: 'native',
          displayName: 'LM Studio Native',
          endpoint: 'http://127.0.0.1:1234',
        },
        installed: true,
        reachable: false,
        healthy: false,
        version: '0.3.19',
        diagnosis: ['Enable the LM Studio local server to continue.'],
      }),
      makeRuntime({
        runtime: {
          id: 'llamacpp-server',
          family: 'llamacpp',
          kind: 'server',
          displayName: 'llama.cpp Server',
          endpoint: 'http://127.0.0.1:8080',
        },
        installed: false,
        reachable: false,
        healthy: false,
      }),
    ])

    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment,
      commands: [
        {
          id: 'node',
          label: 'Node.js',
          command: 'node --version',
          status: 'available',
          version: '22.15.0',
          detail: 'Node.js 22.15.0 is available.',
        },
        {
          id: 'npm',
          label: 'npm',
          command: 'npm --version',
          status: 'available',
          version: '10.9.2',
          detail: 'npm 10.9.2 is available.',
        },
        {
          id: 'npx',
          label: 'npx',
          command: 'npx --version',
          status: 'available',
          version: '10.9.2',
          detail: 'npx 10.9.2 is available.',
        },
      ],
      ollamaServerConfig: {
        numParallel: 2,
      },
      settings: makeSettings({
        state: 'ready',
        message: 'Managed browser is ready for this session.',
        checkedAt: 1,
      }),
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {
        screen: 'denied',
        camera: 'granted',
        microphone: 'not-determined',
      },
      platform: 'darwin',
    })

    const ollama = report.runtimes.find((runtime) => runtime.id === 'ollama')
    const lmstudio = report.runtimes.find((runtime) => runtime.id === 'lmstudio')
    const llamacpp = report.runtimes.find((runtime) => runtime.id === 'llamacpp')

    expect(ollama).toEqual(expect.objectContaining({
      status: 'running',
      modelCount: 1,
      loadedModelCount: 1,
    }))
    expect(ollama?.variants).toHaveLength(2)
    expect(ollama?.models).toEqual([
      expect.objectContaining({
        id: 'qwen3:8b',
        status: 'loaded',
        quantization: 'Q4_K_M',
      }),
    ])

    expect(lmstudio).toEqual(expect.objectContaining({
      status: 'stopped',
      modelCount: 0,
    }))
    expect(llamacpp).toEqual(expect.objectContaining({
      status: 'not_installed',
      modelCount: 0,
      summary: 'Gemma Desktop could not detect this runtime on the machine.',
    }))
    expect(report.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'chromeMcp',
        status: 'ready',
      }),
    ]))
    expect(report.summary.ready).toBe(true)
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'LM Studio is installed but not responding',
      }),
      expect.objectContaining({
        title: 'Screen Capture access needs attention',
      }),
    ]))
    expect(report.issues.some((issue) => issue.title.includes('llama.cpp'))).toBe(false)
  })

  it('flags the report as not ready when npx is missing and no primary runtime is healthy', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 36 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M3',
        cpuCount: 8,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'ollama-native',
            family: 'ollama',
            kind: 'native',
            displayName: 'Ollama Native',
            endpoint: 'http://127.0.0.1:11434',
          },
          installed: true,
          reachable: false,
          healthy: false,
        }),
      ]),
      ollamaServerConfig: {
        numParallel: 1,
      },
      commands: [
        {
          id: 'node',
          label: 'Node.js',
          command: 'node --version',
          status: 'available',
          version: '22.15.0',
          detail: 'Node.js 22.15.0 is available.',
        },
        {
          id: 'npm',
          label: 'npm',
          command: 'npm --version',
          status: 'available',
          version: '10.9.2',
          detail: 'npm 10.9.2 is available.',
        },
        {
          id: 'npx',
          label: 'npx',
          command: 'npx --version',
          status: 'missing',
          detail: "npx is not available in Gemma Desktop's app environment.",
          hint: 'Install Node.js, then refresh Doctor so Gemma Desktop can recheck npm and npx. Relaunch only if the app still cannot see the updated shell environment.',
        },
      ],
      settings: makeSettings({
        state: 'error',
        message: 'Could not connect to Chrome.',
      }),
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    expect(report.summary.ready).toBe(false)
    expect(report.summary.errorCount).toBeGreaterThanOrEqual(2)
    expect(report.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'chromeMcp',
        status: 'missing_dependency',
      }),
    ]))
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'npx is unavailable' }),
      expect.objectContaining({ title: 'No compatible runtime is healthy' }),
    ]))
  })

  it('lists unavailable oMLX as a neutral runtime fact', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'ollama-native',
            family: 'ollama',
            kind: 'native',
            displayName: 'Ollama Native',
            endpoint: 'http://127.0.0.1:11434',
          },
          installed: true,
          reachable: true,
          healthy: true,
        }),
        makeRuntime({
          runtime: {
            id: 'omlx-openai',
            family: 'omlx',
            kind: 'openai-compatible',
            displayName: 'oMLX OpenAI-Compatible',
            endpoint: 'http://127.0.0.1:8000/v1',
          },
          installed: false,
          reachable: false,
          healthy: false,
        }),
      ]),
      ollamaServerConfig: null,
      commands: [],
      settings: makeSettings(),
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    const omlx = report.runtimes.find((runtime) => runtime.id === 'omlx')

    expect(omlx).toEqual(expect.objectContaining({
      label: 'oMLX',
      status: 'not_installed',
      modelCount: 0,
      summary: 'Gemma Desktop could not detect this runtime on the machine.',
    }))
    expect(report.issues.some((issue) => issue.title.includes('oMLX'))).toBe(false)
  })

  it('treats healthy oMLX as a compatible inference runtime', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'omlx-openai',
            family: 'omlx',
            kind: 'openai-compatible',
            displayName: 'oMLX OpenAI-Compatible',
            endpoint: 'http://127.0.0.1:8000/v1',
          },
          installed: true,
          reachable: true,
          healthy: true,
          models: [
            {
              id: 'gemma-4-31B-it-MLX-8bit',
              runtimeId: 'omlx-openai',
              kind: 'llm',
              availability: 'visible',
              metadata: {
                maxContextWindow: 32768,
                modelType: 'llm',
              },
              capabilities: [],
            },
          ],
        }),
      ]),
      ollamaServerConfig: null,
      commands: [],
      settings: makeSettings(),
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    expect(report.runtimes.find((runtime) => runtime.id === 'omlx')).toEqual(expect.objectContaining({
      status: 'running',
      modelCount: 1,
    }))
    expect(report.issues.some((issue) => issue.title === 'No compatible runtime is healthy')).toBe(false)
  })

  it("warns when guided Gemma on Ollama is running below Gemma Desktop's requested context", () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'ollama-native',
            family: 'ollama',
            kind: 'native',
            displayName: 'Ollama Native',
            endpoint: 'http://127.0.0.1:11434',
          },
          installed: true,
          reachable: true,
          healthy: true,
          version: 'ollama version is 0.6.5',
          models: [
            {
              id: 'gemma4:26b',
              runtimeId: 'ollama-native',
              kind: 'llm',
              availability: 'available',
              metadata: {
                name: 'Gemma 4 26B',
              },
              capabilities: [],
            },
          ],
          loadedInstances: [
            {
              id: 'load-gemma',
              modelId: 'gemma4:26b',
              runtimeId: 'ollama-native',
              status: 'loaded',
              config: { num_ctx: 32768 },
              capabilities: [],
            },
          ],
        }),
      ]),
      ollamaServerConfig: {
        numParallel: 2,
      },
      commands: [],
      settings: {
        ...makeSettings(),
        modelSelection: {
          ...DEFAULT_MODEL_SELECTION_SETTINGS,
          helperModel: {
            modelId: 'gemma4:26b',
            runtimeId: 'ollama-native',
          },
        },
      },
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    const gemmaContextIssue = report.issues.find(
      (issue) => issue.title === "Gemma 4 26B is below Gemma Desktop's requested context",
    )
    expect(gemmaContextIssue).toBeDefined()
    expect(gemmaContextIssue?.detail).toContain('32K context')
    expect(gemmaContextIssue?.detail).toContain("requested 256K")
  })

  it('warns when helper and primary defaults differ while Ollama is limited to one loaded model', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'ollama-native',
            family: 'ollama',
            kind: 'native',
            displayName: 'Ollama Native',
            endpoint: 'http://127.0.0.1:11434',
          },
          installed: true,
          reachable: true,
          healthy: true,
          models: [],
        }),
      ]),
      ollamaServerConfig: {
        numParallel: 2,
      },
      commands: [],
      settings: {
        ...makeSettings({
          maxLoadedModels: 1,
        }),
        modelSelection: {
          ...DEFAULT_MODEL_SELECTION_SETTINGS,
          mainModel: {
            modelId: 'gemma4:e4b',
            runtimeId: 'ollama-native',
          },
        },
      },
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Ollama helper and primary defaults cannot stay loaded together',
      }),
    ]))
  })

  it('does not warn about shared helper serialization when helper is fixed below primary', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([]),
      ollamaServerConfig: {
        numParallel: 1,
      },
      commands: [],
      settings: {
        ...makeSettings(),
        modelSelection: DEFAULT_MODEL_SELECTION_SETTINGS,
      },
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Ollama will serialize shared helper work',
      }),
    ]))
  })

  it('warns when the running Ollama server settings drift from app settings', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M4 Pro',
        cpuCount: 12,
      },
      environment: makeEnvironment([
        makeRuntime({
          runtime: {
            id: 'ollama-native',
            family: 'ollama',
            kind: 'native',
            displayName: 'Ollama Native',
            endpoint: 'http://127.0.0.1:11434',
          },
          installed: true,
          reachable: true,
          healthy: true,
          models: [],
        }),
      ]),
      ollamaServerConfig: {
        numParallel: 1,
        maxLoadedModels: 0,
        keepAlive: '5m0s',
      },
      commands: [],
      settings: makeSettings({
        maxLoadedModels: 2,
        numParallel: 2,
        keepAliveEnabled: true,
      }),
      speech: makeSpeech(),
      readAloud: makeReadAloud(),
      permissionStatuses: {},
      platform: 'darwin',
    })

    const driftIssue = report.issues.find((issue) =>
      issue.title === 'Ollama server settings differ from Gemma Desktop',
    )
    expect(driftIssue?.detail).toContain('OLLAMA_KEEP_ALIVE=5m0s (expected 24h)')
    expect(driftIssue?.detail).toContain('will not restart or reconfigure Ollama automatically')
  })

  it('recommends speech setup actions based on microphone permission and install state', () => {
    const permissionFirstReport = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 36 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M3',
        cpuCount: 8,
      },
      environment: makeEnvironment([]),
      ollamaServerConfig: null,
      commands: [],
      settings: makeSettings(),
      speech: makeSpeech({
        enabled: true,
        installState: 'not_installed',
        detail: 'Install Managed whisper.cpp to continue.',
      }),
      readAloud: makeReadAloud(),
      permissionStatuses: {
        microphone: 'not-determined',
      },
      platform: 'darwin',
    })

    expect(permissionFirstReport.speech.recommendedAction).toBe('request_microphone')

    const installReport = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 36 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M3',
        cpuCount: 8,
      },
      environment: makeEnvironment([]),
      ollamaServerConfig: null,
      commands: [],
      settings: makeSettings(),
      speech: makeSpeech({
        enabled: true,
        installState: 'not_installed',
        detail: 'Install Managed whisper.cpp to continue.',
      }),
      readAloud: makeReadAloud({
        state: 'missing_assets',
        healthy: false,
        detail: 'Bundled Kokoro voice assets are missing for this build.',
      }),
      permissionStatuses: {
        microphone: 'granted',
      },
      platform: 'darwin',
    })

    expect(installReport.speech.recommendedAction).toBe('install')
    expect(installReport.readAloud.recommendedAction).toBe(null)
    expect(installReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Read aloud will install on first use',
      }),
    ]))
  })

  it('recommends repairing speech after a failed install instead of opening settings', () => {
    const report = buildDoctorReport({
      generatedAt: '2026-04-06T15:10:00.000Z',
      app: {
        version: '0.1.0',
        electron: '35.0.0',
        node: '22.15.0',
        chrome: '134.0.0.0',
      },
      machine: {
        platform: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        totalMemoryBytes: 36 * 1024 * 1024 * 1024,
        cpuModel: 'Apple M3',
        cpuCount: 8,
      },
      environment: makeEnvironment([]),
      ollamaServerConfig: null,
      commands: [],
      settings: makeSettings(),
      speech: makeSpeech({
        enabled: true,
        installState: 'error',
        installed: false,
        healthy: false,
        detail: 'Speech install needs attention before the microphone can be used.',
        lastError: 'Speech install is not configured for this build. There is no default Gemma Desktop-hosted speech service.',
      }),
      readAloud: makeReadAloud(),
      permissionStatuses: {
        microphone: 'granted',
      },
      platform: 'darwin',
    })

    expect(report.speech.recommendedAction).toBe('repair')
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Speech runtime needs repair',
      }),
    ]))
  })
})
