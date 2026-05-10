export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image_url';
      url: string;
      mediaType?: string;
    }
  | {
      type: 'audio_url';
      url: string;
      mediaType?: string;
    }
  | {
      type: 'video_url';
      url: string;
      mediaType?: string;
    }
  | {
      type: 'pdf_url';
      url: string;
      mediaType?: string;
    };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: Role;
  content: MessageContent;
}

export interface StreamChunk {
  content?: string;
  thinking?: string;
  status?: string;
  done?: boolean;
  doneReason?: string;
  raw?: unknown;
}

export interface GenerateOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  contextTokens?: number;
  keepAlive?: string;
  reasoningMode?: 'auto' | 'on' | 'off';
  signal?: AbortSignal;
  includeRawChunks?: boolean;
  onActivity?(chunk: StreamChunk): void | Promise<void>;
}

export interface ModelProvider {
  readonly name: string;
  generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
}

export interface StreamingModelProvider extends ModelProvider {
  generateStream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<StreamChunk>;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  meta?: ToolResultMeta;
}

export interface ToolResultMeta {
  fileChange?: FileChangeMeta;
  presentation?: 'notice';
  runningCommand?: RunningCommandMeta;
}

export interface RunningCommandMeta {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited';
  elapsedMs: number;
  outputChars: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface FileChangeMeta {
  tool: 'write_file' | 'edit_file' | 'apply_patch';
  changes: FileChange[];
}

export interface FileChange {
  path: string;
  status: 'created' | 'overwritten' | 'updated' | 'deleted' | 'renamed';
  oldPath?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  linesAdded?: number;
  linesRemoved?: number;
  hunks?: FileHunk[];
  preview?: string;
  language?: string;
}

export interface FileHunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, string>;
  readonly requiredParameters?: string[];
  readonly parameterAliases?: Record<string, string[]>;
  readonly examples?: Array<Record<string, unknown>>;
  readonly capability?: 'read' | 'write' | 'command' | 'shell';
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface AgentTurn {
  kind: 'tool' | 'final';
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export interface AgentToolStartEvent {
  index: number;
  toolCall: ToolCall;
}

export interface AgentTurnEvent {
  index: number;
  turn: AgentTurn;
}

export interface AgentModelEvent {
  index: number;
  finalization?: boolean;
}

export interface AgentModelActivityEvent {
  index: number;
  chunk: StreamChunk;
  finalization?: boolean;
}

export interface AgentRunOptions {
  attachments?: ContentPart[];
  onModelStart?(event: AgentModelEvent): void | Promise<void>;
  onModelActivity?(event: AgentModelActivityEvent): void | Promise<void>;
  onToolStart?(event: AgentToolStartEvent): void | Promise<void>;
  onTurn?(event: AgentTurnEvent): void | Promise<void>;
}

export interface AgentRunResult {
  answer: string;
  turns: AgentTurn[];
  stats: RunStats;
  completionStatus?: 'completed' | 'incomplete';
  completionReason?: string;
}

export interface RunStats {
  durationMs: number;
  turns: number;
  toolCalls: number;
}
