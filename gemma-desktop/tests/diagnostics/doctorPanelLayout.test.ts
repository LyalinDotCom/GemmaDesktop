import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DoctorPanel } from '../../src/renderer/src/components/DoctorPanel'

function renderDoctorPanel(): string {
  return renderToStaticMarkup(
    createElement(DoctorPanel, {
      open: true,
      onClose: () => {},
      onInstallSpeech: () => {},
      onRepairSpeech: () => {},
      onOpenSettings: () => {},
      onOpenVoiceSettings: () => {},
      onTestReadAloud: () => {},
    }),
  )
}

describe('DoctorPanel layout', () => {
  it('keeps tab changes inside a stable scrollable modal shell', () => {
    const markup = renderDoctorPanel()

    expect(markup).toContain('max-w-4xl')
    expect(markup).toContain('h-[min(78vh,760px)]')
    expect(markup).toContain('aria-label="Doctor sections"')
    expect(markup).toContain('w-44 shrink-0 overflow-y-auto border-r')
    expect(markup).toContain('scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden')
    expect(markup).toContain('min-w-0 space-y-6')
    expect(markup).not.toContain('max-h-full w-full max-w-4xl')
  })
})
