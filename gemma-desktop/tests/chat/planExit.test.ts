import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildPlanExitKickoffMessage,
  buildPlanExitHandoffMessage,
  buildPlanExitSessionTitle,
  extractPlanDetailsFromText,
  extractPlanSummaryFromText,
  isPlanExitToolName,
} from '../../src/main/planExit'
import { PlanExecutionCard } from '../../src/renderer/src/components/PlanExecutionCard'
import type { PendingPlanExit } from '../../src/renderer/src/types'

describe('plan exit helpers', () => {
  it('recognizes the plan exit tool', () => {
    expect(isPlanExitToolName('exit_plan_mode')).toBe(true)
    expect(isPlanExitToolName('read_file')).toBe(false)
  })

  it('builds a fresh-session handoff message with plan and prior-session basics', () => {
    const message = buildPlanExitHandoffMessage({
      sourceSessionId: 'session-plan-1',
      sourceTitle: 'Solar System Planner',
      sourceLastMessage: 'Build a stylized solar system simulator in Three.js.',
      workingDirectory: '/tmp/gemma-desktop',
      conversationKind: 'normal',
      workMode: 'build',
      selectedSkillNames: ['frontend-design'],
      selectedToolNames: ['read_file', 'search_text'],
      summary: 'Build the stylized solar system simulator.',
      details: 'Use Vite and Three.js. Keep textures out of scope.',
    })

    expect(message.role).toBe('assistant')
    expect(message.content[0]).toMatchObject({
      type: 'text',
    })

    const text = message.content[0]?.type === 'text'
      ? message.content[0].text
      : ''

    expect(text).toContain('Planning handoff')
    expect(text).toContain('Approved plan summary:')
    expect(text).toContain('Build the stylized solar system simulator.')
    expect(text).toContain('Approved plan details:')
    expect(text).toContain('Previous conversation basics:')
    expect(text).toContain('Working directory: /tmp/gemma-desktop')
    expect(text).toContain('Selected skills: frontend-design')
  })

  it('creates a distinct work-session title', () => {
    expect(buildPlanExitSessionTitle('Solar System Planner')).toBe(
      'Solar System Planner (Act)',
    )
    expect(buildPlanExitSessionTitle('New Conversation')).toBe('Act Handoff')
  })

  it('builds a kickoff prompt that starts implementation immediately', () => {
    const prompt = buildPlanExitKickoffMessage({
      summary: 'Implement the renderer and controls.',
      details: 'Add orbit controls, then wire the follow camera.',
      workMode: 'build',
    })

    expect(prompt).toContain('Implement the approved plan now.')
    expect(prompt).toContain('Approved plan summary:')
    expect(prompt).toContain('Implement the renderer and controls.')
    expect(prompt).toContain('Approved plan details:')
    expect(prompt).toContain('Execution rules:')
    expect(prompt).toContain('use non-interactive commands and flags')
  })

  it('extracts full plan details while dropping trailing follow-up questions', () => {
    const details = extractPlanDetailsFromText([
      '### Roadmap',
      '',
      '1. Scaffold the app.',
      '2. Add the renderer and controls.',
      '',
      '**Would you like me to refine this further?**',
    ].join('\n'))

    expect(details).toContain('### Roadmap')
    expect(details).toContain('1. Scaffold the app.')
    expect(details).not.toContain('Would you like me to refine this further?')
  })

  it('extracts a short summary from the first non-empty paragraph', () => {
    const summary = extractPlanSummaryFromText([
      '',
      'Build a modular solar system simulation.',
      '',
      'Then wire up labels and camera focus.',
    ].join('\n'))

    expect(summary).toBe('Build a modular solar system simulation.')
  })
})

describe('PlanExecutionCard', () => {
  it('renders accept and revise actions for plan handoff', () => {
    const planExit: PendingPlanExit = {
      id: 'plan-exit-1',
      createdAt: Date.now(),
      workMode: 'build',
      summary: 'Implement the renderer and controls.',
      details: 'Then add the follow camera and orbit toggles.',
    }

    const markup = renderToStaticMarkup(
      createElement(PlanExecutionCard, {
        planExit,
        busy: false,
        onExit: async () => {},
        onRevise: async () => {},
        onDismiss: async () => {},
      }),
    )

    expect(markup).toContain('Accept and Start New Build Chat')
    expect(markup).toContain('Build in This Conversation')
    expect(markup).toContain('What should change before implementation starts?')
    expect(markup).toContain(
      'Accepting starts a fresh work chat by default. Building here keeps the current conversation transcript.',
    )
  })
})
