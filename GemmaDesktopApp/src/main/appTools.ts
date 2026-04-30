import { randomUUID } from 'crypto'
import path from 'path'
import {
  renderWorkspaceReadFile,
  renderWorkspaceReadFiles,
  type RegisteredTool,
} from '@gemma-desktop/sdk-tools'
import type {
  ConversationApprovalMode,
  JsonSchema,
  ModeSelection,
} from '@gemma-desktop/sdk-core'
import {
  ACTIVATE_SKILL_TOOL,
  ASK_USER_TOOL,
  EXIT_PLAN_MODE_TOOL,
  LEGACY_ASK_PLAN_QUESTION_TOOL,
  LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
  normalizePlanExitInput,
  normalizePlanQuestionInput,
  normalizeSkillActivationInput,
  resolveBackgroundProcessWorkingDirectory,
  isCoBrowseSessionMetadata,
  type AppSessionMode,
  type BaseSessionMode,
} from './tooling'
import {
  buildSkillContextBundles,
  resolveInstalledSkill,
  skillActivationId,
  type InstalledSkillRecord,
} from './skills'
import {
  ASK_GEMINI_DEFAULT_MODEL,
  ASK_GEMINI_TOOL_NAME,
  askGeminiCli,
} from './geminiCli'
import {
  GET_PROJECT_BROWSER_ERRORS_TOOL,
  OPEN_PROJECT_BROWSER_TOOL,
  RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
  SEARCH_PROJECT_BROWSER_DOM_TOOL,
} from '../shared/projectBrowser'
import {
  PEEK_BACKGROUND_PROCESS_TOOL,
  START_BACKGROUND_PROCESS_TOOL,
  TERMINATE_BACKGROUND_PROCESS_TOOL,
} from '../shared/backgroundProcesses'
import {
  DEFAULT_SHELL_PEEK_CHARS,
  peekShellTranscript,
} from '../shared/shellSession'
import type {
  ContentMaterializeTarget,
  createSmartContentService,
} from './smartContent'

type DebugDirection = 'renderer->main' | 'main->renderer' | 'sdk->app' | 'app->sdk' | 'sdk->runtime' | 'runtime->sdk'

interface DebugLogEntryInput {
  layer: 'ipc' | 'sdk' | 'runtime'
  direction: DebugDirection
  event: string
  summary: string
  turnId?: string
  data: unknown
}

interface PendingPlanQuestion {
  id: string
  turnId?: string
  question: string
  details?: string
  options: string[]
  placeholder?: string
  askedAt: number
}

interface PendingPlanExit {
  id: string
  turnId?: string
  createdAt: number
  workMode: AppSessionMode
  summary: string
  details?: string
  source?: 'model' | 'synthetic'
  trigger?: 'exit_plan_mode' | 'legacy_prepare_plan_execution' | 'blocked_build_tool'
  attentionToken?: number
}

interface BackgroundProcessState {
  terminalId: string
  command: string
  workingDirectory: string
  status: string
  startedAt: number
}

interface ShellProcessBlock {
  command: string
  workingDirectory: string
  transcript: string
  status: string
  exitCode?: number | null
  startedAt: number
  completedAt?: number | null
}

interface LiveShellProcessState {
  transcript: string
  status: string
  exitCode?: number | null
  completedAt?: number | null
}

interface ExternalToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

interface ExternalToolCallResult {
  output: string
  structuredOutput?: unknown
}

interface ExternalToolManager {
  getToolDefinitions(): ExternalToolDefinition[]
  callTool(sessionId: string, name: string, input: Record<string, unknown>): Promise<ExternalToolCallResult>
}

interface ProjectBrowserToolResult {
  output: string
  structuredOutput?: unknown
}

interface ProjectBrowserManagerForTools {
  open(input: { sessionId: string; url: string; coBrowseActive: boolean; timeoutMs?: number; maxChars?: number }): Promise<ProjectBrowserToolResult>
  assertAgentBrowserControl(input: { sessionId: string; coBrowseActive: boolean }): void
  searchDom(input: { selectors?: string[]; textPatterns?: string[]; maxMatches?: number; includeHtml?: boolean }): Promise<ProjectBrowserToolResult>
  releaseControlToUser(input: { sessionId: string; reason?: string }): { controlOwner: string; controlReason?: string | null }
  getConsoleErrors(input: { maxItems?: number }): ProjectBrowserToolResult
}

interface AppToolsDependencies {
  appendDebugLog: (sessionId: string, entry: DebugLogEntryInput) => void
  browserToolManager: ExternalToolManager | null
  buildSearchWebTool: () => RegisteredTool
  chromeDevtoolsToolManager: ExternalToolManager | null
  closeShellCardInternal: (sessionId: string, processId: string) => Promise<void>
  getSessionConfigFromMetadata: (metadata: Record<string, unknown> | undefined, fallbackMode: BaseSessionMode) => { approvalMode: ConversationApprovalMode }
  getSettingsState: () => Promise<{ integrations: { geminiCli: { model: string } } }>
  listDiscoverableSkills: () => Promise<InstalledSkillRecord[]>
  pendingPlanQuestionResolvers: Map<string, { sessionId: string; resolve: (value: string) => void; reject: (error: Error) => void }>
  projectBrowserManager: ProjectBrowserManagerForTools
  resolveBaseMode: (mode: ModeSelection) => BaseSessionMode
  resolveShellProcessOrThrow: (sessionId: string, processId: string) => ShellProcessBlock
  setPendingPlanExitState: (sessionId: string, pendingPlanExit: PendingPlanExit | null) => void
  setPendingPlanQuestionState: (sessionId: string, pendingPlanQuestion: PendingPlanQuestion | null) => void
  shellSessionManager: { inspect(sessionId: string, processId: string): LiveShellProcessState | null }
  smartContent: ReturnType<typeof createSmartContentService>
  startBackgroundProcessInternal: (sessionId: string, input: { command: string; workingDirectory: string }) => Promise<BackgroundProcessState>
}

export function createAppTools(dependencies: AppToolsDependencies): RegisteredTool[] {
  const {
    appendDebugLog,
    browserToolManager,
    buildSearchWebTool,
    chromeDevtoolsToolManager,
    closeShellCardInternal,
    getSessionConfigFromMetadata,
    getSettingsState,
    listDiscoverableSkills,
    pendingPlanQuestionResolvers,
    projectBrowserManager,
    resolveBaseMode,
    resolveShellProcessOrThrow,
    setPendingPlanExitState,
    setPendingPlanQuestionState,
    shellSessionManager,
    smartContent,
    startBackgroundProcessInternal,
  } = dependencies
  const {
    SMART_MULTI_READ_DEFAULT_MAX_BYTES,
    buildMaterializedReadResult,
    formatContentSearchOutput,
    formatInspectFileOutput,
    formatMaterializedContentOutput,
    inspectFileForReadStrategy,
    materializedContentForStructuredOutput,
    materializeInspectableContent,
    readInspectableFileForTool,
    resolveInspectableFile,
    searchMaterializedText,
  } = smartContent

  const buildAskUserTool = (
    name: string,
    description: string,
  ): RegisteredTool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        question: {},
        details: {},
        options: {},
        placeholder: {},
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizePlanQuestionInput(input)
      const request: PendingPlanQuestion = {
        id: randomUUID(),
        turnId: context.turnId,
        question: normalizedInput.question,
        details: normalizedInput.details,
        options: normalizedInput.options.slice(0, 6),
        placeholder: normalizedInput.placeholder,
        askedAt: Date.now(),
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'plan.question.requested',
        summary: request.question,
        turnId: context.turnId,
        data: {
          request,
          normalizedFrom: input,
          toolName: name,
        },
      })

      setPendingPlanQuestionState(context.sessionId, request)
      const signal = context.signal

      if (!signal) {
        throw new Error('Plan question requires an abort signal.')
      }

      const answer = await new Promise<string>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Plan question cancelled.'))
          return
        }

        const onAbort = () => {
          pendingPlanQuestionResolvers.delete(request.id)
          setPendingPlanQuestionState(context.sessionId, null)
          reject(new Error('Plan question cancelled.'))
        }

        signal.addEventListener('abort', onAbort, { once: true })
        pendingPlanQuestionResolvers.set(request.id, {
          sessionId: context.sessionId,
          resolve: (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          reject: (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        })
      })

      setPendingPlanQuestionState(context.sessionId, null)
      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'plan.question.answered',
        summary: 'Plan question answered',
        turnId: context.turnId,
        data: {
          requestId: request.id,
          answer,
          toolName: name,
        },
      })

      return {
        output: answer,
        structuredOutput: {
          answer,
        },
      }
    },
  })

  const askUserTool = buildAskUserTool(
    ASK_USER_TOOL,
    'Ask the user a direct planning question when you are blocked by a missing decision or requirement.',
  )
  const legacyAskPlanQuestionTool = buildAskUserTool(
    LEGACY_ASK_PLAN_QUESTION_TOOL,
    'Deprecated alias for ask_user. Ask the user a direct planning question when you are blocked.',
  )

  const activateSkillTool: RegisteredTool = {
    name: ACTIVATE_SKILL_TOOL,
    description:
      'Load a discoverable skill into the session context when it becomes relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
        reason: { type: 'string' },
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizeSkillActivationInput(input)
      if (!normalizedInput.skillId) {
        throw new Error('activate_skill requires a skillId from the available skill catalog.')
      }

      const installedSkills = await listDiscoverableSkills()
      const target = resolveInstalledSkill(
        normalizedInput.skillId,
        installedSkills,
      )

      if (!target) {
        const available = installedSkills
          .map((skill) => `${skillActivationId(skill)} (${skill.name})`)
          .join(', ')
        throw new Error(
          available.length > 0
            ? `Skill not found: ${normalizedInput.skillId}. Available skills: ${available}`
            : 'No discoverable skills are available to activate.',
        )
      }

      const [bundle] = await buildSkillContextBundles([target.id], installedSkills)
      if (!bundle) {
        throw new Error(`Failed to load instructions for ${target.name}.`)
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'skills.activated',
        summary: `Activated skill ${target.name}`,
        turnId: context.turnId,
        data: {
          requestedSkillId: normalizedInput.skillId,
          activationId: skillActivationId(target),
          reason: normalizedInput.reason,
          skill: {
            id: target.id,
            name: target.name,
            location: target.location,
            directory: target.directory,
          },
        },
      })

      return {
        title: target.name,
        output: [
          `Activated skill: ${target.name}`,
          `Activation id: ${skillActivationId(target)}`,
          bundle.text,
          bundle.truncated
            ? 'Note: some skill content or bundled resource listings were trimmed to keep the session usable.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        structuredOutput: {
          activationId: skillActivationId(target),
          skillId: target.id,
          name: target.name,
          location: target.location,
          directory: target.directory,
          truncated: bundle.truncated,
        },
      }
    },
  }

  const inspectFileTool: RegisteredTool<{
    path: string
    mediaType?: string
  }> = {
    name: 'inspect_file',
    description:
      'Direct tool. Resolve a local file path, classify it, and suggest the safest way to use read_file without guessing from the extension alone.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(input, context) {
      const file = await resolveInspectableFile(input, context.workingDirectory)
      const result = await inspectFileForReadStrategy({
        file,
        workingDirectory: context.workingDirectory,
      })
      return {
        output: formatInspectFileOutput(result),
        structuredOutput: {
          path: result.displayPath,
          absolutePath: file.path,
          name: file.name,
          kind: file.kind,
          mediaType: file.mediaType,
          size: file.size,
          modifiedAtMs: file.modifiedAtMs,
          pageCount: result.pageCount,
          canReadWithReadFile: result.canReadWithReadFile,
          suggestedTool: result.suggestedTool,
          suggestedStrategy: result.suggestedStrategy,
          reasoning: result.reasoning,
          warnings: result.warnings,
        },
      }
    },
  }

  const materializeContentTool: RegisteredTool<{
    path: string
    mediaType?: string
    outputPath?: string
    target?: ContentMaterializeTarget
    createDirectories?: boolean
    overwrite?: boolean
  }> = {
    name: 'materialize_content',
    description:
      'Direct tool. Convert a known local source into an addressable text artifact without loading the whole artifact into model context. Supports text files, PDFs, image OCR/description, and audio transcription when helper models are available.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        outputPath: { type: 'string' },
        target: { type: 'string', enum: ['auto', 'text', 'markdown'] },
        createDirectories: { type: 'boolean' },
        overwrite: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        ...input,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      return {
        output: formatMaterializedContentOutput(materialized),
        structuredOutput: materializedContentForStructuredOutput(materialized),
      }
    },
  }

  const readContentTool: RegisteredTool<{
    path: string
    mediaType?: string
    offset?: number
    limit?: number
    maxBytes?: number
  }> = {
    name: 'read_content',
    description:
      'Direct tool. Read a materialized content artifact or source file with line-based pagination. If the path is a PDF, image, or audio file, Gemma Desktop materializes it to cached text first.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
        maxBytes: { type: 'integer', minimum: 256, maximum: 524288 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        path: input.path,
        mediaType: input.mediaType,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      const result = buildMaterializedReadResult({
        materialized,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
      })
      return {
        output: renderWorkspaceReadFile(result),
        structuredOutput: {
          ...result,
          materialized: materializedContentForStructuredOutput(materialized),
        },
        metadata: { truncated: result.truncated },
      }
    },
  }

  const searchContentTool: RegisteredTool<{
    path: string
    query: string
    mediaType?: string
    regex?: boolean
    caseSensitive?: boolean
    wholeWord?: boolean
    before?: number
    after?: number
    limit?: number
  }> = {
    name: 'search_content',
    description:
      'Direct tool. Search within one materialized content artifact or source file. For PDFs, images, and audio, Gemma Desktop materializes cached text first, then searches that artifact.',
    inputSchema: {
      type: 'object',
      required: ['path', 'query'],
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        mediaType: { type: 'string' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        wholeWord: { type: 'boolean' },
        before: { type: 'integer', minimum: 0, maximum: 20 },
        after: { type: 'integer', minimum: 0, maximum: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        path: input.path,
        mediaType: input.mediaType,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      const result = searchMaterializedText({
        text: materialized.text,
        path: materialized.displayArtifactPath,
        query: input.query,
        regex: input.regex,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        before: input.before,
        after: input.after,
        limit: input.limit,
      })
      return {
        output: formatContentSearchOutput({
          path: materialized.displayArtifactPath,
          query: input.query,
          matches: result.matches,
          truncated: result.truncated,
        }),
        structuredOutput: {
          path: materialized.displayArtifactPath,
          artifactPath: materialized.artifactPath,
          query: input.query,
          regex: result.regex,
          matches: result.matches,
          truncated: result.truncated,
          materialized: materializedContentForStructuredOutput(materialized),
        },
        metadata: { truncated: result.truncated },
      }
    },
  }

  const smartReadFileTool: RegisteredTool<{
    path: string
    mediaType?: string
    offset?: number
    limit?: number
    maxBytes?: number
  }> = {
    name: 'read_file',
    description:
      'Direct tool. Read a known file with line-based pagination. For PDFs, images, and audio, Gemma Desktop first converts the file into cached text, then returns a paginated text window.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
        maxBytes: { type: 'integer', minimum: 256, maximum: 524288 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const result = await readInspectableFileForTool({
        ...input,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      return {
        output: renderWorkspaceReadFile(result),
        structuredOutput: result,
        metadata: { truncated: result.truncated },
      }
    },
  }

  const smartReadFilesTool: RegisteredTool<{
    requests: Array<{
      path: string
      mediaType?: string
      offset?: number
      limit?: number
    }>
    maxTotalBytes?: number
  }> = {
    name: 'read_files',
    description:
      'Direct tool. Batch-read several known files under one shared byte budget. Gemma Desktop converts PDFs, images, and audio into cached text before returning paginated text windows.',
    inputSchema: {
      type: 'object',
      required: ['requests'],
      properties: {
        requests: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string' },
              mediaType: { type: 'string' },
              offset: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 10000 },
            },
            additionalProperties: false,
          },
        },
        maxTotalBytes: { type: 'integer', minimum: 256, maximum: 2097152 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const maxTotalBytes = Math.max(
        Math.min(
          typeof input.maxTotalBytes === 'number'
            ? Math.floor(input.maxTotalBytes)
            : SMART_MULTI_READ_DEFAULT_MAX_BYTES,
          2 * 1024 * 1024,
        ),
        256,
      )
      const results: Array<Awaited<ReturnType<typeof readInspectableFileForTool>>> = []
      let totalBytes = 0
      let truncated = false
      let exhaustedBudget = false

      for (const request of input.requests) {
        const remainingBytes = maxTotalBytes - totalBytes
        if (remainingBytes <= 0) {
          exhaustedBudget = true
          truncated = true
          break
        }

        const requestPath = typeof request.path === 'string' ? request.path.trim() : ''
        const requestLabel = requestPath.length > 0 ? path.basename(requestPath) : `file ${results.length + 1}`
        const result = await readInspectableFileForTool({
          ...request,
          maxBytes: remainingBytes,
          workingDirectory: context.workingDirectory,
          sessionId: context.sessionId,
          signal: context.signal,
          onProgress: context.emitProgress
            ? (progress) => {
                context.emitProgress?.({
                  id: `request-${results.length + 1}-${progress.id}`,
                  label: `${requestLabel}: ${progress.label}`,
                  tone: progress.tone,
                })
              }
            : undefined,
        })
        results.push(result)
        totalBytes += Buffer.byteLength(result.numberedContent, 'utf8')
        if (result.truncated) {
          truncated = true
        }
      }

      if (results.length < input.requests.length) {
        truncated = true
      }

      const structuredOutput = {
        results,
        truncated,
        exhaustedBudget,
        maxTotalBytes,
        totalBytes,
      }

      return {
        output: renderWorkspaceReadFiles(structuredOutput),
        structuredOutput,
        metadata: { truncated },
      }
    },
  }

  const startBackgroundProcessTool: RegisteredTool<{
    command: string
    cwd?: string
  }> = {
    name: START_BACKGROUND_PROCESS_TOOL,
    description:
      'Start one conversation-scoped background process for a long-running local command such as a dev server, watcher, or download. Use cwd for subdirectories instead of prefixing the command with cd.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Command to run from the selected working directory, for example "npm run dev". Do not include shell background operators.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional path relative to the session workspace where the command should run, for example "blackhole02". Defaults to the session workspace.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(input, context) {
      const command =
        typeof input.command === 'string' ? input.command.trim() : ''
      const workingDirectory = resolveBackgroundProcessWorkingDirectory({
        workingDirectory: context.workingDirectory,
        cwd: input.cwd,
      })
      const state = await startBackgroundProcessInternal(context.sessionId, {
        command,
        workingDirectory,
      })

      return {
        output: [
          `Started background process ${state.terminalId}.`,
          `Command: ${state.command}`,
          `Working directory: ${state.workingDirectory}`,
          `Status: ${state.status}`,
          `Use ${PEEK_BACKGROUND_PROCESS_TOOL} to inspect bounded output or ${TERMINATE_BACKGROUND_PROCESS_TOOL} to stop it.`,
        ].join('\n'),
        structuredOutput: {
          processId: state.terminalId,
          command: state.command,
          workingDirectory: state.workingDirectory,
          status: state.status,
          startedAt: state.startedAt,
        },
      }
    },
  }

  const peekBackgroundProcessTool: RegisteredTool = {
    name: PEEK_BACKGROUND_PROCESS_TOOL,
    description:
      'Check whether a tracked background process is still running and return a bounded tail of its recent output.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { processId?: unknown; maxChars?: unknown }
          : {}
      const processId =
        typeof record.processId === 'string' ? record.processId.trim() : ''
      if (processId.length === 0) {
        throw new Error('peek_background_process requires a processId.')
      }

      const liveState = shellSessionManager.inspect(context.sessionId, processId)
      const block = resolveShellProcessOrThrow(context.sessionId, processId)
      const peek = peekShellTranscript(
        liveState?.transcript ?? block.transcript,
        typeof record.maxChars === 'number' ? record.maxChars : DEFAULT_SHELL_PEEK_CHARS,
      )
      const status = liveState?.status ?? block.status
      const exitCode = liveState?.exitCode ?? block.exitCode
      const completedAt = liveState?.completedAt ?? block.completedAt
      const notes = [
        peek.peekTruncated
          ? `Showing only the last ${peek.returnedChars} characters of ${peek.totalChars} retained transcript characters.`
          : undefined,
        peek.storageTruncated
          ? 'Older process output was already dropped from retained transcript storage.'
          : undefined,
      ].filter((entry): entry is string => Boolean(entry))

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'sessions.process.peeked',
        summary: `Peeked background process ${processId}`,
        turnId: context.turnId,
        data: {
          processId,
          status,
          exitCode,
          peekTruncated: peek.peekTruncated,
          storageTruncated: peek.storageTruncated,
          returnedChars: peek.returnedChars,
        },
      })

      return {
        output: [
          `Process: ${processId}`,
          `Command: ${block.command}`,
          `Status: ${status}${exitCode == null ? '' : ` (exit ${exitCode})`}`,
          `Working directory: ${block.workingDirectory}`,
          ...(completedAt != null ? [`Completed at: ${new Date(completedAt).toISOString()}`] : []),
          ...(notes.length > 0 ? [`Notes: ${notes.join(' ')}`] : []),
          'Recent output:',
          peek.text.length > 0 ? peek.text : '[no output recorded yet]',
        ].join('\n'),
        structuredOutput: {
          processId,
          command: block.command,
          workingDirectory: block.workingDirectory,
          status,
          exitCode,
          startedAt: block.startedAt,
          completedAt,
          output: peek.text,
          outputChars: peek.returnedChars,
          retainedTranscriptChars: peek.totalChars,
          peekTruncated: peek.peekTruncated,
          storageTruncated: peek.storageTruncated,
        },
      }
    },
  }

  const terminateBackgroundProcessTool: RegisteredTool = {
    name: TERMINATE_BACKGROUND_PROCESS_TOOL,
    description:
      'Terminate a tracked background process in the current conversation only when the user asked you to stop it or it must be stopped for safety or task progress.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { processId?: unknown }
          : {}
      const processId =
        typeof record.processId === 'string' ? record.processId.trim() : ''
      if (processId.length === 0) {
        throw new Error('terminate_background_process requires a processId.')
      }

      const block = resolveShellProcessOrThrow(context.sessionId, processId)
      const liveState = shellSessionManager.inspect(context.sessionId, processId)

      if (liveState?.status === 'running') {
        await closeShellCardInternal(context.sessionId, processId)
        appendDebugLog(context.sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'sessions.process.terminate.requested',
          summary: `Terminate requested for ${processId}`,
          turnId: context.turnId,
          data: {
            processId,
            command: block.command,
          },
        })
        return {
          output: [
            `Termination requested for ${processId}.`,
            `Command: ${block.command}`,
            `Use ${PEEK_BACKGROUND_PROCESS_TOOL} if you need to confirm the final exit state.`,
          ].join('\n'),
          structuredOutput: {
            processId,
            command: block.command,
            status: 'termination_requested',
          },
        }
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'sessions.process.terminate.noop',
        summary: `Background process ${processId} was already ${block.status}`,
        turnId: context.turnId,
        data: {
          processId,
          command: block.command,
          status: block.status,
          exitCode: block.exitCode,
        },
      })

      return {
        output: [
          `Process ${processId} is not running.`,
          `Command: ${block.command}`,
          `Status: ${block.status}${block.exitCode == null ? '' : ` (exit ${block.exitCode})`}`,
        ].join('\n'),
        structuredOutput: {
          processId,
          command: block.command,
          status: block.status,
          exitCode: block.exitCode,
          completedAt: block.completedAt,
        },
      }
    },
  }

  const openProjectBrowserTool: RegisteredTool = {
    name: OPEN_PROJECT_BROWSER_TOOL,
    description:
      'Open or refresh the visible Project Browser for an http or https URL and return a bounded page snapshot for verification.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              url?: unknown
              timeoutMs?: unknown
              maxChars?: unknown
            }
          : {}

      const result = await projectBrowserManager.open({
        sessionId: context.sessionId,
        url: typeof record.url === 'string' ? record.url : '',
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
        timeoutMs:
          typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)
            ? record.timeoutMs
            : undefined,
        maxChars:
          typeof record.maxChars === 'number' && Number.isFinite(record.maxChars)
            ? record.maxChars
            : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.opened',
        summary:
          typeof record.url === 'string' && record.url.trim().length > 0
            ? `Opened Project Browser for ${record.url}`
            : 'Opened Project Browser',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const searchProjectBrowserDomTool: RegisteredTool = {
    name: SEARCH_PROJECT_BROWSER_DOM_TOOL,
    description:
      'Search the current Project Browser page for selectors or text patterns and return bounded DOM matches.',
    inputSchema: {
      type: 'object',
      properties: {
        selectors: {
          type: 'array',
          items: { type: 'string' },
        },
        textPatterns: {
          type: 'array',
          items: { type: 'string' },
        },
        maxMatches: { type: 'number' },
        includeHtml: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      projectBrowserManager.assertAgentBrowserControl({
        sessionId: context.sessionId,
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
      })

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              selectors?: unknown
              textPatterns?: unknown
              maxMatches?: unknown
              includeHtml?: unknown
            }
          : {}

      const result = await projectBrowserManager.searchDom({
        selectors: Array.isArray(record.selectors)
          ? record.selectors.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        textPatterns: Array.isArray(record.textPatterns)
          ? record.textPatterns.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        maxMatches:
          typeof record.maxMatches === 'number' && Number.isFinite(record.maxMatches)
            ? record.maxMatches
            : undefined,
        includeHtml: record.includeHtml === true,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.dom-searched',
        summary: 'Searched Project Browser DOM',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const releaseProjectBrowserToUserTool: RegisteredTool = {
    name: RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
    description:
      'Release visible CoBrowse browser control to the user for login, CAPTCHA, permission, payment, or other human-only browser actions.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      if (!isCoBrowseSessionMetadata(context.sessionMetadata)) {
        throw new Error('Project Browser control handoff is only available during CoBrowse.')
      }

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { reason?: unknown }
          : {}
      const state = projectBrowserManager.releaseControlToUser({
        sessionId: context.sessionId,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.control-released-to-user',
        summary: 'Released Project Browser control to the user',
        turnId: context.turnId,
        data: {
          input: record,
          state,
        },
      })

      return {
        output: [
          'Released Project Browser control to the user.',
          'Browser tools are blocked until the user clicks Release control.',
        ].join('\n'),
        structuredOutput: {
          action: 'release_control_to_user',
          controlOwner: state.controlOwner,
          controlReason: state.controlReason,
          needsUserRelease: true,
        },
      }
    },
  }

  const getProjectBrowserErrorsTool: RegisteredTool = {
    name: GET_PROJECT_BROWSER_ERRORS_TOOL,
    description:
      'Return recent console and page-load errors captured from the current Project Browser page with bounded output.',
    inputSchema: {
      type: 'object',
      properties: {
        maxItems: { type: 'number' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      projectBrowserManager.assertAgentBrowserControl({
        sessionId: context.sessionId,
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
      })

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { maxItems?: unknown }
          : {}

      const result = projectBrowserManager.getConsoleErrors({
        maxItems:
          typeof record.maxItems === 'number' && Number.isFinite(record.maxItems)
            ? record.maxItems
            : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.errors-read',
        summary: 'Read Project Browser console errors',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const browserTools: RegisteredTool[] = (browserToolManager?.getToolDefinitions() ?? [])
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      async execute(input: unknown, context) {
        if (!browserToolManager) {
          throw new Error('Browser tool is not initialized.')
        }

        const argumentsRecord =
          input && typeof input === 'object' && !Array.isArray(input)
            ? input as Record<string, unknown>
            : {}

        const result = await browserToolManager.callTool(
          context.sessionId,
          tool.name,
          argumentsRecord,
        )

        appendDebugLog(context.sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'chrome.tool.executed',
          summary: `Executed ${tool.name}`,
          turnId: context.turnId,
          data: {
            toolName: tool.name,
            arguments: argumentsRecord,
            structuredOutput: result.structuredOutput,
          },
        })

        return {
          output: result.output,
          structuredOutput: result.structuredOutput,
        }
      },
    }))

  const chromeDevtoolsTools: RegisteredTool[] = (
    chromeDevtoolsToolManager?.getToolDefinitions() ?? []
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: unknown, context) {
      if (!chromeDevtoolsToolManager) {
        throw new Error('Chrome DevTools is not initialized.')
      }

      const argumentsRecord =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {}

      const result = await chromeDevtoolsToolManager.callTool(
        context.sessionId,
        tool.name,
        argumentsRecord,
      )

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'chrome-devtools.tool.executed',
        summary: `Executed ${tool.name}`,
        turnId: context.turnId,
        data: {
          toolName: tool.name,
          arguments: argumentsRecord,
          structuredOutput: result.structuredOutput,
        },
      })

      return {
        output: result.output,
        structuredOutput: result.structuredOutput,
      }
    },
  }))

  const askGeminiTool: RegisteredTool = {
    name: ASK_GEMINI_TOOL_NAME,
    description:
      'Ask the locally installed Gemini CLI a detailed question in headless read-only mode and use the answer as advisory input.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              question?: unknown
              context?: unknown
              model?: unknown
            }
          : {}
      const question =
        typeof record.question === 'string' ? record.question.trim() : ''
      const contextText =
        typeof record.context === 'string' && record.context.trim().length > 0
          ? record.context.trim()
          : undefined
      const requestedModel =
        typeof record.model === 'string' && record.model.trim().length > 0
          ? record.model.trim()
          : undefined
      const currentSettings = await getSettingsState()
      const configuredModel = currentSettings.integrations.geminiCli.model.trim()
        || ASK_GEMINI_DEFAULT_MODEL

      const result = await askGeminiCli({
        question,
        context: contextText,
        model: requestedModel ?? configuredModel,
        workingDirectory: context.workingDirectory,
        approvalMode: getSessionConfigFromMetadata(
          context.sessionMetadata,
          resolveBaseMode(context.mode),
        ).approvalMode,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'gemini.tool.executed',
        summary: result.ok
          ? 'Received Ask Gemini response'
          : `Ask Gemini failed: ${result.errorKind}`,
        turnId: context.turnId,
        data: {
          question,
          requestedModel: requestedModel ?? configuredModel,
          result,
        },
      })

      if (!result.ok) {
        return {
          output: `Ask Gemini failed: ${result.error}`,
          structuredOutput: result,
        }
      }

      return {
        output: [
          result.response,
          ...(result.warnings && result.warnings.length > 0
            ? ['', `Warnings: ${result.warnings.join(' ')}`]
            : []),
        ].join('\n'),
        structuredOutput: result,
      }
    },
  }

  const buildExitPlanModeTool = (
    name: string,
    trigger: PendingPlanExit['trigger'],
    description: string,
  ): RegisteredTool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {},
        details: {},
        executionPrompt: {},
        workMode: {},
        recommendedMode: {},
        mode: {},
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizePlanExitInput(input)
      const planExit: PendingPlanExit = {
        id: randomUUID(),
        turnId: context.turnId,
        createdAt: Date.now(),
        workMode: normalizedInput.workMode,
        summary: normalizedInput.summary,
        details: normalizedInput.details,
        source: 'model',
        trigger,
        attentionToken: Date.now(),
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'plan.exit.prepared',
        summary: planExit.summary.slice(0, 140),
        turnId: context.turnId,
        data: {
          planExit,
          normalizedFrom: input,
          toolName: name,
        },
      })

      setPendingPlanExitState(context.sessionId, planExit)

      return {
        output:
          'Plan exit prepared. Tell the user the plan is ready and they can switch this session back to work mode.',
        structuredOutput: planExit,
      }
    },
  })

  return [
    buildSearchWebTool(),
    askUserTool,
    legacyAskPlanQuestionTool,
    activateSkillTool,
    inspectFileTool,
    materializeContentTool,
    readContentTool,
    searchContentTool,
    smartReadFileTool,
    smartReadFilesTool,
    startBackgroundProcessTool,
    peekBackgroundProcessTool,
    terminateBackgroundProcessTool,
    openProjectBrowserTool,
    searchProjectBrowserDomTool,
    releaseProjectBrowserToUserTool,
    getProjectBrowserErrorsTool,
    askGeminiTool,
    ...browserTools,
    ...chromeDevtoolsTools,
    buildExitPlanModeTool(
      EXIT_PLAN_MODE_TOOL,
      'exit_plan_mode',
      'Prepare the current plan to exit plan mode and switch this session back to its underlying work mode.',
    ),
    buildExitPlanModeTool(
      LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
      'legacy_prepare_plan_execution',
      'Deprecated alias for exit_plan_mode. Prepare the current plan to switch this session back to work mode.',
    ),
  ]
}
