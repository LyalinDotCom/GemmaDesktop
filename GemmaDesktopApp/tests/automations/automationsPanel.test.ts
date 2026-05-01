import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AutomationsPanel } from '../../src/renderer/src/components/AutomationsPanel'
import type {
  AutomationDetail,
  AutomationSchedule,
} from '../../src/renderer/src/types'

function makeAutomationDetail(input: {
  schedule: AutomationSchedule
}): AutomationDetail {
  return {
    id: 'automation-1',
    name: 'Nightly build check',
    prompt: 'Run the nightly check.',
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
      installedSkills: [],
      defaultWorkingDirectory: '/tmp/project',
      newAutomationSeed: 0,
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
