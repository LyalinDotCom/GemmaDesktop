import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { writeFileAtomic } from './atomicWrite'

export type AutomationSchedule =
  | {
      kind: 'once'
      runAt: number
    }
  | {
      kind: 'interval'
      every: number
      unit: 'minutes' | 'hours' | 'days'
      startAt: number
    }

export interface AutomationLogEntry {
  id: string
  timestamp: number
  layer: 'automation' | 'sdk' | 'runtime'
  event: string
  summary: string
  data: unknown
}

export interface AutomationRunRecord {
  id: string
  trigger: 'manual' | 'schedule'
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error' | 'cancelled'
  summary: string
  outputText?: string
  errorMessage?: string
  generatedTokens?: number
  tokensPerSecond?: number
  logs: AutomationLogEntry[]
}

export interface AutomationRecord {
  id: string
  name: string
  prompt: string
  runtimeId: string
  modelId: string
  mode: 'explore' | 'build'
  selectedSkillIds: string[]
  selectedSkillNames: string[]
  workingDirectory: string
  enabled: boolean
  schedule: AutomationSchedule
  nextRunAt: number | null
  lastRunAt?: number
  lastRunStatus?: 'running' | 'success' | 'error' | 'cancelled'
  createdAt: number
  updatedAt: number
  runs: AutomationRunRecord[]
}

const MAX_RUNS_PER_AUTOMATION = 40
const MAX_LOGS_PER_RUN = 1500

function getAutomationDir(): string {
  return path.join(app.getPath('userData'), 'automations')
}

function filePathForAutomation(automationId: string): string {
  return path.join(getAutomationDir(), `${automationId}.json`)
}

function normalizeRunRecord(run: AutomationRunRecord): AutomationRunRecord {
  return {
    ...run,
    trigger: run.trigger === 'schedule' ? 'schedule' : 'manual',
    status:
      run.status === 'running'
      || run.status === 'success'
      || run.status === 'error'
      || run.status === 'cancelled'
        ? run.status
        : 'error',
  }
}

function createInterruptedRunLogEntry(): AutomationLogEntry {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    layer: 'automation',
    event: 'automation.interrupted',
    summary: 'Run was interrupted before Gemma Desktop finished it.',
    data: {
      reason: 'app_shutdown_or_crash',
    },
  }
}

function recoverInterruptedRuns(record: AutomationRecord): {
  record: AutomationRecord
  changed: boolean
} {
  let changed = false
  const runs = record.runs.map((run) => {
    if (run.status !== 'running') {
      return run
    }

    changed = true
    return {
      ...run,
      status: 'cancelled' as const,
      finishedAt: run.finishedAt ?? Date.now(),
      summary: 'Run interrupted before completion',
      errorMessage: 'Gemma Desktop stopped before this automation finished.',
      logs: [...run.logs, createInterruptedRunLogEntry()].slice(-MAX_LOGS_PER_RUN),
    }
  })

  if (!changed) {
    return { record, changed: false }
  }

  return {
    changed: true,
    record: {
      ...record,
      runs,
      lastRunStatus: record.lastRunStatus === 'running'
        ? 'cancelled'
        : record.lastRunStatus,
    },
  }
}

function normalizeAutomationRecord(record: AutomationRecord): AutomationRecord {
  return {
    ...record,
    mode: 'build',
    lastRunStatus:
      record.lastRunStatus === 'running'
      || record.lastRunStatus === 'success'
      || record.lastRunStatus === 'error'
      || record.lastRunStatus === 'cancelled'
        ? record.lastRunStatus
        : undefined,
    runs: Array.isArray(record.runs)
      ? record.runs.map((run) => normalizeRunRecord(run as AutomationRunRecord))
      : [],
  }
}

export function intervalToMs(schedule: Extract<AutomationSchedule, { kind: 'interval' }>): number {
  const unitMs =
    schedule.unit === 'minutes'
      ? 60_000
      : schedule.unit === 'hours'
        ? 3_600_000
        : 86_400_000
  return schedule.every * unitMs
}

export function computeInitialNextRunAt(
  schedule: AutomationSchedule,
): number | null {
  if (schedule.kind === 'once') {
    return schedule.runAt
  }

  return schedule.startAt
}

export function computeNextRunAt(
  record: AutomationRecord,
): number | null {
  if (!record.enabled) {
    return record.nextRunAt
  }

  if (record.schedule.kind === 'once') {
    return null
  }

  return Date.now() + intervalToMs(record.schedule)
}

export function scheduleToText(schedule: AutomationSchedule): string {
  if (schedule.kind === 'once') {
    return `One time • ${new Date(schedule.runAt).toLocaleString()}`
  }

  const label = schedule.every === 1
    ? schedule.unit.slice(0, -1)
    : schedule.unit
  return `Every ${schedule.every} ${label} • starts ${new Date(schedule.startAt).toLocaleString()}`
}

export class AutomationStore {
  private readonly dir = getAutomationDir()
  private readonly records = new Map<string, AutomationRecord>()

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const files = await fs.readdir(this.dir)
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue
      }

      try {
        const raw = await fs.readFile(path.join(this.dir, file), 'utf8')
        const normalized = normalizeAutomationRecord(JSON.parse(raw) as AutomationRecord)
        const recovered = recoverInterruptedRuns(normalized)
        this.records.set(recovered.record.id, recovered.record)
        if (recovered.changed) {
          await this.save(recovered.record)
        }
      } catch {
        continue
      }
    }
  }

  list(): AutomationRecord[] {
    return [...this.records.values()].sort((left, right) => {
      return right.updatedAt - left.updatedAt
    })
  }

  get(automationId: string): AutomationRecord | null {
    return this.records.get(automationId) ?? null
  }

  async save(record: AutomationRecord): Promise<void> {
    const nextRecord: AutomationRecord = {
      ...record,
      runs: [...record.runs].slice(-MAX_RUNS_PER_AUTOMATION),
      updatedAt: Date.now(),
    }
    this.records.set(nextRecord.id, nextRecord)
    await writeFileAtomic(
      filePathForAutomation(nextRecord.id),
      JSON.stringify(nextRecord, null, 2),
      'utf8',
    )
  }

  async remove(automationId: string): Promise<void> {
    this.records.delete(automationId)
    try {
      await fs.unlink(filePathForAutomation(automationId))
    } catch {
      // Already gone.
    }
  }

  async create(input: Omit<AutomationRecord, 'id' | 'createdAt' | 'updatedAt' | 'runs'>): Promise<AutomationRecord> {
    const record: AutomationRecord = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runs: [],
    }
    await this.save(record)
    return record
  }

  async update(
    automationId: string,
    patch: Partial<AutomationRecord>,
  ): Promise<AutomationRecord> {
    const current = this.get(automationId)
    if (!current) {
      throw new Error(`Automation not found: ${automationId}`)
    }

    const nextRecord: AutomationRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      runs: patch.runs ?? current.runs,
      updatedAt: Date.now(),
    }
    await this.save(nextRecord)
    return nextRecord
  }

  async createRun(
    automationId: string,
    summary: string,
    trigger: AutomationRunRecord['trigger'],
  ): Promise<AutomationRunRecord> {
    const record = this.get(automationId)
    if (!record) {
      throw new Error(`Automation not found: ${automationId}`)
    }

    const run: AutomationRunRecord = {
      id: randomUUID(),
      trigger,
      startedAt: Date.now(),
      status: 'running',
      summary,
      logs: [],
    }

    await this.update(automationId, {
      lastRunAt: run.startedAt,
      lastRunStatus: 'running',
      runs: [...record.runs, run],
    })

    return run
  }

  async appendRunLog(
    automationId: string,
    runId: string,
    entry: AutomationLogEntry,
  ): Promise<void> {
    const record = this.get(automationId)
    if (!record) {
      return
    }

    const runs = record.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            logs: [...run.logs, entry].slice(-MAX_LOGS_PER_RUN),
          }
        : run,
    )
    await this.update(automationId, { runs })
  }

  async completeRun(
    automationId: string,
    runId: string,
    patch: Partial<AutomationRunRecord>,
  ): Promise<void> {
    const record = this.get(automationId)
    if (!record) {
      return
    }

    const runs = record.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            ...patch,
            id: run.id,
            finishedAt: patch.finishedAt ?? Date.now(),
          }
        : run,
    )
    const completed = runs.find((run) => run.id === runId)
    await this.update(automationId, {
      runs,
      lastRunStatus: completed?.status ?? record.lastRunStatus,
    })
  }
}
