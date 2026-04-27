export type GemmaDesktopErrorKind =
  | "runtime_not_installed"
  | "runtime_unavailable"
  | "runtime_unhealthy"
  | "model_not_found"
  | "model_not_available"
  | "model_not_loaded"
  | "loaded_instance_not_found"
  | "capability_unsupported"
  | "lifecycle_operation_unsupported"
  | "runtime_mode_unsupported"
  | "context_budget_exceeded"
  | "memory_budget_exceeded"
  | "invalid_tool_input"
  | "tool_call_malformed"
  | "tool_call_parser_mismatch"
  | "tool_execution_failed"
  | "transport_error"
  | "timeout"
  | "cancellation"
  | "permission_denied"
  | "configuration_invalid"
  | "build_completion_failed"
  | "build_budget_exhausted"
  | "benchmark_scenario_invalid";

export interface GemmaDesktopErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  raw?: unknown;
}

export class GemmaDesktopError extends Error {
  public readonly kind: GemmaDesktopErrorKind;
  public readonly details?: Record<string, unknown>;
  public readonly raw?: unknown;

  public constructor(kind: GemmaDesktopErrorKind, message: string, options: GemmaDesktopErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "GemmaDesktopError";
    this.kind = kind;
    this.details = options.details;
    this.raw = options.raw;
  }
}

export function isGemmaDesktopError(value: unknown): value is GemmaDesktopError {
  return value instanceof GemmaDesktopError;
}

export function toGemmaDesktopError(
  value: unknown,
  fallbackKind: GemmaDesktopErrorKind = "configuration_invalid",
  fallbackMessage = "An unexpected GemmaDesktopSDK error occurred.",
): GemmaDesktopError {
  if (value instanceof GemmaDesktopError) {
    return value;
  }

  if (value instanceof Error) {
    return new GemmaDesktopError(fallbackKind, value.message || fallbackMessage, {
      cause: value,
    });
  }

  return new GemmaDesktopError(fallbackKind, fallbackMessage, {
    raw: value,
  });
}
