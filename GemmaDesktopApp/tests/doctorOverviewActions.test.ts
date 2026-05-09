import { describe, expect, it } from 'vitest'
import type { DoctorReport } from '../src/renderer/src/types'
import { getDoctorOverviewIssueActions } from '../src/renderer/src/components/DoctorPanel'

function makeReport(input?: Partial<DoctorReport>): DoctorReport {
  return {
    generatedAt: '2026-04-29T12:00:00.000Z',
    summary: {
      ready: false,
      headline: 'Needs attention',
      errorCount: 0,
      warningCount: 1,
    },
    app: {
      version: '0.1.0',
      electron: '41.3.0',
      node: '24.0.0',
      chrome: '140.0.0',
    },
    machine: {
      platform: 'darwin',
      release: '25.0.0',
      arch: 'arm64',
      cpuCount: 12,
      totalMemoryGB: 64,
    },
    commands: [],
    runtimes: [],
    speech: {
      providerLabel: 'Managed whisper.cpp',
      modelLabel: 'large-v3-turbo-q5_0',
      enabled: true,
      installState: 'not_installed',
      healthy: false,
      detail: 'Speech runtime is not installed yet.',
      lastError: null,
      recommendedAction: 'install',
    },
    readAloud: {
      providerLabel: 'Kokoro',
      modelLabel: 'Kokoro 82M',
      dtype: 'q8',
      backend: 'wasm',
      enabled: true,
      state: 'ready',
      healthy: true,
      detail: 'Ready.',
      lastError: null,
      recommendedAction: null,
    },
    permissions: [],
    integrations: [],
    issues: [],
    ...input,
  }
}

describe('getDoctorOverviewIssueActions', () => {
  it('offers the existing permission action for camera issues', () => {
    const report = makeReport({
      permissions: [{
        id: 'camera',
        label: 'Camera',
        status: 'denied',
        severity: 'warning',
        summary: 'Camera access needs attention.',
        requestableInApp: true,
      }],
    })

    expect(getDoctorOverviewIssueActions({
      severity: 'warning',
      title: 'Camera access needs attention',
      detail: 'Open System Settings.',
    }, report)).toEqual([
      {
        kind: 'openPrivacySettings',
        label: 'Open Camera Settings',
        permissionId: 'camera',
      },
      {
        kind: 'tab',
        label: 'View Permissions',
        tab: 'permissions',
      },
    ])
  })

  it('uses the speech recommended action before linking to the speech tab', () => {
    const report = makeReport({
      speech: {
        ...makeReport().speech,
        recommendedAction: 'repair',
      },
    })

    expect(getDoctorOverviewIssueActions({
      severity: 'warning',
      title: 'Speech runtime needs repair',
      detail: 'Runtime failed.',
    }, report)).toEqual([
      {
        kind: 'repairSpeech',
        label: 'Repair Speech',
      },
      {
        kind: 'tab',
        label: 'View Speech',
        tab: 'speech',
      },
    ])
  })

  it('routes runtime issues to the runtime tab', () => {
    const report = makeReport({
      runtimes: [{
        id: 'ollama',
        label: 'Ollama',
        status: 'running',
        modelCount: 0,
        loadedModelCount: 0,
        summary: 'No visible models.',
        variants: [],
        models: [],
        warnings: [],
        diagnosis: [],
      }],
    })

    expect(getDoctorOverviewIssueActions({
      severity: 'warning',
      title: 'Ollama is running without visible models',
      detail: 'No non-embedding models were found.',
    }, report)).toEqual([
      {
        kind: 'tab',
        label: 'View Runtimes',
        tab: 'runtimes',
      },
    ])
  })

  it('does not route arbitrary suffix matches without matching report evidence', () => {
    const report = makeReport()

    expect(getDoctorOverviewIssueActions({
      severity: 'warning',
      title: 'Imaginary Runtime is installed but not responding',
      detail: 'This title shape alone should not be enough.',
    }, report)).toEqual([])
  })

  it('routes model runtime issues when the model is present in the report', () => {
    const report = makeReport({
      runtimes: [{
        id: 'ollama',
        label: 'Ollama',
        status: 'running',
        modelCount: 1,
        loadedModelCount: 1,
        summary: 'Ready.',
        variants: [],
        models: [{
          id: 'gemma4:26b',
          label: 'Gemma 4 26B',
          status: 'loaded',
          contextLength: 8192,
        }],
        warnings: [],
        diagnosis: [],
      }],
    })

    expect(getDoctorOverviewIssueActions({
      severity: 'warning',
      title: "Gemma 4 26B is below Gemma Desktop's requested context",
      detail: 'Context is lower than expected.',
    }, report)).toEqual([
      {
        kind: 'tab',
        label: 'View Runtimes',
        tab: 'runtimes',
      },
    ])
  })
})
