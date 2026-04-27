import { Ajv } from "ajv";
import type {
  ModelToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolResult,
} from "@gemma-desktop/sdk-core";
import { GemmaDesktopError, parseToolCallInput } from "@gemma-desktop/sdk-core";

export interface ToolPermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolPermissionPolicy {
  authorize(input: {
    tool: ToolDefinition;
    toolCall: ModelToolCall;
    context: ToolExecutionContext;
  }): Promise<ToolPermissionDecision>;
}

export interface RegisteredTool<Input = unknown> extends ToolDefinition {
  execute(input: Input, context: ToolExecutionContext): Promise<Omit<ToolResult, "callId" | "toolName">>;
}

export function allowAllToolsPolicy(): ToolPermissionPolicy {
  return {
    async authorize() {
      return { allowed: true };
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  public register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  public registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  public get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  public list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  public definitions(names?: string[]): ToolDefinition[] {
    const tools = names ? names.map((name) => this.tools.get(name)).filter(Boolean) as RegisteredTool[] : this.list();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      strict: tool.strict,
      metadata: tool.metadata,
    }));
  }
}

export interface ToolRuntimeOptions {
  registry: ToolRegistry;
  toolNames?: string[];
  policy?: ToolPermissionPolicy;
}

const TOOL_NAME_ALIASES: Record<string, string[]> = {
  execute_command: ["exec_command"],
  run_command: ["exec_command"],
  google_search: ["search_web"],
  web_search: ["search_web"],
};

const TOOL_ACTION_ALIASES: Record<string, Record<string, string>> = {
  browser: {
    open_url: "open",
    new_page: "open",
    open_page: "open",
    navigate_page: "navigate",
    open_current_tab: "navigate",
    list_pages: "tabs",
    list_tabs: "tabs",
    select_page: "focus",
    select_tab: "focus",
    focus_tab: "focus",
    take_snapshot: "snapshot",
    capture_snapshot: "snapshot",
    press_key: "press",
    type_text: "type",
    fill_input: "fill",
    close_page: "close",
    close_tab: "close",
  },
  chrome_devtools: {
    open_url: "open",
    new_page: "open",
    open_page: "open",
    navigate_page: "navigate",
    open_current_tab: "navigate",
    list_pages: "tabs",
    list_tabs: "tabs",
    select_page: "focus",
    select_tab: "focus",
    focus_tab: "focus",
    take_snapshot: "snapshot",
    capture_snapshot: "snapshot",
    press_key: "press",
    type_text: "type",
    fill_input: "fill",
    close_page: "close",
    close_tab: "close",
  },
};

const TOOL_INPUT_PROPERTY_ALIASES: Record<string, string[]> = {
  content: ["contents"],
  path: ["filePath", "filepath"],
  command: ["cmd"],
  query: ["queries", "searchQuery", "searchTerm"],
  goal: ["query", "queries", "prompt", "objective", "task"],
};

function buildToolNameCandidates(name: string): string[] {
  const candidates = new Set<string>();
  const push = (candidate: string | undefined): void => {
    if (candidate && candidate.length > 0) {
      candidates.add(candidate);
    }
  };

  const pushAliases = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }
    for (const alias of TOOL_NAME_ALIASES[candidate] ?? []) {
      push(alias);
    }
  };

  const pushNameVariants = (candidate: string | undefined): void => {
    if (!candidate || candidate.length === 0) {
      return;
    }

    push(candidate);
    const normalizedCandidate = normalizeToolName(candidate);
    push(normalizedCandidate);
    pushAliases(candidate);
    pushAliases(normalizedCandidate);
  };

  pushNameVariants(name);

  const namespacedSegments = name.split(/[:.]/);
  if (namespacedSegments.length > 1) {
    const suffix = namespacedSegments.at(-1);
    pushNameVariants(suffix);
  }

  return [...candidates];
}

function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isToolExposed(name: string, toolNames?: string[]): boolean {
  return !toolNames || toolNames.includes(name);
}

function schemaAcceptsActionAlias(schema: ToolDefinition["inputSchema"], action: string): boolean {
  if (
    !schema
    || typeof schema !== "object"
    || schema.type !== "object"
    || !schema.properties
    || typeof schema.properties !== "object"
  ) {
    return false;
  }

  const actionSchema = (schema.properties as Record<string, unknown>).action;
  if (!actionSchema || typeof actionSchema !== "object") {
    return false;
  }

  const enumValues = Array.isArray((actionSchema as { enum?: unknown[] }).enum)
    ? (actionSchema as { enum: unknown[] }).enum
    : null;

  return enumValues?.includes(action) ?? false;
}

function resolveToolActionAlias(toolName: string, action: string): string {
  const normalizedToolName = normalizeToolName(toolName);
  const normalizedAction = normalizeToolName(action);
  return TOOL_ACTION_ALIASES[normalizedToolName]?.[normalizedAction] ?? normalizedAction;
}

function injectToolAction(input: unknown, action: string): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    return record.action === action
      ? record
      : {
          ...record,
          action,
        };
  }

  if (typeof input === "string" && input.trim().length > 0) {
    return {
      action,
      raw: input,
    };
  }

  return { action };
}

function resolveNamespacedActionAlias(
  name: string,
  input: unknown,
  registry: ToolRegistry,
  toolNames?: string[],
): { tool: RegisteredTool; resolvedToolName: string; normalizedInput: unknown } | null {
  const segments = name.split(/[:.]/).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const actionCandidate = segments.at(-1)!;
  const toolNameSeed = segments.at(-2)!;
  const resolvedToolName = buildToolNameCandidates(toolNameSeed).find((candidate) => {
    const tool = registry.get(candidate);
    return Boolean(tool) && isToolExposed(candidate, toolNames);
  });

  if (!resolvedToolName) {
    return null;
  }

  const tool = registry.get(resolvedToolName);
  const resolvedAction = resolveToolActionAlias(resolvedToolName, actionCandidate);
  if (!tool || !schemaAcceptsActionAlias(tool.inputSchema, resolvedAction)) {
    return null;
  }

  return {
    tool,
    resolvedToolName,
    normalizedInput: injectToolAction(input, resolvedAction),
  };
}

export class ToolRuntime implements ToolExecutor {
  private readonly ajv = new Ajv({
    strict: false,
    allErrors: true,
  });
  private readonly registry: ToolRegistry;
  private readonly toolNames?: string[];
  private readonly policy: ToolPermissionPolicy;

  public constructor(options: ToolRuntimeOptions) {
    this.registry = options.registry;
    this.toolNames = options.toolNames;
    this.policy = options.policy ?? allowAllToolsPolicy();
  }

  public listTools(): ToolDefinition[] {
    return this.registry.definitions(this.toolNames);
  }

  public async execute(toolCall: ModelToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const parsedInput = parseToolCallInput(toolCall.input);
    const resolvedToolName = buildToolNameCandidates(toolCall.name).find((candidate) => {
      const tool = this.registry.get(candidate);
      return Boolean(tool) && isToolExposed(candidate, this.toolNames);
    });
    const tool = resolvedToolName ? this.registry.get(resolvedToolName) : undefined;
    const namespacedAlias =
      tool || resolvedToolName
        ? null
        : resolveNamespacedActionAlias(
            toolCall.name,
            parsedInput,
            this.registry,
            this.toolNames,
          );
    const resolvedTool = namespacedAlias
      ?? (tool && resolvedToolName
        ? {
            tool,
            resolvedToolName,
            normalizedInput: parsedInput,
          }
        : null);

    if (!resolvedTool) {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        `Tool "${toolCall.name}" is not registered in the active tool surface.`,
      );
    }

    const activeTool = resolvedTool.tool;
    const activeToolName = resolvedTool.resolvedToolName;
    const normalizedInput = coerceToolInputForSchema(
      resolvedTool.normalizedInput,
      activeTool.inputSchema,
    );
    const normalizedToolCall =
      normalizedInput === toolCall.input && activeToolName === toolCall.name
        ? toolCall
        : {
            ...toolCall,
            name: activeToolName,
            input: normalizedInput,
          };

    const validate = this.ajv.compile(activeTool.inputSchema);
    if (!validate(normalizedToolCall.input)) {
      throw new GemmaDesktopError("invalid_tool_input", `Invalid input for tool "${toolCall.name}".`, {
        details: {
          errors: validate.errors ?? [],
        },
      });
    }

    const decision = await this.policy.authorize({
      tool: activeTool,
      toolCall: normalizedToolCall,
      context,
    });

    if (!decision.allowed) {
      throw new GemmaDesktopError("permission_denied", decision.reason ?? `Execution denied for tool "${activeTool.name}".`);
    }

    try {
      const result = await activeTool.execute(normalizedToolCall.input, context);
      return {
        callId: toolCall.id,
        toolName: activeTool.name,
        title: result.title,
        output: result.output,
        structuredOutput: result.structuredOutput,
        attachments: result.attachments,
        metadata: result.metadata,
      };
    } catch (error) {
      const details: Record<string, unknown> = {};
      if (error instanceof GemmaDesktopError) {
        details.causeKind = error.kind;
        if (error.details) {
          details.causeDetails = error.details;
        }
      }

      if (error instanceof Error && error.message.trim().length > 0) {
        details.causeMessage = error.message.trim();
      } else if (typeof error === "string" && error.trim().length > 0) {
        details.causeMessage = error.trim();
      }

      throw new GemmaDesktopError("tool_execution_failed", `Tool "${activeTool.name}" failed.`, {
        cause: error,
        details: Object.keys(details).length > 0 ? details : undefined,
        raw: error instanceof GemmaDesktopError ? error.raw : undefined,
      });
    }
  }
}

function coerceToolInputForSchema(input: unknown, schema: ToolDefinition["inputSchema"]): unknown {
  if (!schema || typeof schema !== "object") {
    return input;
  }

  if (typeof input === "string" && schema.type === "object") {
    return {
      raw: input,
    };
  }

  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || schema.type !== "object"
    || !schema.properties
    || typeof schema.properties !== "object"
  ) {
    return input;
  }

  const properties = schema.properties as Record<string, unknown>;
  const record = input as Record<string, unknown>;
  let normalized: Record<string, unknown> | null = null;

  for (const [canonicalName, aliases] of Object.entries(TOOL_INPUT_PROPERTY_ALIASES)) {
    if (!(canonicalName in properties)) {
      continue;
    }

    const propertySchema = properties[canonicalName];

    for (const alias of aliases) {
      if (!(alias in record) || alias in properties) {
        continue;
      }

      normalized ??= { ...record };
      if (!(canonicalName in normalized)) {
        normalized[canonicalName] = coerceToolInputAliasValue(
          normalized[alias],
          propertySchema,
          canonicalName,
        );
      }
      delete normalized[alias];
    }
  }

  if (normalized) {
    return normalized;
  }

  return input;
}

function coerceToolInputAliasValue(
  value: unknown,
  propertySchema: unknown,
  canonicalName: string,
): unknown {
  if (!propertySchema || typeof propertySchema !== "object") {
    return value;
  }

  const schemaRecord = propertySchema as Record<string, unknown>;
  if (schemaRecord.type === "string") {
    if (Array.isArray(value)) {
      const parts = value.filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (parts.length === 0) {
        return "";
      }
      if (canonicalName === "query") {
        return parts[0];
      }
      return parts.join("\n");
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }

  return value;
}
