import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ASK_USER_TOOL,
  EXIT_PLAN_MODE_TOOL,
  LEGACY_ASK_PLAN_QUESTION_TOOL,
  LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
  PLAN_BUILD_ONLY_TOOL_NAMES,
  type BaseSessionMode,
} from './tooling'

export type ChatPromptMode = 'assistant' | 'explore' | 'build'

const CHAT_PROMPT_ID_BY_MODE: Record<ChatPromptMode, string> = {
  assistant: 'assistant',
  explore: 'explore',
  build: 'act',
}

type PromptReadOptions = {
  allowEmpty?: boolean
  optional?: boolean
}

type PromptSectionSpec = PromptReadOptions & {
  promptId: string
}

export type AppSystemInstructionSectionId =
  | 'primary_prompt'
  | 'skill_catalog'
  | 'preloaded_skills'
  | 'session_tools'
  | 'cobrowse_tools'
  | 'project_browser'
  | 'background_processes'
  | 'user_memory'

export type AppSystemInstructionInput = {
  primaryPrompt?: string
  skillCatalog?: string
  preloadedSkills?: string
  sessionTools?: string
  coBrowseTools?: string
  projectBrowser?: string
  backgroundProcesses?: string
  userMemory?: string
}

const APP_SYSTEM_CONTEXT_TAG = 'gemma_desktop_app_context'
const APP_PROMPT_SECTION_TAG = 'app_prompt_section'

function resolveBundledPromptsDirectory(): string {
  return path.resolve(__dirname, '../../resources/prompts')
}

function resolveExternalPromptsDirectory(): string | null {
  if (typeof process.resourcesPath !== 'string' || process.resourcesPath.length === 0) {
    return null
  }

  return path.join(process.resourcesPath, 'resources', 'prompts')
}

export function listPromptMarkdownCandidatePaths(promptId: string): string[] {
  const fileName = `${promptId}.md`
  const candidates = [
    resolveExternalPromptsDirectory(),
    resolveBundledPromptsDirectory(),
  ]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .map((directory) => path.join(directory, fileName))

  return Array.from(new Set(candidates))
}

export function readPromptMarkdown(promptId: string): string {
  return readPromptMarkdownWithOptions(promptId)
}

function readPromptMarkdownWithOptions(
  promptId: string,
  options: PromptReadOptions = {},
): string {
  const { allowEmpty = false, optional = false } = options
  const candidates = listPromptMarkdownCandidatePaths(promptId)

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue
    }

    const text = readFileSync(filePath, 'utf8').trim()
    if (text.length === 0) {
      if (allowEmpty) {
        return ''
      }

      throw new Error(`Prompt markdown is empty: ${filePath}`)
    }

    return text
  }

  if (optional) {
    return ''
  }

  throw new Error(
    `Missing prompt markdown for "${promptId}". Looked in: ${candidates.join(', ')}`,
  )
}

function renderPromptMarkdown(
  promptId: string,
  replacements?: Record<string, string>,
  options?: PromptReadOptions,
): string {
  const template = readPromptMarkdownWithOptions(promptId, options)
  if (!replacements) {
    return template
  }

  return template.replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (match, key: string) =>
    replacements[key] ?? match)
}

function composePromptMarkdown(
  sections: PromptSectionSpec[],
  replacements?: Record<string, string>,
): string {
  return sections
    .map((section) =>
      renderPromptMarkdown(section.promptId, replacements, {
        allowEmpty: section.allowEmpty,
        optional: section.optional,
      }),
    )
    .filter((entry) => entry.trim().length > 0)
    .join('\n\n')
}

function escapePromptAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderAppPromptSection(
  id: AppSystemInstructionSectionId,
  text: string | undefined,
): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) {
    return undefined
  }

  return [
    `<${APP_PROMPT_SECTION_TAG} id="${escapePromptAttribute(id)}">`,
    trimmed,
    `</${APP_PROMPT_SECTION_TAG}>`,
  ].join('\n')
}

export function composeAppSystemInstructions(
  input: AppSystemInstructionInput,
): string | undefined {
  const sections = [
    renderAppPromptSection('primary_prompt', input.primaryPrompt),
    renderAppPromptSection('skill_catalog', input.skillCatalog),
    renderAppPromptSection('preloaded_skills', input.preloadedSkills),
    renderAppPromptSection('session_tools', input.sessionTools),
    renderAppPromptSection('cobrowse_tools', input.coBrowseTools),
    renderAppPromptSection('project_browser', input.projectBrowser),
    renderAppPromptSection('background_processes', input.backgroundProcesses),
    renderAppPromptSection('user_memory', input.userMemory),
  ].filter((entry): entry is string => Boolean(entry))

  if (sections.length === 0) {
    return undefined
  }

  return [
    `<${APP_SYSTEM_CONTEXT_TAG}>`,
    sections.join('\n\n'),
    `</${APP_SYSTEM_CONTEXT_TAG}>`,
  ].join('\n')
}

function resolveChatPromptId(mode: ChatPromptMode): string {
  return CHAT_PROMPT_ID_BY_MODE[mode]
}

function renderBaseModeLabel(baseMode: BaseSessionMode): string {
  return baseMode === 'build' ? 'act' : baseMode
}

export function getChatSystemInstructions(
  mode: ChatPromptMode,
): string {
  return composePromptMarkdown([
    { promptId: 'baseline' },
    { promptId: resolveChatPromptId(mode), allowEmpty: true, optional: true },
  ])
}

export function getPlanningSystemInstructions(
  baseMode: BaseSessionMode,
): string {
  return composePromptMarkdown(
    [
      { promptId: 'baseline' },
      { promptId: 'plan' },
    ],
    {
      BASE_MODE: baseMode,
      BASE_MODE_LABEL: renderBaseModeLabel(baseMode),
      ASK_USER_TOOL,
      EXIT_PLAN_MODE_TOOL,
      LEGACY_ASK_PLAN_QUESTION_TOOL,
      LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
      PLAN_BUILD_ONLY_TOOLS: PLAN_BUILD_ONLY_TOOL_NAMES.join(', '),
    },
  )
}
