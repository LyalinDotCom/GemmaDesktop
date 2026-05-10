import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveActivityIndicator } from '../../src/renderer/src/components/LiveActivityIndicator'
import type { LiveActivitySnapshot } from '../../src/renderer/src/types'

function makeActivity(
  overrides: Partial<LiveActivitySnapshot> = {},
): LiveActivitySnapshot {
  return {
    source: 'session',
    state: 'working',
    startedAt: 1_000,
    lastEventAt: 54_000,
    firstTokenAt: 14_000,
    assistantUpdates: 280,
    reasoningUpdates: 0,
    lifecycleEvents: 0,
    runningToolCount: 1,
    completedToolCount: 0,
    recentProgressCount: 280,
    lastProgressAt: 54_000,
    activeToolName: 'web_research_agent',
    activeToolLabel: 'Drafting topic dossier',
    ...overrides,
  }
}

describe('LiveActivityIndicator', () => {
  it('keeps long active tool labels inside a compact popover layout', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveActivityIndicator, {
        activity: makeActivity(),
      }),
    )

    expect(markup).toContain('w-[20rem]')
    expect(markup).toContain('max-w-[calc(100vw-1.5rem)]')
    expect(markup).toContain('[overflow-wrap:anywhere]')
    expect(markup).toContain('Drafting topic dossier')
    expect(markup).toContain('web_research_agent')
    expect(markup).not.toContain('Drafting topic dossier (web_research_agent)')
  })
})
