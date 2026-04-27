import {
  findGemmaCatalogEntryByTag,
  getExpectedGemmaContextLength,
} from '@shared/gemmaCatalog'
import type { ModelSummary, SessionDetail } from '@/types'

function formatContextBadge(contextLength: number | undefined): string | null {
  if (!contextLength || contextLength <= 0) {
    return null
  }
  const kilo = contextLength / 1024
  if (kilo >= 1) {
    const rounded = Math.round(kilo)
    const isClean = Math.abs(kilo - rounded) < 0.05
    return isClean ? `${rounded}K` : `${kilo.toFixed(1)}K`
  }
  return `${contextLength}`
}

export function buildEmptyStateSubheading(
  activeSession: SessionDetail | null,
  models: ModelSummary[],
): string | null {
  if (!activeSession) {
    return null
  }
  const { modelId, runtimeId } = activeSession
  const gemmaEntry = findGemmaCatalogEntryByTag(modelId)
  const runtimeModel = models.find(
    (model) => model.id === modelId && model.runtimeId === runtimeId,
  )
  const modelLabel = gemmaEntry?.label ?? runtimeModel?.name ?? modelId
  const contextLength =
    runtimeModel?.runtimeConfig?.loadedContextLength
    ?? runtimeModel?.runtimeConfig?.requestedOptions?.context_length
    ?? runtimeModel?.runtimeConfig?.requestedOptions?.num_ctx
    ?? runtimeModel?.contextLength
    ?? getExpectedGemmaContextLength(modelId)
  const contextBadge = formatContextBadge(contextLength)
  if (!modelLabel && !contextBadge) {
    return null
  }
  if (modelLabel && contextBadge) {
    return `${modelLabel} · ${contextBadge} context`
  }
  return modelLabel ?? (contextBadge ? `${contextBadge} context` : null)
}
