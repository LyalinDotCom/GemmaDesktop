import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolSelector } from '../src/renderer/src/components/ToolSelector'
import type { SessionToolDefinition } from '../src/renderer/src/types'

const workspaceTool: SessionToolDefinition = {
  id: 'workspace-helper',
  slug: 'workspace-helper',
  name: 'Workspace Helper',
  description: 'Inspect the workspace.',
  icon: 'globe',
  instructions: 'Use workspace tools.',
  supportedPlatforms: ['darwin', 'linux', 'win32'],
  toolNames: ['workspace_inspector_agent'],
}

const geminiTool: SessionToolDefinition = {
  id: 'ask-gemini',
  slug: 'ask-gemini',
  name: 'Ask Gemini',
  description: 'Ask Gemini for help.',
  icon: 'sparkles',
  instructions: 'Use ask_gemini.',
  supportedPlatforms: ['darwin', 'linux', 'win32'],
  toolNames: ['ask_gemini'],
}

describe('ToolSelector', () => {
  it('renders one button per tool instead of collapsing into a menu', () => {
    const markup = renderToStaticMarkup(
      createElement(ToolSelector, {
        tools: [workspaceTool, geminiTool],
        selectedToolIds: ['workspace-helper'],
        onToggleTool: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Enable Ask Gemini"')
    expect(markup).toContain('aria-label="Disable Workspace Helper"')
    expect(markup).not.toContain('aria-label="Session tools"')
  })
})
