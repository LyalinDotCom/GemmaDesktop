import type { GemmaDesktopEvent, ModeSelection, SessionInput, TurnResult } from "@gemma-desktop/sdk-core";
import { renderTrace } from "@gemma-desktop/sdk-core";

export type BenchmarkClassification = "success" | "partial" | "failed" | "misconfigured";

export interface ScenarioEvaluation {
  classification: BenchmarkClassification;
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface HarnessScenario {
  id: string;
  prompt: SessionInput;
  mode: ModeSelection;
  systemInstructions?: string;
  metadata?: Record<string, unknown>;
  evaluate?: (result: TurnResult) => Promise<ScenarioEvaluation> | ScenarioEvaluation;
}

export interface SessionLike {
  runStreamed(input: SessionInput): Promise<{
    events: AsyncGenerator<GemmaDesktopEvent>;
    completed: Promise<TurnResult>;
  }>;
}

export interface SessionFactory {
  create(input: {
    runtime: string;
    model: string;
    mode: ModeSelection;
    systemInstructions?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionLike>;
}

export interface HarnessRunnerOptions {
  factory: SessionFactory;
}

export interface BenchmarkResult {
  scenarioId: string;
  runtimeId: string;
  modelId: string;
  classification: BenchmarkClassification;
  notes: string[];
  turn: TurnResult;
  traceText: string;
  events: GemmaDesktopEvent[];
  metadata?: Record<string, unknown>;
}

export function defineScenario(scenario: HarnessScenario): HarnessScenario {
  return scenario;
}

export class HarnessRunner {
  private readonly factory: SessionFactory;

  public constructor(options: HarnessRunnerOptions) {
    this.factory = options.factory;
  }

  public async runScenario(input: {
    scenario: HarnessScenario;
    runtime: string;
    model: string;
  }): Promise<BenchmarkResult> {
    const session = await this.factory.create({
      runtime: input.runtime,
      model: input.model,
      mode: input.scenario.mode,
      systemInstructions: input.scenario.systemInstructions,
      metadata: input.scenario.metadata,
    });

    const streamed = await session.runStreamed(input.scenario.prompt);
    const events: GemmaDesktopEvent[] = [];
    for await (const event of streamed.events) {
      events.push(event);
    }
    const turn = await streamed.completed;
    const evaluated = input.scenario.evaluate ? await input.scenario.evaluate(turn) : undefined;

    const notes = [
      ...turn.warnings,
      ...(evaluated?.notes ?? []),
    ];

    const classification =
      evaluated?.classification ??
      (turn.warnings.some((warning) => /misconfig|missing|unsupported|budget/i.test(warning))
        ? "misconfigured"
        : "success");

    return {
      scenarioId: input.scenario.id,
      runtimeId: input.runtime,
      modelId: input.model,
      classification,
      notes,
      turn,
      traceText: renderTrace(events),
      events,
      metadata: evaluated?.metadata,
    };
  }
}
