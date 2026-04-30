import type { AppModelSelectionSettings } from './sessionModelDefaults'

export const LOAD_DEFAULT_MODELS_SETTINGS_UPDATE_KEY =
  '__gemmaDesktopLoadDefaultModels'

export type DefaultModelLoadTargetRole = 'main' | 'helper'

export type DefaultModelLifecycleAction =
  | 'prepare'
  | 'inspect'
  | 'unload'
  | 'load'
  | 'skip'

export interface DefaultModelLoadTarget {
  modelId: string
  runtimeId: string
  roles: DefaultModelLoadTargetRole[]
}

export interface DefaultModelLifecycleStepResult {
  action: DefaultModelLifecycleAction
  ok: boolean
  modelId?: string
  runtimeId?: string
  roles?: DefaultModelLoadTargetRole[]
  message?: string
  error?: string
}

export interface LoadDefaultModelsResult {
  ok: boolean
  message: string
  selection: AppModelSelectionSettings
  targets: DefaultModelLoadTarget[]
  unloaded: DefaultModelLifecycleStepResult[]
  loaded: DefaultModelLifecycleStepResult[]
  skipped: DefaultModelLifecycleStepResult[]
  errors: DefaultModelLifecycleStepResult[]
}
