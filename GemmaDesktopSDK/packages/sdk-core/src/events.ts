import { randomUUID } from "node:crypto";

export interface GemmaDesktopEventContext {
  sessionId?: string;
  turnId?: string;
  runtimeId?: string;
  modelId?: string;
  parentToolCallId?: string;
}

export interface GemmaDesktopEvent<TPayload = Record<string, unknown>> extends GemmaDesktopEventContext {
  id: string;
  type: string;
  timestamp: string;
  payload: TPayload;
  raw?: unknown;
}

export function createEvent<TPayload>(
  type: string,
  payload: TPayload,
  context: GemmaDesktopEventContext = {},
  raw?: unknown,
): GemmaDesktopEvent<TPayload> {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    payload,
    raw,
    ...context,
  };
}
