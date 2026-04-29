import type { ModeSelection } from "@gemma-desktop/sdk-core";

export const APP_SESSION_METADATA_KEY = "gemmaDesktopApp";
export const REQUEST_PREFERENCES_METADATA_KEY = "requestPreferences";

export interface RequestPreferences {
  reasoningMode?: "auto" | "on";
  ollamaOptions?: Record<string, number>;
  ollamaKeepAlive?: string;
  lmstudioOptions?: Record<string, number>;
}

export interface DesktopParitySessionMetadataOptions {
  mode: ModeSelection;
  runtimeId: string;
  preferredRuntimeId?: string;
  selectedToolNames?: string[];
  requestPreferences?: RequestPreferences;
  extraMetadata?: Record<string, unknown>;
}

function resolveDesktopBaseMode(mode: ModeSelection): "explore" | "build" {
  const base = typeof mode === "string" ? mode : mode.base;
  return base === "build" ? "build" : "explore";
}

function compactRecord<T>(record: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, T] => entry[1] !== undefined),
  );
}

export function buildDesktopParitySessionMetadata(
  options: DesktopParitySessionMetadataOptions,
): Record<string, unknown> {
  const selectedToolNames = options.selectedToolNames ?? [];
  const metadata: Record<string, unknown> = {
    ...(options.extraMetadata ?? {}),
    [APP_SESSION_METADATA_KEY]: {
      conversationKind: "normal",
      baseMode: resolveDesktopBaseMode(options.mode),
      planMode: false,
      preferredRuntimeId: options.preferredRuntimeId ?? options.runtimeId,
      selectedSkillIds: [],
      selectedSkillNames: [],
      selectedToolIds: [],
      selectedToolNames,
      surface: "default",
      visibility: "visible",
      storageScope: "project",
    },
  };
  const requestPreferences = compactRecord({
    reasoningMode: options.requestPreferences?.reasoningMode,
    ollamaOptions: options.requestPreferences?.ollamaOptions,
    ollamaKeepAlive: options.requestPreferences?.ollamaKeepAlive,
    lmstudioOptions: options.requestPreferences?.lmstudioOptions,
  });

  if (Object.keys(requestPreferences).length > 0) {
    metadata[REQUEST_PREFERENCES_METADATA_KEY] = requestPreferences;
  }

  return metadata;
}
