import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResearchSetupPanel } from '../src/renderer/src/components/ResearchSetupPanel'

describe('ResearchSetupPanel', () => {
  it('disables research creation while another conversation is running', () => {
    const reason =
      'Gemma Desktop is already answering in "Build notes". Wait for that conversation to finish or stop it before starting another one.'

    const markup = renderToStaticMarkup(
      createElement(ResearchSetupPanel, {
        defaultTitle: 'Research project-alpha',
        defaultPrompt: 'Investigate local inference',
        workingDirectory: '/tmp/project-alpha',
        disabledReason: reason,
        onSubmit: () => {},
      }),
    )

    expect(markup).toContain('Gemma Desktop is already answering')
    expect(markup).toContain('Wait for that conversation to finish')
    expect(markup).toContain('disabled=""')
  })
})
