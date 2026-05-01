import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AutomationsPanel } from '../../src/renderer/src/components/AutomationsPanel'
import type {
  AutomationDetail,
  AutomationSchedule,
  ModelSummary,
} from '../../src/renderer/src/types'

const model: ModelSummary = {
  id: 'gemma4:26b',
  name: 'Gemma 4 26B',
  runtimeId: 'ollama-native',
  runtimeName: 'Ollama Native',
  status: 'available',
}

function makeAutomationDetail(input: {
  schedule: AutomationSchedule
}): AutomationDetail {
  return {
    id: 'automation-1',
    name: 'Nightly build check',
    prompt: 'Run the nightly check.',
    runtimeId: model.runtimeId,
    modelId: model.id,
    mode: 'build',
    selectedSkillIds: [],
    selectedSkillNames: [],
    workingDirectory: '/tmp/project',
    enabled: true,
    schedule: input.schedule,
    scheduleText: 'Every 1 hour',
    nextRunAt: input.schedule.kind === 'once' ? input.schedule.runAt : input.schedule.startAt,
    createdAt: 1,
    updatedAt: 1,
    runCount: 0,
    runs: [],
  }
}

function renderPanel(): string {
  const schedule: AutomationSchedule = {
    kind: 'once',
    runAt: Date.now() + 60 * 60 * 1000,
  }

  return renderToStaticMarkup(
    createElement(AutomationsPanel, {
      activeAutomation: null,
      models: [model],
      gemmaInstallStates: [],
      installedSkills: [],
      defaultWorkingDirectory: '/tmp/project',
      defaultModelTarget: {
        modelId: model.id,
        runtimeId: model.runtimeId,
      },
      newAutomationSeed: 0,
      onEnsureGemmaModel: async (tag) => ({
        ok: true,
        tag,
        installed: true,
      }),
      onCreateAutomation: async () => makeAutomationDetail({ schedule }),
      onUpdateAutomation: async () => makeAutomationDetail({ schedule }),
      onDeleteAutomation: async () => {},
      onRunNow: async () => {},
      onCancelRun: async () => {},
    }),
  )
}

describe('AutomationsPanel', () => {
  it('surfaces that automations run unattended in YOLO mode', () => {
    const markup = renderPanel()

    expect(markup).toContain('YOLO execution')
    expect(markup).toContain('Automations run unattended in YOLO mode')
    expect(markup).toContain('allowed build tools without asking first')
  })
})
