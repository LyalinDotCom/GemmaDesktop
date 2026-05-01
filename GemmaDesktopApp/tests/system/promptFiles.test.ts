import { describe, expect, it } from 'vitest'
import {
  composeAppSystemInstructions,
  getChatSystemInstructions,
  getPlanningSystemInstructions,
  listPromptMarkdownCandidatePaths,
} from '../../src/main/promptFiles'

describe('prompt files', () => {
  it('loads shared baseline instructions for the main chat from markdown on disk', () => {
    const prompt = getChatSystemInstructions('explore')

    expect(prompt).toContain('Treat conversation history as historical context only.')
    expect(prompt).toContain('**Multimodal Attachments:**')
    expect(prompt).toContain('A file path, URL, or manifest is not visual/audio access.')
    expect(prompt).not.toContain('Explore mode is active for this conversation.')
  })

  it('loads assistant chat instructions from the shared baseline', () => {
    const prompt = getChatSystemInstructions('assistant')

    expect(prompt).toContain('Treat conversation history as historical context only.')
    expect(prompt).toContain('Never guess unseen image, video, or audio contents.')
    expect(prompt).not.toContain('Assistant mode is active for this conversation.')
    expect(prompt).not.toContain('After search identifies the right source')
  })

  it('loads act instructions from markdown on disk for build sessions', () => {
    const prompt = getChatSystemInstructions('build')

    expect(prompt).toContain('Treat conversation history as historical context only.')
    expect(prompt).not.toContain('Act mode is active for this conversation.')
    expect(prompt).not.toContain('Favor executing concrete workspace changes end-to-end.')
    expect(prompt).not.toContain('Act mode includes shell-command safety guardrails.')
  })

  it('includes the assistant markdown file in the lookup candidates', () => {
    const candidates = listPromptMarkdownCandidatePaths('assistant')

    expect(candidates.some((candidate) => candidate.endsWith('/resources/prompts/assistant.md'))).toBe(true)
  })

  it('includes the act markdown file in the lookup candidates', () => {
    const candidates = listPromptMarkdownCandidatePaths('act')

    expect(candidates.some((candidate) => candidate.endsWith('/resources/prompts/act.md'))).toBe(true)
  })

  it('loads Planning system instructions from markdown on disk', () => {
    const prompt = getPlanningSystemInstructions('build')

    expect(prompt).toContain('Treat conversation history as historical context only.')
    expect(prompt).toContain('Planning overlay for underlying act work.')
    expect(prompt).not.toContain('Plan mode is active for this session.')
    expect(prompt).toContain('Do not ask the user to approve the plan in plain text first.')
    expect(prompt).toContain('put a short one-line handoff in `summary`')
    expect(prompt).toContain('put the actual approved plan in `details`')
    expect(prompt).toContain('exit_plan_mode')
    expect(prompt).toContain('ask_user')
  })

  it('includes the Plan markdown file in the lookup candidates', () => {
    const candidates = listPromptMarkdownCandidatePaths('plan')

    expect(candidates.some((candidate) => candidate.endsWith('/resources/prompts/plan.md'))).toBe(true)
  })

  it('includes the shared baseline markdown file in the lookup candidates', () => {
    const candidates = listPromptMarkdownCandidatePaths('baseline')

    expect(candidates.some((candidate) => candidate.endsWith('/resources/prompts/baseline.md'))).toBe(true)
  })

  it('composes app-owned prompt sections with user memory quarantined last', () => {
    const prompt = composeAppSystemInstructions({
      primaryPrompt: 'Primary prompt.',
      sessionTools: 'Tool-specific app instructions.',
      projectBrowser: 'Project Browser instructions.',
      backgroundProcesses: 'Background process instructions.',
      userMemory: '<user_memory_context>\n<memory>\n- user fact\n</memory>\n</user_memory_context>',
    })

    expect(prompt).toBeDefined()
    if (!prompt) {
      throw new Error('Expected app prompt to be composed.')
    }

    expect(prompt.startsWith('<gemma_desktop_app_context>')).toBe(true)
    expect(prompt.endsWith('</gemma_desktop_app_context>')).toBe(true)
    expect(prompt).toContain('<app_prompt_section id="primary_prompt">')
    expect(prompt).toContain('<app_prompt_section id="user_memory">')
    expect(prompt.indexOf('id="project_browser"')).toBeLessThan(
      prompt.indexOf('id="user_memory"'),
    )
    expect(prompt.indexOf('id="background_processes"')).toBeLessThan(
      prompt.indexOf('id="user_memory"'),
    )
  })
})
