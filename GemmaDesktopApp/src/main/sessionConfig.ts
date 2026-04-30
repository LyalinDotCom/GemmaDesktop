import type {
  ConversationApprovalMode,
  SessionSnapshot,
} from '@gemma-desktop/sdk-core'
import {
  DEFAULT_CONVERSATION_APPROVAL_MODE,
  normalizeConversationApprovalMode,
} from '@gemma-desktop/sdk-core'
import {
  type AppSessionMode,
  type BaseSessionMode,
  isBaseSessionMode,
  normalizeAppSessionMode,
  toSdkSessionMode,
  withoutCoBrowseSessionMetadata,
  type ConversationKind,
} from './tooling'
import {
  TALK_SESSION_RUNTIME_ID,
  isHiddenSessionVisibility,
  isTalkSessionId,
  isTalkSessionSurface,
  normalizeAppSessionStorageScope,
  normalizeAppSessionSurface,
  normalizeAppSessionVisibility,
  type AppSessionStorageScope,
  type AppSessionSurface,
  type AppSessionVisibility,
} from './talkSession'
import { normalizeProviderRuntimeId } from '../shared/sessionModelDefaults'
import type {
  LegacyPendingPlanExecution,
  PendingPlanExit,
  PersistedSession,
} from './sessionStore'

export const APP_SESSION_METADATA_KEY = 'gemmaDesktopApp'

export interface AppSessionConfig {
  conversationKind: ConversationKind
  baseMode: BaseSessionMode
  planMode: boolean
  preferredRuntimeId: string
  selectedSkillIds: string[]
  selectedSkillNames: string[]
  selectedToolIds: string[]
  selectedToolNames: string[]
  approvalMode: ConversationApprovalMode
  surface: AppSessionSurface
  visibility: AppSessionVisibility
  storageScope: AppSessionStorageScope
}

export function normalizeConversationKind(value: unknown): ConversationKind {
  return value === 'research' ? 'research' : 'normal'
}

export function normalizeSessionConfig(config: AppSessionConfig): AppSessionConfig {
  const conversationKind = normalizeConversationKind(config.conversationKind)
  const baseMode = normalizeAppSessionMode(config.baseMode, 'explore')

  return {
    ...config,
    conversationKind,
    baseMode,
    planMode:
      conversationKind === 'normal' && baseMode === 'build'
        ? Boolean(config.planMode)
        : false,
    preferredRuntimeId: normalizeProviderRuntimeId(config.preferredRuntimeId),
    approvalMode: normalizeConversationApprovalMode(config.approvalMode),
    surface: normalizeAppSessionSurface(config.surface),
    visibility: normalizeAppSessionVisibility(config.visibility),
    storageScope: normalizeAppSessionStorageScope(config.storageScope),
  }
}

export function resolveBaseMode(mode: SessionSnapshot['mode']): BaseSessionMode {
  if (typeof mode === 'string') {
    if (mode === 'build') {
      return 'build'
    }
    if (
      mode === 'assistant'
      || mode === 'explore'
      || mode === 'cowork'
      || mode === 'planner'
      || mode === 'plan'
    ) {
      return 'explore'
    }
  }

  if (
    typeof mode === 'object'
    && mode
  ) {
    const base = (mode as { base?: unknown }).base
    if (base === 'build') {
      return 'build'
    }
    if (
      base === 'assistant'
      || base === 'explore'
      || base === 'cowork'
      || base === 'planner'
      || base === 'plan'
    ) {
      return 'explore'
    }
  }

  return 'explore'
}

export function resolveLegacyPlanMode(mode: SessionSnapshot['mode']): boolean {
  if (typeof mode === 'string') {
    return mode === 'planner' || mode === 'plan'
  }

  if (typeof mode === 'object' && mode) {
    const base = (mode as { base?: unknown }).base
    return base === 'planner' || base === 'plan'
  }

  return false
}

export function getSessionConfigFromMetadata(
  metadataRecord: Record<string, unknown> | undefined,
  fallbackBaseMode: BaseSessionMode,
  fallbackPlanMode = false,
): AppSessionConfig {
  const metadata =
    metadataRecord?.[APP_SESSION_METADATA_KEY] as
      | Partial<AppSessionConfig>
      | undefined

  const selectedSkillIds = Array.isArray(metadata?.selectedSkillIds)
    ? metadata.selectedSkillIds.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedSkillNames = Array.isArray(metadata?.selectedSkillNames)
    ? metadata.selectedSkillNames.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedToolIds = Array.isArray(metadata?.selectedToolIds)
    ? metadata.selectedToolIds.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedToolNames = Array.isArray(metadata?.selectedToolNames)
    ? metadata.selectedToolNames.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  return {
    conversationKind: normalizeConversationKind(metadata?.conversationKind),
    baseMode: isBaseSessionMode(metadata?.baseMode)
      ? metadata.baseMode
      : fallbackBaseMode,
    planMode:
      typeof metadata?.planMode === 'boolean'
        ? metadata.planMode
        : fallbackPlanMode,
    preferredRuntimeId:
      typeof metadata?.preferredRuntimeId === 'string'
      && metadata.preferredRuntimeId.trim().length > 0
        ? metadata.preferredRuntimeId
        : '',
    selectedSkillIds,
    selectedSkillNames,
    selectedToolIds,
    selectedToolNames,
    approvalMode: normalizeConversationApprovalMode(metadata?.approvalMode),
    surface: normalizeAppSessionSurface(metadata?.surface),
    visibility: normalizeAppSessionVisibility(metadata?.visibility),
    storageScope: normalizeAppSessionStorageScope(metadata?.storageScope),
  }
}

export function getSessionConfig(snapshot: SessionSnapshot): AppSessionConfig {
  const config = normalizeSessionConfig(getSessionConfigFromMetadata(
    snapshot.metadata,
    resolveBaseMode(snapshot.mode),
    resolveLegacyPlanMode(snapshot.mode),
  ))

  return {
    ...config,
    preferredRuntimeId:
      config.preferredRuntimeId.trim().length > 0
        ? config.preferredRuntimeId
        : normalizeProviderRuntimeId(snapshot.runtimeId),
  }
}

export function createSessionMetadata(
  snapshot: SessionSnapshot | null,
  config: AppSessionConfig,
): Record<string, unknown> {
  return {
    ...withoutCoBrowseSessionMetadata(snapshot?.metadata ?? {}),
    [APP_SESSION_METADATA_KEY]: {
      conversationKind: config.conversationKind,
      baseMode: config.baseMode,
      planMode: config.planMode,
      preferredRuntimeId: config.preferredRuntimeId,
      selectedSkillIds: [...config.selectedSkillIds],
      selectedSkillNames: [...config.selectedSkillNames],
      selectedToolIds: [...config.selectedToolIds],
      selectedToolNames: [...config.selectedToolNames],
      approvalMode: config.approvalMode,
      surface: config.surface,
      visibility: config.visibility,
      storageScope: config.storageScope,
    },
  }
}

export function isTalkSessionConfig(
  config: Pick<AppSessionConfig, 'surface'>,
): boolean {
  return isTalkSessionSurface(config.surface)
}

export function isHiddenSessionConfig(
  config: Pick<AppSessionConfig, 'visibility'>,
): boolean {
  return isHiddenSessionVisibility(config.visibility)
}

export function isTalkSessionSnapshot(snapshot: SessionSnapshot): boolean {
  return isTalkSessionId(snapshot.sessionId) || isTalkSessionConfig(getSessionConfig(snapshot))
}

export function isHiddenSessionSnapshot(snapshot: SessionSnapshot): boolean {
  return isTalkSessionSnapshot(snapshot) || isHiddenSessionConfig(getSessionConfig(snapshot))
}

export function buildTalkSessionConfig(
  approvalMode: ConversationApprovalMode = DEFAULT_CONVERSATION_APPROVAL_MODE,
): AppSessionConfig {
  return normalizeSessionConfig({
    conversationKind: 'normal',
    baseMode: 'explore',
    planMode: false,
    preferredRuntimeId: TALK_SESSION_RUNTIME_ID,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    approvalMode,
    surface: 'talk',
    visibility: 'hidden',
    storageScope: 'global',
  })
}

export function migrateLegacyPendingPlanExecution(
  pendingPlanExecution: LegacyPendingPlanExecution | undefined,
): PendingPlanExit | undefined {
  if (!pendingPlanExecution) {
    return undefined
  }

  return {
    id: pendingPlanExecution.id,
    turnId: pendingPlanExecution.turnId,
    createdAt: pendingPlanExecution.createdAt,
    workMode: normalizeAppSessionMode(
      pendingPlanExecution.recommendedMode as AppSessionMode,
      'build',
    ),
    summary: pendingPlanExecution.summary,
    details:
      pendingPlanExecution.executionPrompt.trim().length > 0
        ? pendingPlanExecution.executionPrompt
        : undefined,
    source: pendingPlanExecution.source,
    trigger:
      pendingPlanExecution.trigger === 'blocked_build_tool'
        ? 'blocked_build_tool'
        : 'legacy_prepare_plan_execution',
    attentionToken: pendingPlanExecution.attentionToken,
  }
}

export function normalizePersistedSessionData(
  data: PersistedSession,
): PersistedSession {
  const pendingPlanExit =
    data.pendingPlanExit
    ?? migrateLegacyPendingPlanExecution(data.pendingPlanExecution)
  const metadataRecord =
    data.snapshot.metadata?.[APP_SESSION_METADATA_KEY] as
      | Partial<AppSessionConfig>
      | undefined
  const metadataBaseMode =
    typeof (metadataRecord as Record<string, unknown> | undefined)?.baseMode === 'string'
      ? (metadataRecord as Record<string, unknown>).baseMode
      : undefined
  const legacyPlannerMode =
    resolveLegacyPlanMode(data.snapshot.mode)
    || metadataBaseMode === 'planner'
  const currentConfig = getSessionConfigFromMetadata(
    data.snapshot.metadata,
    resolveBaseMode(data.snapshot.mode),
    resolveLegacyPlanMode(data.snapshot.mode),
  )
  const shouldForceTalkConfig =
    isTalkSessionId(data.meta.id)
    || isTalkSessionId(data.snapshot.sessionId)
    || isTalkSessionSurface(metadataRecord?.surface)
  const nextConfig: AppSessionConfig = shouldForceTalkConfig
    ? buildTalkSessionConfig(currentConfig.approvalMode)
    : {
        ...currentConfig,
        baseMode:
          legacyPlannerMode
            ? pendingPlanExit?.workMode ?? 'explore'
            : currentConfig.baseMode,
        planMode:
          typeof metadataRecord?.planMode === 'boolean'
            ? metadataRecord.planMode
            : legacyPlannerMode || currentConfig.planMode,
      }
  const nextSnapshot: SessionSnapshot = {
    ...data.snapshot,
    mode: toSdkSessionMode(nextConfig.baseMode),
    metadata: createSessionMetadata(data.snapshot, normalizeSessionConfig(nextConfig)),
  }

  return {
    ...data,
    snapshot: nextSnapshot,
    pendingPlanExit,
  }
}
