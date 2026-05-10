import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationStore,
  type AutomationRecord,
} from '../../src/main/automations'

const electronMock = vi.hoisted(() => ({
  userData: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronMock.userData,
  },
}))

let tempDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-automation-store-'))
  electronMock.userData = tempDir
})

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

describe('AutomationStore', () => {
  it('recovers interrupted running runs on startup', async () => {
    const automationDir = path.join(tempDir, 'automations')
    await fs.mkdir(automationDir, { recursive: true })

    const record: AutomationRecord = {
      id: 'automation-1',
      name: 'Nightly build check',
      prompt: 'Run the nightly check.',
      mode: 'build',
      selectedSkillIds: [],
      selectedSkillNames: [],
      workingDirectory: tempDir,
      enabled: true,
      schedule: {
        kind: 'interval',
        every: 1,
        unit: 'hours',
        startAt: 1,
      },
      nextRunAt: 1,
      lastRunAt: 10,
      lastRunStatus: 'running',
      createdAt: 1,
      updatedAt: 10,
      runs: [
        {
          id: 'run-1',
          trigger: 'schedule',
          startedAt: 10,
          status: 'running',
          summary: 'Scheduled run started',
          logs: [],
        },
      ],
    }

    await fs.writeFile(
      path.join(automationDir, `${record.id}.json`),
      JSON.stringify(record, null, 2),
      'utf8',
    )

    const store = new AutomationStore()
    await store.init()

    const recovered = store.get(record.id)
    expect(recovered?.lastRunStatus).toBe('cancelled')
    expect(recovered?.runs[0]?.status).toBe('cancelled')
    expect(recovered?.runs[0]?.summary).toBe('Run interrupted before completion')
    expect(recovered?.runs[0]?.errorMessage).toBe(
      'Gemma Desktop stopped before this automation finished.',
    )
    expect(recovered?.runs[0]?.finishedAt).toEqual(expect.any(Number))
    expect(recovered?.runs[0]?.logs[0]?.event).toBe('automation.interrupted')

    const persisted = JSON.parse(
      await fs.readFile(path.join(automationDir, `${record.id}.json`), 'utf8'),
    ) as AutomationRecord
    expect(persisted.lastRunStatus).toBe('cancelled')
    expect(persisted.runs[0]?.status).toBe('cancelled')
  })
})
