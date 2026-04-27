import type { GemmaDesktopEvent } from "./events.js";

export function renderTrace(events: Iterable<GemmaDesktopEvent>): string {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "session.started":
        lines.push(`[session] started ${JSON.stringify(event.payload)}`);
        break;
      case "turn.started":
        lines.push(`[turn] ${String((event.payload as Record<string, unknown>).input ?? "")}`);
        break;
      case "content.delta":
        lines.push(`[delta] ${String((event.payload as Record<string, unknown>).delta ?? "")}`);
        break;
      case "tool.call":
        lines.push(
          `[tool] call ${String((event.payload as Record<string, unknown>).toolName ?? "unknown")} ${JSON.stringify((event.payload as Record<string, unknown>).input ?? {})}`,
        );
        break;
      case "tool.result":
        lines.push(
          `[tool] result ${String(
            (event.payload as Record<string, unknown>).error
            ?? (event.payload as Record<string, unknown>).output
            ?? "",
          )}`,
        );
        break;
      case "warning.raised":
        lines.push(`[warning] ${String((event.payload as Record<string, unknown>).warning ?? "")}`);
        break;
      case "error.raised":
        lines.push(`[error] ${String((event.payload as Record<string, unknown>).message ?? "")}`);
        break;
      case "turn.completed":
        lines.push(`[turn] completed ${JSON.stringify(event.payload)}`);
        break;
      default:
        lines.push(`[${event.type}] ${JSON.stringify(event.payload)}`);
        break;
    }
  }

  return lines.join("\n");
}

export function serializeTrace(events: Iterable<GemmaDesktopEvent>): string {
  return JSON.stringify([...events], null, 2);
}
