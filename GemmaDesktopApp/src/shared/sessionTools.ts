export type SessionToolIcon = 'bug' | 'globe' | 'sparkles'
export type SupportedSessionToolPlatform = 'darwin' | 'linux' | 'win32'

export interface SessionToolDefinition {
  id: string
  slug: string
  name: string
  description: string
  icon: SessionToolIcon
  instructions: string
  supportedPlatforms: SupportedSessionToolPlatform[]
  toolNames: string[]
  planModeSafe?: boolean
}

export interface SessionToolAvailabilityInput {
  chromeMcpEnabled: boolean
  chromeDevtoolsAllowed?: boolean
}

export interface SessionToolScopeInput {
  chromeMcpEnabled: boolean
  conversationKind: 'normal' | 'research'
  workMode: 'explore' | 'build'
  planMode: boolean
  surface?: 'default' | 'assistant'
}

export const CHROME_DEVTOOLS_SESSION_TOOL_ID = 'chrome-devtools'
export const ASK_GEMINI_SESSION_TOOL_ID = 'ask-gemini'
export const CHROME_BROWSER_TOOL_NAME = 'browser'
export const CHROME_BROWSER_TOOL_NAMES = [CHROME_BROWSER_TOOL_NAME] as const
export const CHROME_BROWSER_TOOL_NAME_SET = new Set<string>(
  CHROME_BROWSER_TOOL_NAMES,
)
export const CHROME_DEVTOOLS_TOOL_NAME = 'chrome_devtools'
export const CHROME_DEVTOOLS_TOOL_NAMES = [CHROME_DEVTOOLS_TOOL_NAME] as const
export const CHROME_DEVTOOLS_TOOL_NAME_SET = new Set<string>(
  CHROME_DEVTOOLS_TOOL_NAMES,
)
export const ASK_GEMINI_TOOL_NAME = 'ask_gemini'
export const ASK_GEMINI_TOOL_NAMES = [ASK_GEMINI_TOOL_NAME] as const
export const ASK_GEMINI_TOOL_NAME_SET = new Set<string>(
  ASK_GEMINI_TOOL_NAMES,
)

const SESSION_TOOL_DEFINITIONS: readonly SessionToolDefinition[] = [
  {
    id: CHROME_DEVTOOLS_SESSION_TOOL_ID,
    slug: 'chrome-devtools',
    name: 'Chrome DevTools',
    description:
      'Attach to your live Chrome session for advanced debugging, console and network inspection, and targeted page evaluation.',
    icon: 'bug',
    instructions: [
      'Chrome DevTools is enabled for this conversation.',
      'Use chrome_devtools only for advanced Chrome debugging such as console inspection, network inspection, page evaluation, or when the user explicitly asks for Chrome DevTools.',
      'Prefer browser for normal website navigation, reading, trackers, and multi-step site flows. Escalate to chrome_devtools when browser is not enough and you need true DevTools-style inspection inside a live Chrome session.',
      'Chrome DevTools actions that mutate the page may require approval. If approval is denied or Chrome is unavailable, explain the blocker clearly and continue with browser or other tools when possible.',
    ].join('\n'),
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    toolNames: [...CHROME_DEVTOOLS_TOOL_NAMES],
  },
  {
    id: ASK_GEMINI_SESSION_TOOL_ID,
    slug: 'ask-gemini',
    name: 'Ask Gemini',
    description:
      'Ask the locally installed Gemini CLI for a second opinion in headless read-only mode.',
    icon: 'sparkles',
    instructions: [
      'Ask Gemini access is enabled for this conversation.',
      'Use ask_gemini when a second opinion, external perspective, or another model pass would materially help.',
      'Ask one detailed, self-contained question that includes the relevant context, constraints, goals, and file names when they matter.',
      'Treat Gemini output as advisory input, not ground truth. Verify important claims against the workspace, runtime evidence, or other tools before making risky changes.',
      'If ask_gemini returns ok=false, explain the soft failure briefly, mention the tool issue if relevant, and continue with the best local path you have.',
    ].join('\n'),
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    toolNames: [...ASK_GEMINI_TOOL_NAMES],
    planModeSafe: true,
  },
] as const

function isSupportedOnCurrentPlatform(
  definition: SessionToolDefinition,
): boolean {
  const platform = detectCurrentPlatform()
  if (!platform) {
    return false
  }

  return (
    definition.supportedPlatforms.includes(platform)
  )
}

function detectCurrentPlatform(): SupportedSessionToolPlatform | null {
  if (typeof process !== 'undefined') {
    const platform = process.platform
    if (
      platform === 'darwin'
      || platform === 'linux'
      || platform === 'win32'
    ) {
      return platform
    }
  }

  if (typeof navigator !== 'undefined') {
    const userAgent = navigator.userAgent.toLowerCase()
    if (userAgent.includes('mac os x')) {
      return 'darwin'
    }
    if (userAgent.includes('windows')) {
      return 'win32'
    }
    if (userAgent.includes('linux')) {
      return 'linux'
    }
  }

  return null
}

function isSessionToolEnabled(
  definition: SessionToolDefinition,
  input: SessionToolAvailabilityInput,
): boolean {
  if (definition.id === CHROME_DEVTOOLS_SESSION_TOOL_ID) {
    return input.chromeMcpEnabled && input.chromeDevtoolsAllowed !== false
  }

  if (definition.id === ASK_GEMINI_SESSION_TOOL_ID) {
    return true
  }

  return false
}

export function getSessionToolDefinitions(
  input: SessionToolAvailabilityInput,
): SessionToolDefinition[] {
  return SESSION_TOOL_DEFINITIONS.filter(
    (definition) =>
      isSupportedOnCurrentPlatform(definition)
      && isSessionToolEnabled(definition, input),
  )
}

export function getScopedSessionToolDefinitions(
  input: SessionToolScopeInput,
): SessionToolDefinition[] {
  const chromeDevtoolsAllowed =
    input.surface !== 'assistant'
    && input.conversationKind === 'normal'
    && input.workMode === 'build'
    && !input.planMode

  return getSessionToolDefinitions({
    chromeMcpEnabled: input.chromeMcpEnabled,
    chromeDevtoolsAllowed,
  })
}

export function resolveSelectedSessionTools(
  selectedToolIds: string[],
  input: SessionToolAvailabilityInput,
): SessionToolDefinition[] {
  const available = getSessionToolDefinitions(input)
  const selected = new Set(selectedToolIds)
  return available.filter((definition) => selected.has(definition.id))
}

export function getSelectedSessionToolNames(
  selectedToolIds: string[],
  input: SessionToolAvailabilityInput,
): string[] {
  return resolveSelectedSessionTools(selectedToolIds, input).map(
    (definition) => definition.name,
  )
}

export function getSelectedSessionToolIds(
  selectedToolIds: string[],
  input: SessionToolAvailabilityInput,
): string[] {
  return resolveSelectedSessionTools(selectedToolIds, input).map(
    (definition) => definition.id,
  )
}

export function getSelectedSessionToolInstructions(
  selectedToolIds: string[],
  input: SessionToolAvailabilityInput,
): string | undefined {
  const instructions = resolveSelectedSessionTools(selectedToolIds, input)
    .map((definition) => definition.instructions.trim())
    .filter(Boolean)

  if (instructions.length === 0) {
    return undefined
  }

  return instructions.join('\n\n')
}

export function getSelectedSessionToolNamesAndIds(
  selectedToolIds: string[],
  input: SessionToolAvailabilityInput,
): {
  selectedToolIds: string[]
  selectedToolNames: string[]
} {
  const selected = resolveSelectedSessionTools(selectedToolIds, input)
  return {
    selectedToolIds: selected.map((definition) => definition.id),
    selectedToolNames: selected.map((definition) => definition.name),
  }
}

export function getDefaultSelectedSessionToolIds(_input: {
  chromeMcpEnabled: boolean
  chromeMcpDefaultSelected: boolean
}): string[] {
  return []
}
