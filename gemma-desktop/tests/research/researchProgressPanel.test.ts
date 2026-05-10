import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildDomainIconCandidates,
  ResearchProgressPanel,
} from '../../src/renderer/src/components/ResearchProgressPanel'
import type { ResearchPanelViewModel } from '../../src/renderer/src/types'

function buildPanel(): ResearchPanelViewModel {
  return {
    runId: 'run-1',
    runStatus: 'running',
    stage: 'discovery',
    title: 'Open model runtimes',
    modelLabel: 'gemma4:31b-mlx-bf16 via ollama-native',
    startedAt: Date.now() - 10_000,
    plan: {
      status: 'completed',
      label: 'Research plan created',
      topicCount: 1,
    },
    sources: {
      status: 'running',
      label: 'Gathering 3 sources and counting…',
      totalSources: 3,
      targetSources: 18,
      distinctDomains: 1,
      targetDomains: 10,
      topDomains: [
        { domain: 'ai.google.dev', count: 3 },
      ],
      otherDomainCount: 0,
      otherDomainSourceCount: 0,
    },
    depth: {
      status: 'pending',
      label: 'Choose second-level source pages',
    },
    topics: [],
    synthesis: {
      status: 'pending',
      label: 'Synthesize the final report',
    },
  }
}

describe('ResearchProgressPanel', () => {
  it('builds favicon candidates before falling back to the domain monogram', () => {
    expect(buildDomainIconCandidates('https://www.ai.google.dev/models')).toEqual([
      'https://ai.google.dev/favicon.ico',
      'https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fai.google.dev&sz=64',
    ])
    expect(buildDomainIconCandidates('not a host')).toEqual([])
  })

  it('renders the source favicon attempt with the current monogram fallback still present', () => {
    const markup = renderToStaticMarkup(
      createElement(ResearchProgressPanel, {
        panel: buildPanel(),
        isActive: true,
      }),
    )

    expect(markup).toContain('src="https://ai.google.dev/favicon.ico"')
    expect(markup).toContain('AG')
    expect(markup).toContain('ai.google.dev')
    expect(markup).toContain('gemma4:31b-mlx-bf16 via ollama-native')
  })

  it('renders critical research warnings prominently', () => {
    const panel = {
      ...buildPanel(),
      runStatus: 'completed' as const,
      warningMessages: ['Final model synthesis did not complete.'],
    }
    const markup = renderToStaticMarkup(
      createElement(ResearchProgressPanel, {
        panel,
        isActive: false,
      }),
    )

    expect(markup).toContain('Final model synthesis did not complete.')
    expect(markup).toContain('amber')
  })
})
