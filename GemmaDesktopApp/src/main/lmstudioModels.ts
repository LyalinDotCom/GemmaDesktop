export interface LoadedLmStudioInstanceSummary {
  id: string
  config: Record<string, unknown>
}

export function findLoadedLmStudioInstance(
  payload: Record<string, unknown>,
  modelId: string,
): LoadedLmStudioInstanceSummary | undefined {
  const models = Array.isArray(payload.models) ? payload.models : []

  for (const entry of models) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }

    const model = entry as Record<string, unknown>
    const candidateId = typeof model.key === 'string'
      ? model.key
      : typeof model.id === 'string'
        ? model.id
        : undefined

    if (candidateId !== modelId) {
      continue
    }

    const loadedInstances = Array.isArray(model.loaded_instances)
      ? model.loaded_instances
      : []

    for (const rawInstance of loadedInstances) {
      if (!rawInstance || typeof rawInstance !== 'object' || Array.isArray(rawInstance)) {
        continue
      }

      const instance = rawInstance as Record<string, unknown>
      const instanceId = typeof instance.id === 'string'
        ? instance.id.trim()
        : ''

      if (instanceId) {
        return {
          id: instanceId,
          config:
            instance.config && typeof instance.config === 'object' && !Array.isArray(instance.config)
              ? instance.config as Record<string, unknown>
              : {},
        }
      }
    }
  }

  return undefined
}

export function findLoadedLmStudioInstanceId(
  payload: Record<string, unknown>,
  modelId: string,
): string | undefined {
  return findLoadedLmStudioInstance(payload, modelId)?.id
}

export function extractLmStudioInstanceId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  const instanceId = typeof payload?.instance_id === 'string'
    ? payload.instance_id.trim()
    : ''

  return instanceId || undefined
}
