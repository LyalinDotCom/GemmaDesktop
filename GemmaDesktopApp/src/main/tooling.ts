import type { ModeSelection } from '@gemma-desktop/sdk-core'
import path from 'path'
import { parseToolCallInput } from '@gemma-desktop/sdk-core'
import {
  GET_PROJECT_BROWSER_ERRORS_TOOL,
  OPEN_PROJECT_BROWSER_TOOL,
  PROJECT_BROWSER_TOOL_NAMES,
  RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
  SEARCH_PROJECT_BROWSER_DOM_TOOL,
} from '../shared/projectBrowser'
import {
  PEEK_BACKGROUND_PROCESS_TOOL,
  START_BACKGROUND_PROCESS_TOOL,
  TERMINATE_BACKGROUND_PROCESS_TOOL,
} from '../shared/backgroundProcesses'

export type BaseSessionMode = 'explore' | 'build'
export type AppSessionMode = BaseSessionMode
export type AppToolPolicyMode = AppSessionMode
export type ConversationKind = 'normal' | 'research'
export type SdkSessionMode = 'explore' | 'build'

export type AppToolPolicyConfig = {
  [mode in AppToolPolicyMode]: {
    allowedTools: string[]
  }
}

export const ASK_USER_TOOL = 'ask_user'
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'
export const LEGACY_ASK_PLAN_QUESTION_TOOL = 'ask_plan_question'
export const LEGACY_PREPARE_PLAN_EXECUTION_TOOL = 'prepare_plan_execution'
export const ACTIVATE_SKILL_TOOL = 'activate_skill'
export const SEARCH_WEB_TOOL = 'search_web'
export const PLAN_BUILD_ONLY_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'exec_command',
  'workspace_editor_agent',
  'workspace_command_agent',
] as const
export const COBROWSE_SESSION_METADATA_KEY = 'coBrowse'
export const COBROWSE_BLOCKED_WEB_TOOL_NAMES = [
  'browser',
  'fetch_url',
  'web_research_agent',
  'chrome_devtools',
] as const
export const COBROWSE_TOOL_NAMES = [
  SEARCH_WEB_TOOL,
  ...PROJECT_BROWSER_TOOL_NAMES,
  RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
] as const

const PLAN_BUILD_ONLY_TOOL_NAME_SET = new Set<string>(
  PLAN_BUILD_ONLY_TOOL_NAMES,
)

export const CONFIGURABLE_TOOL_NAMES = [
  'list_tree',
  'search_paths',
  'search_text',
  'inspect_file',
  'materialize_content',
  'read_content',
  'search_content',
  'read_file',
  'read_files',
  'write_file',
  'edit_file',
  'exec_command',
  'fetch_url',
  SEARCH_WEB_TOOL,
  'workspace_inspector_agent',
  'workspace_search_agent',
  'workspace_editor_agent',
  'workspace_command_agent',
  'web_research_agent',
  ACTIVATE_SKILL_TOOL,
] as const

export const PLAN_OVERLAY_ALLOWED_TOOL_NAMES = [
  'list_tree',
  'search_paths',
  'search_text',
  'inspect_file',
  'read_content',
  'search_content',
  'read_file',
  'read_files',
  'fetch_url',
  SEARCH_WEB_TOOL,
  'browser',
  ASK_USER_TOOL,
  EXIT_PLAN_MODE_TOOL,
  LEGACY_ASK_PLAN_QUESTION_TOOL,
  LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
] as const

export const CONFIGURABLE_TOOL_NAME_SET = new Set<string>(CONFIGURABLE_TOOL_NAMES)

const PLAN_OVERLAY_ALLOWED_TOOL_NAME_SET = new Set<string>(
  PLAN_OVERLAY_ALLOWED_TOOL_NAMES,
)

const ALL_KNOWN_APP_TOOL_NAMES = [
  ...CONFIGURABLE_TOOL_NAMES,
  ...PLAN_OVERLAY_ALLOWED_TOOL_NAMES,
] as const

type ModeSelectionSpec = {
  base: BaseSessionMode
  tools: string[]
  withoutTools: string[]
  requiredTools: string[]
}

function toModeSelectionSpec(mode: ModeSelection): ModeSelectionSpec {
  return typeof mode === 'string'
    ? {
        base: normalizeBaseSessionMode(mode, 'build'),
        tools: [],
        withoutTools: [],
        requiredTools: [],
      }
    : {
        base: normalizeBaseSessionMode(mode.base, 'build'),
        tools: [...(mode.tools ?? [])],
        withoutTools: [...(mode.withoutTools ?? [])],
        requiredTools: [...(mode.requiredTools ?? [])],
      }
}

export function getDefaultToolPolicySettings(): AppToolPolicyConfig {
  return {
    explore: {
      allowedTools: [
        'list_tree',
        'search_paths',
        'search_text',
        'inspect_file',
        'materialize_content',
        'read_content',
        'search_content',
        'read_file',
        'read_files',
        'fetch_url',
        SEARCH_WEB_TOOL,
        'workspace_inspector_agent',
        'workspace_search_agent',
        'web_research_agent',
        ACTIVATE_SKILL_TOOL,
      ],
    },
    build: {
      allowedTools: [
        'list_tree',
        'search_paths',
        'search_text',
        'inspect_file',
        'materialize_content',
        'read_content',
        'search_content',
        'read_file',
        'read_files',
        'write_file',
        'edit_file',
        'exec_command',
        'fetch_url',
        SEARCH_WEB_TOOL,
        'workspace_inspector_agent',
        'workspace_search_agent',
        'workspace_editor_agent',
        'workspace_command_agent',
        'web_research_agent',
        ACTIVATE_SKILL_TOOL,
      ],
    },
  }
}

export function normalizeAllowedToolNames(
  value: unknown,
  fallback: string[],
): string[] {
  const requested = Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && CONFIGURABLE_TOOL_NAME_SET.has(entry),
      )
    : fallback
  const requestedSet = new Set(requested)

  return CONFIGURABLE_TOOL_NAMES.filter((name) => requestedSet.has(name))
}

export function isPlanBuildOnlyToolName(toolName: string): boolean {
  return PLAN_BUILD_ONLY_TOOL_NAME_SET.has(toolName.trim())
}

export function extractPlanBuildToolFromSurfaceError(
  errorMessage: string,
): string | undefined {
  const match = /^Tool "([^"]+)" is not registered in the active tool surface\.$/.exec(
    errorMessage.trim(),
  )
  const toolName = match?.[1]?.trim()

  if (!toolName || !isPlanBuildOnlyToolName(toolName)) {
    return undefined
  }

  return toolName
}

export function normalizeToolPolicySettings(
  value: unknown,
  fallback: AppToolPolicyConfig = getDefaultToolPolicySettings(),
): AppToolPolicyConfig {
  const record =
    value && typeof value === 'object'
      ? value as Partial<Record<AppToolPolicyMode | 'cowork', { allowedTools?: unknown }>>
      : {}

  return {
    explore: {
      allowedTools: normalizeAllowedToolNames(
        record.explore?.allowedTools ?? record.cowork?.allowedTools,
        fallback.explore.allowedTools,
      ),
    },
    build: {
      allowedTools: normalizeAllowedToolNames(
        record.build?.allowedTools,
        fallback.build.allowedTools,
      ),
    },
  }
}

export function isAppSessionMode(value: unknown): value is AppSessionMode {
  return value === 'explore' || value === 'build'
}

export function normalizeAppSessionMode(
  value: unknown,
  fallback: AppSessionMode = 'explore',
): AppSessionMode {
  if (value === 'cowork') {
    return 'explore'
  }

  return isAppSessionMode(value) ? value : fallback
}

export function toSdkSessionMode(mode: AppSessionMode): SdkSessionMode {
  return mode
}

export function sessionModeToConfig(mode: AppSessionMode): {
  baseMode: BaseSessionMode
  planMode: boolean
} {
  return {
    baseMode: mode,
    planMode: false,
  }
}

export function resolveAppSessionMode(input: {
  baseMode: BaseSessionMode
}): AppSessionMode {
  return input.baseMode
}

export function resolveToolPolicyMode(mode: AppSessionMode): AppToolPolicyMode {
  return mode
}

export function isToolAllowedByPolicy(
  toolName: string,
  toolMode: AppToolPolicyMode,
  toolPolicy: AppToolPolicyConfig,
): boolean {
  return toolPolicy[toolMode].allowedTools.includes(toolName)
}

export function applyToolPolicyToModeSelection(
  mode: ModeSelection,
  toolMode: AppToolPolicyMode,
  toolPolicy: AppToolPolicyConfig,
): ModeSelection {
  const spec = toModeSelectionSpec(mode)
  const allowedSet = new Set(toolPolicy[toolMode].allowedTools)
  const blockedTools = CONFIGURABLE_TOOL_NAMES.filter(
    (name) => !allowedSet.has(name),
  )

  return {
    base: toSdkSessionMode(spec.base),
    tools: spec.tools.filter((name) => allowedSet.has(name)),
    withoutTools: Array.from(
      new Set([...spec.withoutTools, ...blockedTools]),
    ),
    requiredTools: spec.requiredTools.filter((name) =>
      allowedSet.has(name),
    ),
  }
}

export function applyCoBrowseToolRoutingToModeSelection(
  mode: ModeSelection,
): ModeSelection {
  const spec = typeof mode === 'string'
    ? {
        base: mode,
        tools: [] as string[],
        withoutTools: [] as string[],
        requiredTools: [] as string[],
      }
    : {
        base: mode.base ?? 'explore',
        tools: [...(mode.tools ?? [])],
        withoutTools: [...(mode.withoutTools ?? [])],
        requiredTools: [...(mode.requiredTools ?? [])],
      }
  const blockedToolNames = new Set<string>(COBROWSE_BLOCKED_WEB_TOOL_NAMES)
  const coBrowseToolNames = new Set<string>(COBROWSE_TOOL_NAMES)

  return {
    base: spec.base,
    tools: Array.from(
      new Set([
        ...spec.tools.filter((toolName) => !blockedToolNames.has(toolName)),
        ...COBROWSE_TOOL_NAMES,
      ]),
    ),
    withoutTools: Array.from(
      new Set([
        ...spec.withoutTools.filter((toolName) => !coBrowseToolNames.has(toolName)),
        ...COBROWSE_BLOCKED_WEB_TOOL_NAMES,
      ]),
    ),
    requiredTools: Array.from(
      new Set([
        ...spec.requiredTools.filter((toolName) => !blockedToolNames.has(toolName)),
      ]),
    ),
  }
}

export function buildCoBrowseToolInstructions(): string {
  return [
    'CoBrowse is active.',
    'The visible browser is read-only for the user while the agent owns browser control.',
    'For web search, use search_web. In CoBrowse only, search_web opens Google Search in the visible Project Browser instead of using grounded Gemini API search.',
    'For known web pages, websites, URLs, browser flows, logins, CAPTCHA checks, or page interaction, use the visible Project Browser tools only.',
    'Do not use the managed browser, Chrome DevTools, fetch_url, or web_research_agent while CoBrowse is active.',
    `Use ${OPEN_PROJECT_BROWSER_TOOL} to open or refresh the visible browser for the requested http or https URL.`,
    `Use ${SEARCH_PROJECT_BROWSER_DOM_TOOL} to inspect the current visible page after it loads. When a DOM result includes href, use that exact URL instead of reconstructing or guessing a link.`,
    `Use ${GET_PROJECT_BROWSER_ERRORS_TOOL} when page load or console errors may explain a blocker.`,
    `If the visible page shows a CAPTCHA, bot block, login challenge, 2FA prompt, payment gate, or permission prompt, call ${RELEASE_PROJECT_BROWSER_TO_USER_TOOL} with a short reason and ask the user to complete it in the visible browser.`,
    'After control is released to the user, browser/search/DOM/error tools are blocked until the user clicks Release control.',
    'If a Project Browser tool reports that control is held by the user, stop and wait for the user to release control before using browser tools again.',
  ].join('\n')
}

function workspaceRelativePath(workingDirectory: string, absolutePath: string): string | null {
  const relative = path.relative(workingDirectory, absolutePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? relative
    : null
}

export function resolveBackgroundProcessWorkingDirectory(input: {
  workingDirectory: string
  cwd?: unknown
}): string {
  const workingDirectory = path.resolve(input.workingDirectory)
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''

  if (cwd.length === 0 || cwd === '.') {
    return workingDirectory
  }

  const resolved = path.resolve(workingDirectory, cwd)
  if (workspaceRelativePath(workingDirectory, resolved) === null) {
    throw new Error(
      `Refusing to start background process outside the working directory: ${resolved}`,
    )
  }

  return resolved
}

export function buildBackgroundProcessInstructions(): string {
  return [
    'Background process tools are available in Build conversations for long-running local tasks such as dev servers, watchers, and downloads.',
    `- Use ${START_BACKGROUND_PROCESS_TOOL} to start one conversation-scoped process with a command like "npm run dev".`,
    `- If the command must run from a subdirectory, pass cwd as a path relative to the session workspace, for example { "command": "npm run dev", "cwd": "blackhole02" }. Prefer cwd over shell directory changes like "cd blackhole02 && npm run dev".`,
    `- Use ${PEEK_BACKGROUND_PROCESS_TOOL} with the returned processId to check whether it is still running and inspect a bounded output tail without flooding context.`,
    '- When you start a dev server or watcher for the user to inspect, leave it running after verification and tell the user the process is still active.',
    `- Use ${TERMINATE_BACKGROUND_PROCESS_TOOL} only when the user asks you to stop it, the process is harmful/stuck, or you must stop it before switching tasks.`,
    '- Treat peek output as a tail, not a full transcript. If the tool says output was truncated, poll again only when you need a fresher snapshot.',
  ].join('\n')
}

export function withCoBrowseSessionMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    [COBROWSE_SESSION_METADATA_KEY]: {
      active: true,
    },
  }
}

export function withoutCoBrowseSessionMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const nextMetadata = { ...metadata }
  delete nextMetadata[COBROWSE_SESSION_METADATA_KEY]
  return nextMetadata
}

export function isCoBrowseSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const value = metadata?.[COBROWSE_SESSION_METADATA_KEY]
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { active?: unknown }).active === true,
  )
}

export function isBaseSessionMode(value: unknown): value is BaseSessionMode {
  return isAppSessionMode(value) || value === 'cowork'
}

export function normalizeBaseSessionMode(
  value: unknown,
  fallback: BaseSessionMode = 'build',
): BaseSessionMode {
  if (value === 'cowork') {
    return 'explore'
  }

  return isAppSessionMode(value) ? value : fallback
}

export function clampModeSelectionToPlanOverlay(
  mode: ModeSelection,
): ModeSelection {
  const spec = toModeSelectionSpec(mode)
  const blockedTools = ALL_KNOWN_APP_TOOL_NAMES.filter(
    (name) => !PLAN_OVERLAY_ALLOWED_TOOL_NAME_SET.has(name),
  )

  return {
    base: toSdkSessionMode(spec.base),
    tools: Array.from(
      new Set(
        spec.tools.filter((name) => PLAN_OVERLAY_ALLOWED_TOOL_NAME_SET.has(name)),
      ),
    ),
    withoutTools: Array.from(
      new Set([...spec.withoutTools, ...blockedTools]),
    ),
    requiredTools: spec.requiredTools.filter((name) =>
      PLAN_OVERLAY_ALLOWED_TOOL_NAME_SET.has(name),
    ),
  }
}

export function buildPlanOverlayModeSelection(
  baseMode: BaseSessionMode,
): ModeSelection {
  return clampModeSelectionToPlanOverlay({
    base: toSdkSessionMode(baseMode),
    tools: [
      ASK_USER_TOOL,
      EXIT_PLAN_MODE_TOOL,
      LEGACY_ASK_PLAN_QUESTION_TOOL,
      LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
    ],
  })
}

export function valueToText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => valueToText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
      .trim()
    return joined.length > 0 ? joined : undefined
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const normalized = valueToText(entry)
        return normalized ? `${key}: ${normalized}` : undefined
      })
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
      .trim()

    if (entries.length > 0) {
      return entries
    }

    try {
      const serialized = JSON.stringify(value)
      return serialized && serialized !== '{}' ? serialized : undefined
    } catch {
      return undefined
    }
  }

  return undefined
}

export function valueToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => valueToStringArray(entry))
      .filter((entry, index, values) => values.indexOf(entry) === index)
  }

  const text = valueToText(value)
  if (!text) return []

  const lines = text
    .split(/\r?\n|(?:\s*[•*-]\s+)/)
    .map((entry) => entry.trim())
    .filter(Boolean)

  return (lines.length > 1 ? lines : [text])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index)
}

export function normalizePlanToolRecord(input: unknown): Record<string, unknown> {
  const parsed = parseToolCallInput(input)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }

  if (typeof parsed === 'string') {
    return {
      raw: parsed,
    }
  }

  return {}
}

export function normalizePlanQuestionInput(input: unknown): {
  question: string
  details?: string
  options: string[]
  placeholder?: string
} {
  const record = normalizePlanToolRecord(input)
  const fallbackText = valueToText(record.raw ?? input)
  const question =
    valueToText(record.question ?? record.prompt ?? record.title)
    ?? fallbackText
    ?? 'What should the plan do next?'
  const details =
    valueToText(record.details ?? record.context ?? record.description)
    ?? undefined
  const options = valueToStringArray(record.options ?? record.choices ?? record.answers)
  const placeholder =
    valueToText(record.placeholder ?? record.hint ?? record.exampleAnswer)
    ?? undefined

  return {
    question,
    details,
    options,
    placeholder,
  }
}

export function normalizePlanExitInput(input: unknown): {
  summary: string
  details?: string
  workMode: AppSessionMode
} {
  const record = normalizePlanToolRecord(input)
  const fallbackText = valueToText(record.raw ?? input)
  const summary =
    valueToText(record.summary ?? record.plan ?? record.title)
    ?? fallbackText
    ?? 'Plan ready to switch back to work mode.'
  const details =
    valueToText(
      record.details
      ?? record.executionPrompt
      ?? record.prompt
      ?? record.instructions
      ?? record.description
      ?? record.nextStep,
    )
    ?? undefined
  const workMode = normalizeAppSessionMode(
    record.workMode
    ?? record.recommendedMode
    ?? record.mode,
    'build',
  )

  return {
    summary,
    details,
    workMode,
  }
}

export function normalizeSkillActivationInput(input: unknown): {
  skillId?: string
  reason?: string
} {
  const record = normalizePlanToolRecord(input)
  const normalizeSkillIdentifier = (value: unknown): string | undefined => {
    const text = valueToText(value)
    if (!text) {
      return undefined
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^['"`]+|['"`]+$/g, ''))
      .filter(Boolean)

    for (const line of lines) {
      const labeledMatch = line.match(
        /^(?:activation(?:[_\s-]?id)?|skill(?:[_\s-]?id)?|id)\s*:\s*(.+)$/i,
      )
      if (labeledMatch?.[1]) {
        return labeledMatch[1].trim()
      }

      if (/^[a-z0-9-]+:[a-z0-9._/-]+$/i.test(line)) {
        return line
      }
    }

    return text.trim().replace(/^['"`]+|['"`]+$/g, '')
  }

  return {
    skillId: normalizeSkillIdentifier(
      record.skillId
      ?? record.skill_id
      ?? record.skill
      ?? record['skill id']
      ?? record.activationId
      ?? record.activation_id
      ?? record.activation
      ?? record['activation id']
      ?? record.name
      ?? record.id
      ?? record.path
      ?? record.location
      ?? record.raw
      ?? input,
    ),
    reason:
      valueToText(record.reason ?? record.goal ?? record.context)
      ?? undefined,
  }
}
