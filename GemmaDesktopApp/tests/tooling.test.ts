import { describe, expect, it } from 'vitest'
import {
  ACTIVATE_SKILL_TOOL,
  ASK_USER_TOOL,
  CONFIGURABLE_TOOL_NAME_SET,
  EXIT_PLAN_MODE_TOOL,
  LEGACY_ASK_PLAN_QUESTION_TOOL,
  LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
  PLAN_BUILD_ONLY_TOOL_NAMES,
  applyCoBrowseToolRoutingToModeSelection,
  buildBackgroundProcessInstructions,
  applyToolPolicyToModeSelection,
  buildCoBrowseToolInstructions,
  buildPlanOverlayModeSelection,
  clampModeSelectionToPlanOverlay,
  extractPlanBuildToolFromSurfaceError,
  getDefaultToolPolicySettings,
  isPlanBuildOnlyToolName,
  isCoBrowseSessionMetadata,
  isToolAllowedByPolicy,
  normalizeAppSessionMode,
  normalizePlanExitInput,
  normalizePlanQuestionInput,
  normalizeSkillActivationInput,
  normalizeToolPolicySettings,
  resolveBackgroundProcessWorkingDirectory,
  resolveAppSessionMode,
  sessionModeToConfig,
  withCoBrowseSessionMetadata,
  withoutCoBrowseSessionMetadata,
} from '../src/main/tooling'

describe('app tool helpers', () => {
  it('defines stable default tool policies for explore and build surfaces', () => {
    const defaults = getDefaultToolPolicySettings()

    expect(defaults.explore.allowedTools).toEqual(expect.arrayContaining([
      'search_paths',
      'inspect_file',
      'materialize_content',
      'read_content',
      'search_content',
      'read_file',
      'read_files',
      'search_web',
      ACTIVATE_SKILL_TOOL,
    ]))
    expect(defaults.explore.allowedTools).not.toEqual(expect.arrayContaining([
      'write_file',
      'edit_file',
      'exec_command',
    ]))
    expect(defaults.build.allowedTools).toEqual(expect.arrayContaining([
      'search_paths',
      'inspect_file',
      'materialize_content',
      'read_content',
      'search_content',
      'write_file',
      'edit_file',
      'exec_command',
      ACTIVATE_SKILL_TOOL,
    ]))
  })

  it('round-trips explore and build through stored session config metadata', () => {
    expect(sessionModeToConfig('explore')).toEqual({
      baseMode: 'explore',
      planMode: false,
    })
    expect(sessionModeToConfig('build')).toEqual({
      baseMode: 'build',
      planMode: false,
    })
    expect(resolveAppSessionMode(sessionModeToConfig('explore'))).toBe('explore')
    expect(resolveAppSessionMode(sessionModeToConfig('build'))).toBe('build')
    expect(normalizeAppSessionMode('not-a-mode')).toBe('explore')
    expect(normalizeAppSessionMode('cowork')).toBe('explore')
  })

  it('tracks configurable tool names in a shared lookup set', () => {
    expect(CONFIGURABLE_TOOL_NAME_SET.has('write_file')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('search_paths')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('inspect_file')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('materialize_content')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('read_content')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('search_content')).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has(ACTIVATE_SKILL_TOOL)).toBe(true)
    expect(CONFIGURABLE_TOOL_NAME_SET.has('definitely_not_a_real_tool')).toBe(false)
  })

  it('tracks plan build-only tool names and parses active-surface errors', () => {
    expect(PLAN_BUILD_ONLY_TOOL_NAMES).toEqual(expect.arrayContaining([
      'write_file',
      'edit_file',
      'exec_command',
      'workspace_editor_agent',
      'workspace_command_agent',
    ]))
    expect(isPlanBuildOnlyToolName('write_file')).toBe(true)
    expect(isPlanBuildOnlyToolName('read_file')).toBe(false)
    expect(
      extractPlanBuildToolFromSurfaceError(
        'Tool "write_file" is not registered in the active tool surface.',
      ),
    ).toBe('write_file')
    expect(
      extractPlanBuildToolFromSurfaceError(
        'Tool "read_file" is not registered in the active tool surface.',
      ),
    ).toBeUndefined()
  })

  it('normalizes tool policy settings by filtering unknown tool names', () => {
    const normalized = normalizeToolPolicySettings({
      explore: {
        allowedTools: ['search_web', 'not_real', 'read_file', 'search_paths'],
      },
      build: {
        allowedTools: ['exec_command', 'unknown_tool', 'read_file', 'search_paths'],
      },
    })

    expect(normalized.explore.allowedTools).toEqual(['search_paths', 'read_file', 'search_web'])
    expect(normalized.build.allowedTools).toEqual(['search_paths', 'read_file', 'exec_command'])
  })

  it('applies tool policy to mode selection by stripping blocked tools from tools and requiredTools', () => {
    const toolPolicy = normalizeToolPolicySettings({
      explore: {
        allowedTools: ['read_file', 'search_web'],
      },
      build: {
        allowedTools: ['read_file', 'search_web'],
      },
    })

    const mode = applyToolPolicyToModeSelection({
      base: 'build',
      tools: ['read_file', 'exec_command', 'search_web'],
      withoutTools: ['search_text'],
      requiredTools: ['exec_command', 'read_file'],
    }, 'build', toolPolicy)

    expect(typeof mode).not.toBe('string')
    const modeRecord = mode as Exclude<typeof mode, string>

    expect(modeRecord.base).toBe('build')
    expect(modeRecord.tools).toEqual(['read_file', 'search_web'])
    expect(modeRecord.withoutTools).toEqual(expect.arrayContaining([
      'search_text',
      'exec_command',
      'write_file',
      'edit_file',
    ]))
    expect(modeRecord.requiredTools).toEqual(['read_file'])
  })

  it('keeps known tool names blocked when the active mode policy does not allow them', () => {
    const toolPolicy = normalizeToolPolicySettings({
      explore: {
        allowedTools: ['read_file', 'search_web'],
      },
      build: {
        allowedTools: ['read_file', 'write_file', 'exec_command'],
      },
    })

    expect(isToolAllowedByPolicy('read_file', 'explore', toolPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('write_file', 'explore', toolPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('write_file', 'build', toolPolicy)).toBe(true)
  })

  it('routes CoBrowse web work through browser-backed search and the visible Project Browser surface', () => {
    const selection = applyCoBrowseToolRoutingToModeSelection({
      base: 'assistant',
      tools: ['browser', 'fetch_url', 'ask_gemini'],
      withoutTools: ['search_text', 'search_web'],
      requiredTools: ['ask_gemini'],
    }) as {
      base: string
      tools: string[]
      withoutTools: string[]
      requiredTools: string[]
    }

    expect(selection.base).toBe('assistant')
    expect(selection.tools).toEqual(expect.arrayContaining([
      'open_project_browser',
      'search_project_browser_dom',
      'get_project_browser_errors',
      'release_project_browser_to_user',
      'ask_gemini',
      'search_web',
    ]))
    expect(selection.tools).not.toEqual(expect.arrayContaining([
      'browser',
      'fetch_url',
    ]))
    expect(selection.withoutTools).toEqual(expect.arrayContaining([
      'browser',
      'fetch_url',
      'web_research_agent',
      'chrome_devtools',
    ]))
    expect(selection.withoutTools).not.toContain('search_web')
    expect(selection.requiredTools).toEqual(['ask_gemini'])
    expect(buildCoBrowseToolInstructions()).toContain(
      'search_web opens Google Search in the visible Project Browser',
    )
    expect(buildCoBrowseToolInstructions()).toContain(
      'release_project_browser_to_user',
    )
    expect(buildCoBrowseToolInstructions()).toContain(
      'use that exact URL instead of reconstructing or guessing',
    )

    const metadata = withCoBrowseSessionMetadata({ existing: true })
    expect(isCoBrowseSessionMetadata(metadata)).toBe(true)
    expect(isCoBrowseSessionMetadata({ existing: true })).toBe(false)
    expect(withoutCoBrowseSessionMetadata(metadata)).toEqual({ existing: true })
  })

  it('documents background process cwd usage for subdirectory commands', () => {
    const instructions = buildBackgroundProcessInstructions()

    expect(instructions).toContain('start_background_process')
    expect(instructions).toContain('"cwd": "blackhole02"')
    expect(instructions).toContain('Prefer cwd over shell directory changes')
  })

  it('resolves background process cwd inside the session workspace', () => {
    expect(resolveBackgroundProcessWorkingDirectory({
      workingDirectory: '/tmp/gemma-project',
    })).toBe('/tmp/gemma-project')
    expect(resolveBackgroundProcessWorkingDirectory({
      workingDirectory: '/tmp/gemma-project',
      cwd: 'blackhole02',
    })).toBe('/tmp/gemma-project/blackhole02')
    expect(resolveBackgroundProcessWorkingDirectory({
      workingDirectory: '/tmp/gemma-project',
      cwd: '/tmp/gemma-project/blackhole02',
    })).toBe('/tmp/gemma-project/blackhole02')
    expect(() => resolveBackgroundProcessWorkingDirectory({
      workingDirectory: '/tmp/gemma-project',
      cwd: '../elsewhere',
    })).toThrow('outside the working directory')
  })

  it('builds plan overlay mode as read-only plus plan interaction tools', () => {
    const selection = buildPlanOverlayModeSelection('build') as {
      base: string
      tools: string[]
      withoutTools: string[]
      requiredTools?: string[]
    }

    expect(selection.base).toBe('build')
    expect(selection.tools).toEqual(expect.arrayContaining([
      ASK_USER_TOOL,
      EXIT_PLAN_MODE_TOOL,
      LEGACY_ASK_PLAN_QUESTION_TOOL,
      LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
    ]))
    expect(selection.requiredTools ?? []).toEqual([])
    expect(selection.withoutTools).toEqual(expect.arrayContaining([
      'write_file',
      'edit_file',
      'exec_command',
      'materialize_content',
      'workspace_editor_agent',
      'workspace_command_agent',
      'web_research_agent',
    ]))
  })

  it('clamps arbitrary mode selections to the fixed plan overlay surface', () => {
    const selection = clampModeSelectionToPlanOverlay({
      base: 'cowork',
      tools: ['read_file', 'write_file', ASK_USER_TOOL, EXIT_PLAN_MODE_TOOL],
      requiredTools: ['write_file', ASK_USER_TOOL],
    }) as {
      base: string
      tools: string[]
      withoutTools: string[]
      requiredTools: string[]
    }

    expect(selection.base).toBe('explore')
    expect(selection.tools).toEqual([
      'read_file',
      ASK_USER_TOOL,
      EXIT_PLAN_MODE_TOOL,
    ])
    expect(selection.requiredTools).toEqual([ASK_USER_TOOL])
    expect(selection.withoutTools).toEqual(expect.arrayContaining([
      'write_file',
      'edit_file',
      'exec_command',
      'workspace_editor_agent',
      'workspace_command_agent',
    ]))
  })

  it('normalizes plan question inputs from loose object shapes', () => {
    const normalized = normalizePlanQuestionInput({
      prompt: 'Which runtime should we target?',
      description: 'We need one default for the first pass.',
      choices: ['Ollama', 'LM Studio'],
      hint: 'Pick one runtime.',
    })

    expect(normalized).toEqual({
      question: 'Which runtime should we target?',
      details: 'We need one default for the first pass.',
      options: ['Ollama', 'LM Studio'],
      placeholder: 'Pick one runtime.',
    })
  })

  it('splits malformed multiline plan options into separate choices', () => {
    const normalized = normalizePlanQuestionInput({
      question: 'What celestial bodies should we include?',
      options: [
        '8 planets only\nPlanet Sun + 8 planets + asteroid belt\nEverything else',
      ],
    })

    expect(normalized).toEqual({
      question: 'What celestial bodies should we include?',
      details: undefined,
      options: [
        '8 planets only',
        'Planet Sun + 8 planets + asteroid belt',
        'Everything else',
      ],
      placeholder: undefined,
    })
  })

  it('normalizes plan exit inputs and maps work mode aliases', () => {
    const normalized = normalizePlanExitInput({
      plan: 'Ship the SDK patch.',
      nextStep: 'Switch back to build work and implement the fix.',
      recommendedMode: 'build',
    })

    expect(normalized).toEqual({
      summary: 'Ship the SDK patch.',
      details: 'Switch back to build work and implement the fix.',
      workMode: 'build',
    })
  })

  it('normalizes skill activation inputs from labeled activation ids', () => {
    const normalized = normalizeSkillActivationInput({
      raw: 'activation id: github:gh-fix-ci\nreason: CI is failing on the PR',
      context: 'CI is failing on the PR',
    })

    expect(normalized).toEqual({
      skillId: 'github:gh-fix-ci',
      reason: 'CI is failing on the PR',
    })
  })
})
