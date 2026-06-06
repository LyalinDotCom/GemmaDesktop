import type { AgentRunOptions, AgentRunResult, AgentTurn, ChatMessage, ContentPart, FileChange, GenerateOptions, ModelProvider, RunningCommandMeta, StreamChunk, Tool, ToolCall, ToolResult } from './types.js';
import {
  buildGemmaThinkingInstructions,
  looksLikeGemmaNativeToolCall,
  modelProfileFor,
  normalizeGemmaModelOutput,
  parseGemmaNativeToolCall,
  renderGemmaNativeToolDeclarations
} from './modelProfiles.js';

export interface AgentGitContext {
  branch?: string;
  dirty?: boolean;
  repoRoot?: string;
  lastCommit?: string;
}

export interface AgentEnvironment {
  platform?: string;
  arch?: string;
  osRelease?: string;
  shell?: string;
  nodeVersion?: string;
  date?: string;
  time?: string;
  timezone?: string;
  git?: AgentGitContext;
}

export interface AgentOptions {
  provider: ModelProvider;
  tools?: Tool[];
  maxTurns?: number | null;
  generation?: GenerateOptions;
  systemContext?: string[];
  workspace?: string;
  model?: string;
  reasoningMode?: GenerateOptions['reasoningMode'];
  history?: ChatMessage[];
  environment?: AgentEnvironment;
  yolo?: boolean;
}

export interface AgentSystemPromptOptions {
  tools?: Tool[];
  systemContext?: string[];
  workspace?: string;
  model?: string;
  reasoningMode?: GenerateOptions['reasoningMode'];
  environment?: AgentEnvironment;
  yolo?: boolean;
}

export class Agent {
  private readonly provider: ModelProvider;
  private readonly tools: Map<string, Tool>;
  private readonly maxTurns: number | undefined;
  private readonly generation: GenerateOptions;
  private readonly systemContext: string[];
  private readonly workspace?: string;
  private readonly model?: string;
  private readonly reasoningMode?: GenerateOptions['reasoningMode'];
  private readonly history: ChatMessage[];
  private readonly environment?: AgentEnvironment;
  private readonly yolo: boolean;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
    this.maxTurns = options.maxTurns === null ? undefined : options.maxTurns ?? 32;
    this.generation = options.generation ?? {};
    this.systemContext = options.systemContext ?? [];
    this.workspace = options.workspace;
    this.model = options.model;
    this.reasoningMode = options.reasoningMode;
    this.history = options.history ?? [];
    this.environment = options.environment;
    this.yolo = options.yolo ?? false;
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const userContent: string | ContentPart[] = options.attachments?.length
      ? [{ type: 'text', text: prompt }, ...options.attachments]
      : prompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...normalizeHistoryForPrompt(this.history),
      { role: 'user', content: userContent }
    ];
    const turns: AgentTurn[] = [];
    let validationRetryCount = 0;
    let noToolActionRetryCount = 0;
    let insufficientEvidenceRetryCount = 0;
    let prematureWorkspaceFinalRetryCount = 0;
    let suspiciousWorkspaceContentRetryCount = 0;
    let emptyResponseRetryCount = 0;
    let outputLimitRetryCount = 0;
    let transientTransportRetryCount = 0;
    let malformedResponseRetryCount = 0;
    let forceReasoningOffNextTurn = false;

    const maxTurns = this.maxTurns;
    for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn += 1) {
      await options.onModelStart?.({ index: turn });
      const protocolMonitor = new ModelProtocolMonitor();
      let raw: string;
      try {
        const turnMessages = messagesForContext(forceReasoningOffNextTurn
          ? replaceInitialSystemPrompt(messages, this.systemPrompt('off'))
          : messages, this.generation.contextTokens);
        raw = await this.provider.generate(turnMessages, {
          ...this.generation,
          ...(forceReasoningOffNextTurn ? { reasoningMode: 'off' as const } : {}),
          onActivity: async (chunk) => {
            protocolMonitor.observe(chunk);
            await this.generation.onActivity?.(chunk);
            await options.onModelActivity?.({ index: turn, chunk });
          }
        });
        forceReasoningOffNextTurn = false;
      } catch (error) {
        if (error instanceof CompleteToolCallStreamError) {
          raw = error.raw;
          forceReasoningOffNextTurn = false;
        } else if (error instanceof ProtocolRetryError) {
          forceReasoningOffNextTurn = true;
          messages.push({ role: 'user', content: error.retryInstruction });
          continue;
        } else if (isEmptyModelContentError(error) && emptyResponseRetryCount < 2) {
          emptyResponseRetryCount += 1;
          forceReasoningOffNextTurn = true;
          messages.push({ role: 'user', content: EMPTY_MODEL_RESPONSE_RETRY_INSTRUCTION });
          continue;
        } else if (isOutputLimitModelError(error) && outputLimitRetryCount < 1) {
          outputLimitRetryCount += 1;
          forceReasoningOffNextTurn = true;
          messages.push({ role: 'user', content: OUTPUT_LIMIT_RETRY_INSTRUCTION });
          continue;
        } else if (isTransientModelTransportError(error) && !this.generation.signal?.aborted && transientTransportRetryCount < 1) {
          transientTransportRetryCount += 1;
          forceReasoningOffNextTurn = true;
          messages.push({ role: 'user', content: TRANSIENT_MODEL_TRANSPORT_RETRY_INSTRUCTION });
          continue;
        } else {
          throw error;
        }
      }
      const action = parseActionOrRecoveryInstruction(raw);
      if ('retryInstruction' in action) {
        malformedResponseRetryCount += 1;
        if (malformedResponseRetryCount > 2) {
          const answer = [
            'Stopped because the model repeatedly produced malformed Gemma CLI protocol responses.',
            'The last parser recovery instruction could not get the model back to a valid JSON action.'
          ].join(' ');
          const finalTurn = { kind: 'final' as const, content: answer };
          const nextTurns = [...turns, finalTurn];
          await options.onTurn?.({ index: nextTurns.length - 1, turn: finalTurn });
          return {
            answer,
            turns: nextTurns,
            stats: this.stats(startedAt, nextTurns),
            completionStatus: 'incomplete',
            completionReason: 'model_response_malformed'
          };
        }
        messages.push({ role: 'user', content: action.retryInstruction });
        continue;
      }
      malformedResponseRetryCount = 0;

      if ('answer' in action) {
        const noToolActionRetry = buildNoToolActionRetryInstruction(prompt, action.answer, turns, [...this.tools.values()]);
        if (noToolActionRetry && noToolActionRetryCount < 2) {
          noToolActionRetryCount += 1;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: noToolActionRetry });
          continue;
        }
        const insufficientEvidenceRetry = buildInsufficientWorkspaceEvidenceRetryInstruction(prompt, action.answer, turns, [...this.tools.values()]);
        if (insufficientEvidenceRetry && insufficientEvidenceRetryCount < 2) {
          insufficientEvidenceRetryCount += 1;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: insufficientEvidenceRetry });
          continue;
        }
        const prematureWorkspaceFinalRetry = buildPrematureWorkspaceFinalRetryInstruction(prompt, action.answer, turns, [...this.tools.values()]);
        if (prematureWorkspaceFinalRetry && prematureWorkspaceFinalRetryCount < 2) {
          prematureWorkspaceFinalRetryCount += 1;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: prematureWorkspaceFinalRetry });
          continue;
        }
        const validationRetry = buildValidationRetryInstruction(prompt, action.answer, turns);
        if (validationRetry && validationRetryCount < 2) {
          validationRetryCount += 1;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: validationRetry });
          continue;
        }
        const suspiciousWorkspaceContentRetry = buildSuspiciousWorkspaceContentRetryInstruction(turns);
        if (suspiciousWorkspaceContentRetry && suspiciousWorkspaceContentRetryCount < 2) {
          suspiciousWorkspaceContentRetryCount += 1;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: suspiciousWorkspaceContentRetry });
          continue;
        }
        const exhaustedPrematureFinalBlocker = looksLikePrematureWorkspaceFinal(action.answer)
          ? buildPrematureWorkspaceFinalRetryInstruction(prompt, action.answer, turns, [...this.tools.values()])
          : undefined;
        if (exhaustedPrematureFinalBlocker) {
          const answer = [
            'Stopped before accepting the final answer because the session evidence is incomplete.',
            exhaustedPrematureFinalBlocker
          ].join(' ');
          const finalTurn = { kind: 'final' as const, content: answer };
          turns.push(finalTurn);
          await options.onTurn?.({ index: turns.length - 1, turn: finalTurn });
          return {
            answer,
            turns,
            stats: this.stats(startedAt, turns),
            completionStatus: 'incomplete',
            completionReason: 'final_response_unverified'
          };
        }
        const finalTurn = { kind: 'final' as const, content: action.answer };
        turns.push(finalTurn);
        await options.onTurn?.({ index: turns.length - 1, turn: finalTurn });
        return { answer: action.answer, turns, stats: this.stats(startedAt, turns), completionStatus: 'completed' };
      }

      const turnIndex = turns.length;
      await options.onToolStart?.({ index: turnIndex, toolCall: action });
      const tool = this.tools.get(action.tool);
      if (!tool) {
        const content = unknownToolMessage(action.tool);
        const toolTurn = { kind: 'tool' as const, content, toolCall: action, toolResult: { ok: false, output: content } };
        turns.push(toolTurn);
        await options.onTurn?.({ index: turnIndex, turn: toolTurn });
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'tool', content });
        continue;
      }

      const evidenceFailure = validateToolCallEvidence(action, turns, prompt);
      const result = evidenceFailure ?? await runToolSafely(tool, action);
      const toolTurn = {
        kind: 'tool',
        content: result.output,
        toolCall: action,
        toolResult: result
      } as const;
      turns.push(toolTurn);
      await options.onTurn?.({ index: turnIndex, turn: toolTurn });
      if (action.tool === 'finalize_build' && result.ok && result.meta?.terminal === true) {
        const finalTurn = { kind: 'final' as const, content: result.output };
        turns.push(finalTurn);
        await options.onTurn?.({ index: turns.length - 1, turn: finalTurn });
        return {
          answer: result.output,
          turns,
          stats: this.stats(startedAt, turns),
          completionStatus: 'completed'
        };
      }
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Tool result for ${action.tool}:\n${JSON.stringify({ ok: result.ok, output: result.output })}`
      });
    }

    if (maxTurns === undefined) {
      throw new Error('Internal error: uncapped agent loop exited unexpectedly.');
    }

    if (turns.at(-1)?.kind === 'tool') {
      const failedFinalizeResult = failedFinalizeBuildAtMaxTurns(maxTurns, turns);
      if (failedFinalizeResult) {
        await options.onTurn?.({ index: failedFinalizeResult.turns.length - 1, turn: failedFinalizeResult.turns.at(-1)! });
        return {
          ...failedFinalizeResult,
          stats: this.stats(startedAt, failedFinalizeResult.turns)
        };
      }
      return await this.runFinalResponsePass(prompt, messages, options, startedAt, turns, maxTurns);
    }

    const answer = `Stopped after ${maxTurns} turns without a final answer.`;
    const finalTurn = { kind: 'final' as const, content: answer };
    const nextTurns = [...turns, finalTurn];
    return {
      answer,
      turns: nextTurns,
      stats: this.stats(startedAt, nextTurns),
      completionStatus: 'incomplete',
      completionReason: 'max_turns'
    };
  }

  private systemPrompt(reasoningMode: GenerateOptions['reasoningMode'] = this.reasoningMode): string {
    return buildAgentSystemPrompt({
      tools: [...this.tools.values()],
      systemContext: this.systemContext,
      workspace: this.workspace,
      model: this.model,
      reasoningMode,
      environment: this.environment,
      yolo: this.yolo
    });
  }

  private stats(startedAt: number, turns: AgentTurn[]) {
    return {
      durationMs: Date.now() - startedAt,
      turns: turns.length,
      toolCalls: turns.filter((turn) => turn.kind === 'tool').length
    };
  }

  private async runFinalResponsePass(
    prompt: string,
    messages: ChatMessage[],
    options: AgentRunOptions,
    startedAt: number,
    turns: AgentTurn[],
    maxTurns: number
  ): Promise<AgentRunResult> {
    const finalMessages = messagesForContext(replaceInitialSystemPrompt([
      ...messages,
      { role: 'user' as const, content: FINAL_RESPONSE_PASS_INSTRUCTION }
    ], this.systemPrompt('off')), this.generation.contextTokens);
    await options.onModelStart?.({ index: maxTurns, finalization: true });
    const raw = await this.provider.generate(finalMessages, {
      ...this.generation,
      maxTokens: finalResponseMaxTokens(this.generation.maxTokens),
      reasoningMode: 'off',
      onActivity: async (chunk) => {
        await this.generation.onActivity?.(chunk);
        await options.onModelActivity?.({ index: maxTurns, chunk, finalization: true });
      }
    });
    const action = parseActionOrRecoveryInstruction(raw);
    let answer: string;
    let completionStatus: AgentRunResult['completionStatus'] = 'completed';
    let completionReason: string | undefined;

    if ('retryInstruction' in action) {
      answer = [
        `Stopped after ${maxTurns} turns immediately after tool use.`,
        'The final summary pass produced malformed JSON instead of a user-facing answer.'
      ].join(' ');
      completionStatus = 'incomplete';
      completionReason = 'final_response_malformed';
    } else if ('answer' in action) {
      answer = action.answer;
      const evidenceBlocker = buildFinalResponseEvidenceBlocker(prompt, answer, turns, [...this.tools.values()]);
      if (evidenceBlocker) {
        answer = [
          `Stopped after ${maxTurns} turns immediately after tool use.`,
          'The final summary pass could not be accepted as completed because the session evidence is incomplete.',
          evidenceBlocker,
          'Resume the session or increase --max-turns so the agent can complete the missing workspace action and validation.'
        ].join(' ');
        completionStatus = 'incomplete';
        completionReason = 'final_response_unverified';
      }
    } else {
      answer = [
        `Stopped after ${maxTurns} turns immediately after tool use.`,
        `The final summary pass attempted another tool (${action.tool}) instead of telling you what happened.`
      ].join(' ');
      completionStatus = 'incomplete';
      completionReason = 'final_response_requested_tool';
    }

    const finalTurn = { kind: 'final' as const, content: answer };
    const nextTurns = [...turns, finalTurn];
    await options.onTurn?.({ index: nextTurns.length - 1, turn: finalTurn });
    return {
      answer,
      turns: nextTurns,
      stats: this.stats(startedAt, nextTurns),
      completionStatus,
      ...(completionReason ? { completionReason } : {})
    };
  }
}

function failedFinalizeBuildAtMaxTurns(
  maxTurns: number,
  turns: AgentTurn[]
): Omit<AgentRunResult, 'stats'> | undefined {
  const lastTurn = turns.at(-1);
  if (lastTurn?.kind !== 'tool' || lastTurn.toolCall?.tool !== 'finalize_build' || lastTurn.toolResult?.ok !== false) {
    return undefined;
  }

  const output = firstSentenceLikeLine(lastTurn.toolResult.output) || 'The finalize_build tool rejected the completion evidence.';
  const answer = [
    `Stopped after ${maxTurns} turns immediately after a rejected finalize_build call.`,
    output,
    'Resume the session or increase --max-turns so the agent can correct the final completion evidence.'
  ].join(' ');
  const finalTurn = { kind: 'final' as const, content: answer };
  return {
    answer,
    turns: [...turns, finalTurn],
    completionStatus: 'incomplete',
    completionReason: 'finalize_build_failed_at_max_turns'
  };
}

function buildFinalResponseEvidenceBlocker(prompt: string, answer: string, turns: AgentTurn[], tools: Tool[]): string | undefined {
  const prematureWorkspaceFinalRetry = buildPrematureWorkspaceFinalRetryInstruction(prompt, answer, turns, tools);
  if (prematureWorkspaceFinalRetry) {
    return firstSentenceLikeLine(prematureWorkspaceFinalRetry);
  }
  const validationRetry = buildValidationRetryInstruction(prompt, answer, turns);
  if (validationRetry) {
    return firstSentenceLikeLine(validationRetry);
  }
  const insufficientEvidenceRetry = buildInsufficientWorkspaceEvidenceRetryInstruction(prompt, answer, turns, tools);
  if (insufficientEvidenceRetry) {
    return firstSentenceLikeLine(insufficientEvidenceRetry);
  }
  return undefined;
}

function firstSentenceLikeLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? text.trim();
}

function normalizeHistoryForPrompt(history: ChatMessage[]): ChatMessage[] {
  return history.map((message) => {
    if (message.role !== 'tool') {
      return message;
    }
    return {
      role: 'user',
      content: `Previous tool result:\n${messageContentToText(message.content)}`
    };
  });
}

function replaceInitialSystemPrompt(messages: ChatMessage[], content: string): ChatMessage[] {
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content }, ...messages.slice(1)];
  }
  return [{ role: 'system', content }, ...messages];
}

function messageContentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => part.type === 'text' ? part.text : `[${part.type}:${part.url}]`).join('\n');
}

const CONTEXT_ESTIMATED_CHARS_PER_TOKEN = 4;
const CONTEXT_COMPACTION_TRIGGER_FRACTION = 0.8;
const CONTEXT_COMPACTION_RECENT_MESSAGES = 24;
const CONTEXT_COMPACTION_SUMMARY_MAX_MESSAGES = 24;
const CONTEXT_COMPACTION_PREVIEW_CHARS = 700;
const CONTEXT_COMPACTION_CLIPPED_MESSAGE_CHARS = 900;
const CONTEXT_COMPACTION_PROTECTED_RECENT_MESSAGES = 6;
const TOOL_RESULT_PROTECTION_CHARS = 200_000;
const TOOL_RESULT_PRUNABLE_TRIGGER_CHARS = 120_000;
const TOOL_RESULT_PREVIEW_LINE_COUNT = 20;
const TOOL_RESULT_PREVIEW_CHARS = 1_200;

function messagesForContext(messages: ChatMessage[], contextTokens: number | undefined): ChatMessage[] {
  const contextMessages = maskOlderBulkyToolResults(messages);
  const budgetChars = contextBudgetChars(contextTokens);
  if (!budgetChars || messageCharCount(contextMessages) <= budgetChars) {
    return contextMessages;
  }
  return compactMessagesForContext(contextMessages, budgetChars);
}

function contextBudgetChars(contextTokens: number | undefined): number | undefined {
  if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return undefined;
  }
  return Math.floor(contextTokens * CONTEXT_ESTIMATED_CHARS_PER_TOKEN * CONTEXT_COMPACTION_TRIGGER_FRACTION);
}

function compactMessagesForContext(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  if (messages.length <= 4) {
    return clipCompactedMessages(messages, budgetChars);
  }

  const preservedIndices = new Set<number>();
  const prefix: ChatMessage[] = [];
  if (messages[0]?.role === 'system') {
    prefix.push(messages[0]);
    preservedIndices.add(0);
  }

  const firstUserIndex = messages.findIndex((message, index) => !preservedIndices.has(index) && message.role === 'user');
  if (firstUserIndex >= 0) {
    prefix.push(messages[firstUserIndex]);
    preservedIndices.add(firstUserIndex);
  }

  const suffixStart = Math.max(0, messages.length - CONTEXT_COMPACTION_RECENT_MESSAGES);
  const suffixIndices = new Set<number>();
  for (let index = suffixStart; index < messages.length; index += 1) {
    if (!preservedIndices.has(index)) {
      suffixIndices.add(index);
    }
  }

  const middle = messages.filter((_, index) => !preservedIndices.has(index) && !suffixIndices.has(index));
  const suffix = messages.filter((_, index) => suffixIndices.has(index));
  const compacted = middle.length > 0
    ? [...prefix, buildCompactedHistoryMessage(middle), ...suffix]
    : [...prefix, ...suffix];

  if (messageCharCount(compacted) <= budgetChars) {
    return compacted;
  }

  return clipCompactedMessages(compacted, budgetChars);
}

function buildCompactedHistoryMessage(messages: ChatMessage[]): ChatMessage {
  const shown = messages.slice(-CONTEXT_COMPACTION_SUMMARY_MAX_MESSAGES);
  const omitted = messages.length - shown.length;
  const entries = shown.map((message, index) => {
    const sourceIndex = omitted + index + 1;
    return `- ${sourceIndex}. ${message.role}: ${messagePreview(message)}`;
  });

  return {
    role: 'user',
    content: [
      'Earlier conversation compacted to stay within the model context budget.',
      `Compacted messages: ${messages.length}${omitted > 0 ? `; showing latest ${shown.length}` : ''}.`,
      'The system instructions, original user request, and recent turns are preserved outside this summary.',
      ...entries
    ].join('\n')
  };
}

function clipCompactedMessages(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  let compacted = messages;
  if (messageCharCount(compacted) <= budgetChars) {
    return compacted;
  }

  const firstSystemIndex = compacted[0]?.role === 'system' ? 0 : -1;
  const firstUserIndex = compacted.findIndex((message, index) => index !== firstSystemIndex && message.role === 'user');
  const protectedRecentStart = Math.max(0, compacted.length - CONTEXT_COMPACTION_PROTECTED_RECENT_MESSAGES);
  compacted = compacted.map((message, index) => {
    const protectedMessage = index === firstSystemIndex || index === firstUserIndex || index >= protectedRecentStart;
    if (protectedMessage || messageContentLength(message.content) <= CONTEXT_COMPACTION_CLIPPED_MESSAGE_CHARS) {
      return message;
    }
    return {
      ...message,
      content: clipMessageContent(message.content, CONTEXT_COMPACTION_CLIPPED_MESSAGE_CHARS)
    };
  });

  return compacted;
}

function messagePreview(message: ChatMessage): string {
  return truncateContextText(messageContentToText(message.content), CONTEXT_COMPACTION_PREVIEW_CHARS);
}

function messageCharCount(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + message.role.length + messageContentLength(message.content) + 2, 0);
}

function messageContentLength(content: ChatMessage['content']): number {
  return messageContentToText(content).length;
}

function clipMessageContent(content: ChatMessage['content'], maxChars: number): ChatMessage['content'] {
  if (typeof content === 'string') {
    return truncateContextText(content, maxChars);
  }
  return content.map((part) => part.type === 'text'
    ? { ...part, text: truncateContextText(part.text, maxChars) }
    : part);
}

function truncateContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars < 80) {
    return `${text.slice(0, maxChars)}...`;
  }
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n...[truncated ${omitted} chars]...\n${text.slice(-tailChars)}`;
}

interface ParsedToolResultPrompt {
  header: string;
  output: string;
  payload?: Record<string, unknown>;
}

function maskOlderBulkyToolResults(messages: ChatMessage[]): ChatMessage[] {
  let protectedChars = 0;
  let prunableChars = 0;
  const maskIndexes = new Set<number>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = parseToolResultPrompt(messages[index]);
    if (!parsed || parsed.output.includes('<tool_output_masked>')) {
      continue;
    }

    const outputChars = parsed.output.length;
    const isLatestMessage = index === messages.length - 1;
    if (isLatestMessage || protectedChars + outputChars <= TOOL_RESULT_PROTECTION_CHARS) {
      protectedChars += outputChars;
      continue;
    }

    prunableChars += outputChars;
    maskIndexes.add(index);
  }

  if (prunableChars < TOOL_RESULT_PRUNABLE_TRIGGER_CHARS || maskIndexes.size === 0) {
    return messages;
  }

  return messages.map((message, index) => {
    if (!maskIndexes.has(index)) {
      return message;
    }
    const parsed = parseToolResultPrompt(message);
    if (!parsed) {
      return message;
    }
    return {
      ...message,
      content: formatMaskedToolResultPrompt(parsed)
    };
  });
}

function parseToolResultPrompt(message: ChatMessage): ParsedToolResultPrompt | undefined {
  if (message.role !== 'user' || typeof message.content !== 'string') {
    return undefined;
  }
  const newline = message.content.indexOf('\n');
  if (newline < 0) {
    return undefined;
  }
  const header = message.content.slice(0, newline);
  if (!/^Previous tool result(?: for \S+)?:$/.test(header) && !/^Tool result for \S+:$/.test(header)) {
    return undefined;
  }

  const body = message.content.slice(newline + 1);
  try {
    const payload = JSON.parse(body) as unknown;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (typeof record.output === 'string') {
        return { header, output: record.output, payload: record };
      }
    }
  } catch {
    // Fall back to masking the raw body.
  }
  return { header, output: body };
}

function formatMaskedToolResultPrompt(parsed: ParsedToolResultPrompt): string {
  const maskedOutput = formatMaskedToolOutput(parsed.output);
  if (parsed.payload) {
    return [
      parsed.header,
      JSON.stringify({
        ...parsed.payload,
        output: maskedOutput
      })
    ].join('\n');
  }
  return [parsed.header, maskedOutput].join('\n');
}

function formatMaskedToolOutput(output: string): string {
  const preview = toolOutputPreview(output);
  return [
    '<tool_output_masked>',
    preview,
    '',
    `Output masked from model context: ${output.length} chars total.`,
    'Full output remains in Gemma CLI diagnostics; rerun a narrower read/search/command if the omitted details are needed.',
    '</tool_output_masked>'
  ].join('\n');
}

function toolOutputPreview(output: string): string {
  const lines = output.split(/\r?\n/);
  if (lines.length > TOOL_RESULT_PREVIEW_LINE_COUNT * 2) {
    const head = lines.slice(0, TOOL_RESULT_PREVIEW_LINE_COUNT);
    const tail = lines.slice(-TOOL_RESULT_PREVIEW_LINE_COUNT);
    return `${head.join('\n')}\n\n... [${lines.length - head.length - tail.length} lines omitted] ...\n\n${tail.join('\n')}`;
  }
  if (output.length <= TOOL_RESULT_PREVIEW_CHARS * 2) {
    return output;
  }
  return `${output.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n\n... [${output.length - TOOL_RESULT_PREVIEW_CHARS * 2} chars omitted] ...\n\n${output.slice(-TOOL_RESULT_PREVIEW_CHARS)}`;
}

function buildNoToolActionRetryInstruction(prompt: string, answer: string, turns: AgentTurn[], tools: Tool[]): string | undefined {
  if (turns.some((turn) => turn.kind === 'tool')) {
    return undefined;
  }
  if (!hasWorkspaceActionTools(tools)) {
    return undefined;
  }
  if (!looksLikeWorkspaceActionRequest(prompt)) {
    return undefined;
  }
  if (!looksLikeUngroundedActionAnswer(answer)) {
    return undefined;
  }
  const changeTools = availableMutationToolNames(tools);
  return [
    'The user asked for an actionable workspace change, but your previous response only promised or claimed work without using any tools.',
    'Do not answer with future-tense intent such as "I will" or "I can".',
    'Use tools now to inspect and change the workspace, then verify the result.',
    'Start with read_file, search_paths, search_text, or list_tree if you need context.',
    `Use ${changeTools.length > 0 ? changeTools.join(', ') : 'the available write or command tools'} for the actual change.`,
    'Only answer without tools if the request is impossible; in that case, state the concrete blocker.'
  ].join('\n');
}

function availableMutationToolNames(tools: Tool[]): string[] {
  const preferred = ['write_file', 'apply_patch', 'exec_command'];
  const names = new Set(tools.map((tool) => tool.name));
  return preferred.filter((name) => names.has(name));
}

function hasWorkspaceActionTools(tools: Tool[]): boolean {
  return tools.some((tool) => tool.capability === 'write' || tool.capability === 'command' || tool.name === 'write_file' || tool.name === 'apply_patch' || tool.name === 'exec_command');
}

function looksLikeWorkspaceActionRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/^\s*(?:why|what|how|explain|tell me|describe)\b/.test(text)) {
    return false;
  }
  if (/\b(plan|strategy|proposal)\b/.test(text) && !/\b(implement|code|file|app|project|script|src|test|fix|change|edit|update)\b/.test(text)) {
    return false;
  }
  return /\b(build|create|make|add|update|change|edit|fix|implement|enable|support|allow|improve|remove|delete|refactor|rename|convert|wire|hook|style|design|repair|patch)\b/.test(text)
    || /\blet\s+me\b/.test(text)
    || /\bmake\s+it\b/.test(text)
    || /\bcan\s+you\s+(?:make|add|update|change|fix|implement|enable|support|remove|refactor)\b/.test(text);
}

function looksLikeWorkspaceMutationRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(?:(?:validation|verification)-only|read-only)\b/.test(text)) {
    return false;
  }
  if (/\b(?:validation|verification)\s+only\b/.test(text)) {
    return false;
  }
  if (/\brecovery verification\b/.test(text)) {
    return false;
  }
  if (/\b(?:do\s+not|don't)\s+(?:edit|change|modify|write|patch|touch|update)\b/.test(text)) {
    return false;
  }
  return looksLikeWorkspaceActionRequest(prompt);
}

function looksLikeUngroundedActionAnswer(answer: string): boolean {
  const text = answer.trim().toLowerCase();
  if (!text) {
    return true;
  }
  return /\b(?:i\s+will|i'll|i\s+am\s+going\s+to|i'm\s+going\s+to|let\s+me|i\s+can|i'll\s+go|i\s+would)\b/.test(text)
    || /\b(?:will|can)\s+(?:update|implement|add|change|modify|fix|create|make|enable|support)\b/.test(text)
    || /\b(?:done|completed|updated|implemented|added|changed|fixed|created|enabled)\b/.test(text);
}

function buildInsufficientWorkspaceEvidenceRetryInstruction(prompt: string, answer: string, turns: AgentTurn[], tools: Tool[]): string | undefined {
  if (!hasWorkspaceActionTools(tools)) {
    return undefined;
  }
  if (!looksLikeWorkspaceActionRequest(prompt) || !looksLikeFileOrProjectRequest(prompt)) {
    return undefined;
  }
  if (!looksLikeUngroundedActionAnswer(answer) && !claimsValidationPassed(answer) && !looksLikePendingWorkspaceMutationAnswer(answer)) {
    return undefined;
  }

  const requestedTasks = requestedNpmValidationTasks(prompt);
  const successfulCommands = successfulExecCommands(turns);
  const missingTasks = requestedTasks.filter((task) => !successfulCommands.some((command) => commandSatisfiesNpmTask(command, task)));
  if (missingTasks.length > 0 && claimsValidationPassed(answer)) {
    return [
      'Your answer claims the requested validation passed, but the tool history does not contain successful command evidence for all requested npm validation.',
      `Missing validation evidence for: ${missingTasks.map(renderNpmTask).join(', ')}.`,
      'Use tools now to implement or inspect the workspace, then run the missing validation commands before answering.',
      'Only say validation passed when it is backed by completed successful exec_command or wait_command tool output from this run.'
    ].join('\n');
  }

  if (looksLikeWorkspaceMutationRequest(prompt) && !hasSubstantiveWorkspaceMutationEvidence(turns)) {
    return [
      'The user asked for a workspace change, but the tool history only shows inspection, directory setup, or validation.',
      'Successful validation alone is not evidence that the requested change was implemented.',
      'Use write_file, apply_patch, or a concrete workspace-mutating command now to make the requested change, then run meaningful verification before answering.',
      'Only answer without a file mutation if there is a concrete blocker; state that blocker plainly.'
    ].join('\n');
  }

  if (hasSubstantiveWorkspaceEvidence(turns)) {
    return undefined;
  }

  return [
    'The user asked for a file or project change, but the tool history so far does not show substantive file creation or editing.',
    'Directory creation, orientation, or empty command output is not enough evidence for a completed project or app.',
    'Use tools now to create or edit the requested files and run meaningful verification before answering.',
    'Only answer without more tools if there is a concrete blocker; state that blocker plainly.'
  ].join('\n');
}

function buildPrematureWorkspaceFinalRetryInstruction(prompt: string, answer: string, turns: AgentTurn[], tools: Tool[]): string | undefined {
  if (!hasWorkspaceActionTools(tools)) {
    return undefined;
  }
  if (!turns.some((turn) => turn.kind === 'tool')) {
    return undefined;
  }
  const pendingValidation = pendingRunningValidationCommand(turns);
  if (pendingValidation && claimsValidationPassed(answer)) {
    return [
      'Your previous response was premature: a validation command is still running and has not exited successfully yet.',
      `Still running: ${pendingValidation.command}.`,
      'Call wait_command now with the commandId from the running command result, then only say validation passed if it exits with 0.',
      'If it fails or keeps running without completion, report that concrete blocker instead of claiming success.'
    ].join('\n');
  }
  const unresolvedPatchPath = unresolvedFailedPatchPathBeforeSuccessAnswer(prompt, answer, turns);
  if (unresolvedPatchPath) {
    return [
      `Your previous response was premature: an apply_patch attempt failed for ${unresolvedPatchPath}, and no later successful file mutation repaired that target.`,
      'Do not rely on broad validation output if it does not explicitly cover the newly requested feature.',
      'Re-read the current target lines, make the missing implementation or validation change with an exact patch or appropriate write_file, then rerun meaningful validation.',
      'Only answer after the failed patch target is repaired, or after you report a concrete blocker.'
    ].join('\n');
  }
  if (latestMutationNeedsValidationAfterFailedRun(prompt, answer, turns)) {
    return [
      'Your previous response was a premature final answer: the latest file write has not been validated after earlier run or validation failures.',
      'Do not finalize immediately after rewriting a file that previously failed to run.',
      'Call exec_command now with the strongest relevant compile, run, test, or verifier command for the changed artifact.',
      'Only answer after that command succeeds, or after a concrete blocker prevents further progress.'
    ].join('\n');
  }
  const metricThresholdRetry = buildMetricThresholdMissRetryInstruction(prompt, answer, turns);
  if (metricThresholdRetry) {
    return metricThresholdRetry;
  }
  if (!looksLikePrematureWorkspaceFinal(answer)) {
    return undefined;
  }
  if (!looksLikeWorkspaceActionRequest(prompt) && !looksLikeFileOrProjectRequest(prompt) && !containsToolCallLikeJson(answer)) {
    return undefined;
  }
  return [
    'Your previous response was a premature final answer: it described code, commands, or a tool call that still needed to be written, run, or validated.',
    'Do not finalize while your answer says local work is still pending.',
    'Emit the next concrete JSON tool call now, using write_file, apply_patch, or exec_command as appropriate.',
    'Only answer after the workspace artifact exists and any useful validation has run, or after a concrete blocker prevents further progress.'
  ].join('\n');
}

function unresolvedFailedPatchPathBeforeSuccessAnswer(prompt: string, answer: string, turns: AgentTurn[]): string | undefined {
  if (!looksLikeWorkspaceActionRequest(prompt) && !looksLikeFileOrProjectRequest(prompt)) {
    return undefined;
  }
  if (!claimsWorkspaceArtifactDone(answer) && !claimsValidationPassed(answer)) {
    return undefined;
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (
      turn.kind !== 'tool'
      || turn.toolCall?.tool !== 'apply_patch'
      || turn.toolResult?.ok !== false
      || typeof turn.toolCall.args.patch !== 'string'
      || !/apply_patch: hunk .* did not match/i.test(turn.toolResult.output)
    ) {
      continue;
    }
    const path = primaryPatchPath(turn.toolCall.args.patch);
    const laterRepair = turns.slice(index + 1).some((candidate) => {
      if (candidate.kind !== 'tool' || candidate.toolResult?.ok !== true || !candidate.toolCall || !isFileMutationTool(candidate.toolCall.tool)) {
        return false;
      }
      if (!path) {
        return true;
      }
      return fileMutationPaths(candidate.toolCall).some((candidatePath) => candidatePath === path);
    });
    if (!laterRepair) {
      return path ?? 'the failed patch target';
    }
  }
  return undefined;
}

function latestMutationNeedsValidationAfterFailedRun(prompt: string, answer: string, turns: AgentTurn[]): boolean {
  if (!looksLikeWorkspaceActionRequest(prompt) && !looksLikeFileOrProjectRequest(prompt)) {
    return false;
  }
  if (!claimsWorkspaceArtifactDone(answer)) {
    return false;
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  if (lastMutationIndex === -1) {
    return false;
  }
  const successfulRunAfterLatestMutation = turns
    .slice(lastMutationIndex + 1)
    .some((turn) => {
      const evidence = successfulCommandEvidenceFromTurn(turn);
      return Boolean(evidence && looksLikeValidationOrRunCommand(evidence.command));
    });
  if (successfulRunAfterLatestMutation) {
    return false;
  }
  return turns.slice(0, lastMutationIndex).some((turn, index) =>
    turn.kind === 'tool'
    && turn.toolCall?.tool === 'exec_command'
    && turn.toolResult?.ok === false
    && typeof turn.toolCall.args.command === 'string'
    && looksLikeValidationOrRunCommand(turn.toolCall.args.command)
    && findLastToolTurnIndex(turns.slice(0, index), isWorkspaceMutationTurn) !== -1
  );
}

function buildMetricThresholdMissRetryInstruction(prompt: string, answer: string, turns: AgentTurn[]): string | undefined {
  if (!looksLikeWorkspaceActionRequest(prompt) && !looksLikeFileOrProjectRequest(prompt)) {
    return undefined;
  }
  if (/\b(?:could not|couldn'?t|cannot|can'?t|unable|failed|failing|blocked|miss(?:ed|es)?|above (?:the )?(?:target|threshold)|does not meet|did not meet|not meet)\b/i.test(answer)) {
    return undefined;
  }
  const misses = latestMetricThresholdMisses(prompt, turns);
  if (misses.length === 0) {
    return undefined;
  }
  return [
    'Your previous response was premature: the latest validation metrics still miss explicit target thresholds from the task.',
    `Missed thresholds: ${misses.slice(0, 6).join('; ')}${misses.length > 6 ? '; ...' : ''}.`,
    'Do not finalize while measured metrics are above required thresholds.',
    'Use the metrics and target table to revise the artifact, then rerun the relevant verifier or metric command.',
    'Only answer after the metrics meet the thresholds, or after you state a concrete blocker with the measured misses.'
  ].join('\n');
}

type MetricKey = 'cost' | 'padRatio' | 'p95Latency' | 'sequentialTimecost';

const METRIC_LABELS: Record<MetricKey, string> = {
  cost: 'Cost',
  padRatio: 'Pad Ratio',
  p95Latency: 'P95 Latency',
  sequentialTimecost: 'Sequential Timecost'
};

function latestMetricThresholdMisses(prompt: string, turns: AgentTurn[]): string[] {
  const thresholds = parsePromptMetricThresholds(prompt);
  if (thresholds.size === 0) {
    return [];
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  if (lastMutationIndex === -1) {
    return [];
  }
  const latestMetricRun = [...turns]
    .slice(lastMutationIndex + 1)
    .reverse()
    .map(successfulCommandEvidenceFromTurn)
    .find((evidence) => evidence && looksLikeMetricReport(evidence.output));
  if (!latestMetricRun) {
    return [];
  }
  return compareMetricReportToThresholds(latestMetricRun.output, thresholds);
}

function parsePromptMetricThresholds(prompt: string): Map<string, Partial<Record<MetricKey, number>>> {
  if (!/\bthresholds?\b/i.test(prompt) || !/\b(?:below|under|less than|at most|no more than)\b[\s\S]{0,120}\bthresholds?\b/i.test(prompt)) {
    return new Map();
  }
  const thresholds = new Map<string, Partial<Record<MetricKey, number>>>();
  for (const line of prompt.split(/\r?\n/)) {
    if (!line.includes('|') || !/\.jsonl\b/i.test(line)) {
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(cleanMetricCell);
    if (cells.length < 5) {
      continue;
    }
    const file = basenameLike(cells[0]);
    if (!file.endsWith('.jsonl')) {
      continue;
    }
    const cost = parseMetricNumber(cells[1]);
    const padRatio = parseMetricNumber(cells[2]);
    const p95Latency = parseMetricNumber(cells[3]);
    const sequentialTimecost = parseMetricNumber(cells[4]);
    const metrics: Partial<Record<MetricKey, number>> = {};
    if (cost !== undefined) metrics.cost = cost;
    if (padRatio !== undefined) metrics.padRatio = padRatio;
    if (p95Latency !== undefined) metrics.p95Latency = p95Latency;
    if (sequentialTimecost !== undefined) metrics.sequentialTimecost = sequentialTimecost;
    if (Object.keys(metrics).length > 0) {
      thresholds.set(file, metrics);
    }
  }
  return thresholds;
}

function looksLikeMetricReport(output: string): boolean {
  const labels = [
    /\bCost\s*[:=]/i,
    /\bPad(?:\s+Ratio)?\s*[:=]/i,
    /\bP95(?:\s+Latency)?(?:\s*\(ms\))?\s*[:=]/i,
    /\b(?:Sequential\s+Timecost|SeqTime)\s*[:=]/i
  ];
  return labels.filter((label) => label.test(output)).length >= 2;
}

function compareMetricReportToThresholds(output: string, thresholds: Map<string, Partial<Record<MetricKey, number>>>): string[] {
  const misses: string[] = [];
  let currentFile: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const bucketMatch = line.match(/^\s*Bucket\s+([A-Za-z0-9_-]+)\s*:/i);
    const reportFile = bucketMatch ? fileForBucketLabel(bucketMatch[1] ?? '', thresholds) : currentFile;
    const fileMatch = line.match(/^\s*File:\s*(.+?)\s*$/i);
    if (fileMatch) {
      currentFile = basenameLike(fileMatch[1] ?? '');
      continue;
    }
    if (!reportFile) {
      continue;
    }
    const fileThresholds = thresholds.get(reportFile);
    if (!fileThresholds) {
      continue;
    }
    for (const metric of Object.keys(METRIC_LABELS) as MetricKey[]) {
      const actual = metricValueFromLine(line, metric);
      const threshold = fileThresholds[metric];
      if (actual === undefined || threshold === undefined) {
        continue;
      }
      if (actual > threshold) {
        misses.push(`${reportFile} ${METRIC_LABELS[metric]} ${formatMetricNumber(actual)} > ${formatMetricNumber(threshold)}`);
      }
    }
  }
  return misses;
}

function metricValueFromLine(line: string, metric: MetricKey): number | undefined {
  const aliases: Record<MetricKey, string[]> = {
    cost: ['Cost'],
    padRatio: ['Pad Ratio', 'Pad'],
    p95Latency: ['P95 Latency', 'P95'],
    sequentialTimecost: ['Sequential Timecost', 'SeqTime']
  };
  const aliasPattern = aliases[metric].map((item) => item.replace(/\s+/g, '\\s+')).join('|');
  const match = line.match(new RegExp(`(?:^|\\b)(?:${aliasPattern})(?:\\s*\\(ms\\))?\\s*[:=]\\s*([^\\s,|]+)`, 'i'));
  return match ? parseMetricNumber(match[1] ?? '') : undefined;
}

function fileForBucketLabel(bucket: string, thresholds: Map<string, Partial<Record<MetricKey, number>>>): string | undefined {
  const files = [...thresholds.keys()];
  const normalized = bucket.replace(/^0+/, '') || bucket;
  const escaped = escapeRegExp(normalized);
  const byName = files.find((file) => new RegExp(`(?:^|[_-])0*${escaped}(?:\\D|$)`, 'i').test(file));
  if (byName) {
    return byName;
  }
  const index = Number(normalized);
  return Number.isInteger(index) && index >= 1 ? files[index - 1] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanMetricCell(value: string): string {
  return value.replace(/`/g, '').trim();
}

function basenameLike(value: string): string {
  return cleanMetricCell(value).split('/').filter(Boolean).at(-1) ?? '';
}

function parseMetricNumber(value: string): number | undefined {
  const normalized = value.replace(/,/g, '').match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i)?.[0];
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatMetricNumber(value: number): string {
  return Math.abs(value) >= 10000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)
    ? value.toExponential(3)
    : String(value);
}

function claimsWorkspaceArtifactDone(answer: string): boolean {
  if (/\b(?:blocked|failed|failing|could not|couldn'?t|can'?t|cannot|unable|error|segmentation fault|segfault)\b/i.test(answer)) {
    return false;
  }
  return /\b(?:done|completed|implemented|created|wrote|written|updated|fixed|finished|ready)\b/i.test(answer)
    || /\b(?:compile|run|execute|test|validate|verify)\b.{0,80}\b(?:command|using|with|to)\b/i.test(answer)
    || /\b(?:gcc|g\+\+|clang|cc|make|cmake|pytest|python|node|npm|go|cargo)\b[\s\S]{0,160}\b(?:&&|\s-o\s|test|run|check|validate|verify)\b/i.test(answer);
}

function looksLikeFileOrProjectRequest(prompt: string): boolean {
  return /\b(project|app|site|website|game|webgame|canvas|file|files|module|package\.json|src|test|tests|script|utility|cli|component|page|artifact|artifacts|workspace|solution|task_file|output_data|output file|folder with|directory with)\b/i.test(prompt);
}

function looksLikePrematureWorkspaceFinal(answer: string): boolean {
  const text = answer.trim();
  if (!text) {
    return false;
  }
  if (containsToolCallLikeJson(text)) {
    return true;
  }
  const pendingWorkPattern = /\b(?:wait,?\s*)?(?:i\s+(?:should|need to|will|(?:'|’)ll|would|can)|let\s+me|now,?\s*i|actually,?\s*i)\b[\s\S]{0,220}\b(?:write|save|create|edit|modify|run|execute|test|validate|check|generate|implement|use)\b/i;
  if (pendingWorkPattern.test(text)) {
    return true;
  }
  if (looksLikePendingWorkspaceMutationAnswer(text)) {
    return true;
  }
  return /```[\s\S]{80,}```/m.test(text)
    && /\b(?:write|save|run|execute|test|validate|output|artifact|workspace|file)\b/i.test(text)
    && /\b(?:i\s+(?:should|need to|will|(?:'|’)ll)|let\s+me|actually|wait)\b/i.test(text);
}

function looksLikePendingWorkspaceMutationAnswer(answer: string): boolean {
  const text = answer.trim().toLowerCase();
  if (!text) {
    return false;
  }
  return /\b(?:did not|didn'?t|have not|haven'?t|not)\s+(?:edit|change|modify|write|patch|update|implement|apply)\b/.test(text)
    || /\b(?:next step|remaining step|to proceed|still need|needs to|should)\b[\s\S]{0,180}\b(?:add|update|edit|implement|change|write|patch|modify|create|fix)\b/.test(text)
    || /\bwithout\s+(?:that|the|this)?\s*(?:edit|change|update|implementation|patch)\b/.test(text)
    || /\bpartially\s+(?:implemented|complete|done)\b/.test(text)
    || /\b(?:hasn'?t|haven'?t|has not|have not|not)\s+been\s+(?:applied|implemented|wired|added|updated|completed)\b/.test(text)
    || /\bwould\s+you\s+like\s+me\s+to\s+(?:retry|continue|finish|fix|read|use|attempt)\b/.test(text);
}

function containsToolCallLikeJson(text: string): boolean {
  const normalized = repairJsonSmartQuotes(text).replace(/\\"/g, '"');
  return /["']tool["']\s*:\s*["'](?:write_file|apply_patch|exec_command|read_file|read_files|list_tree|search_paths|search_text|inspect_file)["']/i.test(normalized);
}

function hasSubstantiveWorkspaceEvidence(turns: AgentTurn[]): boolean {
  return turns.some((turn) => {
    if (turn.kind !== 'tool' || turn.toolResult?.ok !== true) {
      return false;
    }
    if (isFileMutationTool(turn.toolCall?.tool)) {
      return hasSubstantiveFileMutationEvidence(turn);
    }
    if (turn.toolCall?.tool !== 'exec_command') {
      return false;
    }
    const command = typeof turn.toolCall.args.command === 'string' ? turn.toolCall.args.command : '';
    return command.trim().length > 0 && !isThinDirectoryCommand(command);
  });
}

function hasSubstantiveWorkspaceMutationEvidence(turns: AgentTurn[]): boolean {
  return turns.some((turn) => {
    if (turn.kind !== 'tool' || turn.toolResult?.ok !== true) {
      return false;
    }
    if (isFileMutationTool(turn.toolCall?.tool)) {
      return hasSubstantiveFileMutationEvidence(turn);
    }
    if (turn.toolCall?.tool !== 'exec_command') {
      return false;
    }
    const command = typeof turn.toolCall.args.command === 'string' ? turn.toolCall.args.command : '';
    return isSubstantiveWorkspaceMutationCommand(command)
      && !isCosmeticValidationStatusMutationCommand(command);
  });
}

function isWorkspaceMutationTurn(turn: AgentTurn): boolean {
  if (turn.kind !== 'tool' || turn.toolResult?.ok !== true) {
    return false;
  }
  if (isFileMutationTool(turn.toolCall?.tool)) {
    return hasSubstantiveFileMutationEvidence(turn);
  }
  if (turn.toolCall?.tool !== 'exec_command') {
    return false;
  }
  const command = typeof turn.toolCall.args.command === 'string' ? turn.toolCall.args.command : '';
  return isSubstantiveWorkspaceMutationCommand(command);
}

function isSubstantiveWorkspaceMutationCommand(command: string): boolean {
  const normalized = normalizeCommandForEvidence(command);
  if (isThinDirectoryCommand(normalized)) {
    return false;
  }
  return /(?:^|[;&|]\s*)(?:sed\s+-i|perl\s+-pi|touch|tee|cp|mv|rm|truncate)\b/.test(normalized)
    || hasFileOutputRedirection(normalized)
    || /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|renameSync|unlinkSync|mkdirSync)\b/.test(normalized)
    || /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:create|init|install|add|remove|uninstall|exec|dlx)\b/.test(normalized)
    || /(?:^|[;&|]\s*)(?:npx|uvx)\s+\S+/.test(normalized)
    || /(?:^|[;&|]\s*)(?:cargo\s+new|go\s+mod\s+init)\b/.test(normalized);
}

function hasSubstantiveFileMutationEvidence(turn: AgentTurn): boolean {
  const fileChange = turn.toolResult?.meta?.fileChange;
  if (!fileChange) {
    return true;
  }
  return fileChange.changes.some(isSubstantiveFileChange);
}

function isSubstantiveFileChange(change: FileChange): boolean {
  if (change.status === 'deleted' || change.status === 'renamed') {
    return true;
  }

  if (change.preview !== undefined) {
    return hasSubstantiveChangedText(change.preview);
  }

  const changedLines = [
    ...(change.hunks ?? []).flatMap((hunk) => [...hunk.oldLines, ...hunk.newLines])
  ];
  if (changedLines.length > 0) {
    return changedLines.some(hasSubstantiveChangedLine);
  }

  const hasLineMetadata = change.linesAdded !== undefined || change.linesRemoved !== undefined || change.hunks !== undefined;
  if (hasLineMetadata) {
    return false;
  }

  return true;
}

function hasSubstantiveChangedText(text: string): boolean {
  return text.split(/\r?\n/).some(hasSubstantiveChangedLine);
}

function hasSubstantiveChangedLine(line: string): boolean {
  return line.trim().length > 0;
}

function isCosmeticValidationStatusMutationCommand(command: string): boolean {
  const normalized = normalizeCommandForEvidence(command);
  if (!isSubstantiveWorkspaceMutationCommand(normalized)) {
    return false;
  }
  return /\b(?:validation\s+pass|all\s+checks\s+confirmed|all\s+(?:tests?|checks?|validation)\s+(?:passed|pass|succeeded|successful|green)|(?:tests?|checks?|validation)\s+(?:passed|pass|succeeded|successful|green)|features?\s+validated|fully\s+validated)\b/i.test(normalized);
}

function hasFileOutputRedirection(command: string): boolean {
  const redirections = command.matchAll(/(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*([^&|\s;]+)/g);
  for (const redirection of redirections) {
    const target = stripShellQuotes(redirection[1] ?? '');
    if (
      target.length > 0
      && !/^&?\d+$/.test(target)
      && target !== '-'
      && target !== '/dev/null'
      && !target.startsWith('/dev/fd/')
    ) {
      return true;
    }
  }
  return false;
}

function stripShellQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function isThinDirectoryCommand(command: string): boolean {
  const normalized = normalizeCommandForEvidence(command);
  return /^mkdir(?:\s+-[a-zA-Z]+)*\s+/.test(normalized);
}

function buildValidationRetryInstruction(prompt: string, answer: string, turns: AgentTurn[]): string | undefined {
  if (!validationWasRequested(prompt) && !mentionsValidationNotRun(answer)) {
    return undefined;
  }
  const pendingValidation = pendingRunningValidationCommand(turns);
  if (pendingValidation && claimsValidationPassed(answer)) {
    return [
      'Validation is still required before the final answer.',
      `The validation command is still running and has not exited with 0 yet: ${pendingValidation.command}.`,
      'Call wait_command now with the commandId from that running command result.',
      'Only say validation passed after wait_command reports the command exited with 0.'
    ].join('\n');
  }
  if (validationWasRequested(prompt) && claimsValidationPassed(answer) && !hasSuccessfulValidationCommand(turns)) {
    return [
      'Validation is still required before the final answer.',
      'Your answer claims validation passed, but this run has no completed successful validation command evidence.',
      'Run the requested validation command now, or wait for the running command to exit if one is still active.',
      'Only say validation passed after an exec_command or wait_command result shows the validation exited with 0.'
    ].join('\n');
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  if (lastMutationIndex === -1) {
    return undefined;
  }
  const requestedTasks = requestedNpmValidationTasks(prompt);
  if (requestedTasks.length > 0) {
    const successfulCommandsAfterMutation = successfulExecCommands(turns.slice(lastMutationIndex + 1));
    const missingTasks = requestedTasks.filter((task) => !successfulCommandsAfterMutation.some((command) => commandSatisfiesNpmTask(command, task)));
    if (missingTasks.length === 0) {
      return undefined;
    }
    return [
      'Validation is still required before the final answer.',
      `The user asked for ${missingTasks.map(renderNpmTask).join(' and ')}, but there is no completed successful command evidence for that after the last file change.`,
      'Run the missing validation command now, fix any failure, and only then answer.'
    ].join('\n');
  }
  const validatedAfterMutation = turns
    .slice(lastMutationIndex + 1)
    .some((turn) => successfulCommandEvidenceFromTurn(turn) !== undefined);
  if (validatedAfterMutation) {
    return undefined;
  }
  return [
    'Validation is still required before the final answer.',
    'You changed workspace files after the last successful command, and the user asked for validation or the draft answer says validation did not run.',
    'Do not answer yet unless validation is impossible.',
    'Call exec_command now with the strongest relevant validation command, using the cwd parameter for the project directory when appropriate.',
    'If the command fails, inspect and fix the failure, then run validation again.'
  ].join('\n');
}

function buildSuspiciousWorkspaceContentRetryInstruction(turns: AgentTurn[]): string | undefined {
  const latestMutation = latestFileMutation(turns);
  if (!latestMutation) {
    return undefined;
  }
  const output = latestMutation.turn.toolResult?.output ?? latestMutation.turn.content;
  const match = output.match(/suspicious text detected in ([^:\n]+):\s*([^\n]+)/i);
  if (!match) {
    return undefined;
  }
  const path = match[1]?.trim() || 'the generated file';
  const line = match[2]?.trim() || 'suspicious generated content';
  return [
    'A recent file write reported suspicious generated content, and no later clean file mutation replaced it.',
    `File: ${path}`,
    `Suspicious line: ${line}`,
    'Do not finalize this artifact yet. Inspect the file, then remove or replace mock/stub/placeholder/comment-only logic with the best real implementation you can produce.',
    'Run a concrete validation command afterward. Only answer if the artifact has been corrected or if validation proves a concrete blocker that you cannot resolve.'
  ].join('\n');
}

function latestFileMutation(turns: AgentTurn[]): { index: number; turn: AgentTurn } | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.kind === 'tool' && isFileMutationTool(turn.toolCall?.tool)) {
      return { index, turn };
    }
  }
  return undefined;
}

function findLastToolTurnIndex(turns: AgentTurn[], predicate: (turn: AgentTurn) => boolean): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (predicate(turns[index])) {
      return index;
    }
  }
  return -1;
}

function isFileMutationTool(tool: string | undefined): boolean {
  return tool === 'write_file' || tool === 'apply_patch' || tool === 'edit_file';
}

function validateToolCallEvidence(action: ToolCall, turns: AgentTurn[], prompt: string): ToolResult | undefined {
  const patchRecovery = patchContextRecoveryRequiredResult(action, turns);
  if (patchRecovery) {
    return patchRecovery;
  }
  const duplicateFailedPatch = duplicateFailedPatchRetryResult(action, turns);
  if (duplicateFailedPatch) {
    return duplicateFailedPatch;
  }
  const stalePatchReadLoop = stalePatchReadLoopResult(action, turns);
  if (stalePatchReadLoop) {
    return stalePatchReadLoop;
  }
  const cosmeticSuccessEdit = cosmeticSuccessMessageEditAfterValidationResult(action, turns);
  if (cosmeticSuccessEdit) {
    return cosmeticSuccessEdit;
  }
  const cosmeticSuccessCommandEdit = cosmeticSuccessCommandEditAfterValidationResult(action, turns);
  if (cosmeticSuccessCommandEdit) {
    return cosmeticSuccessCommandEdit;
  }
  const duplicateCommand = duplicateSuccessfulValidationCommandResult(action, turns);
  if (duplicateCommand) {
    return duplicateCommand;
  }
  if (action.tool !== 'finalize_build') {
    return undefined;
  }
  if (promptExplicitlyForbidsFinalizeBuild(prompt)) {
    return {
      ok: false,
      output: [
        'finalize_build rejected: the current user prompt explicitly said not to call finalize_build.',
        'Continue with the requested non-finalizing work, or answer directly after the requested evidence is complete.'
      ].join('\n'),
      meta: { presentation: 'notice' }
    };
  }
  if (looksLikeWorkspaceMutationRequest(prompt) && !hasSubstantiveWorkspaceMutationEvidence(turns)) {
    return {
      ok: false,
      output: [
        'finalize_build rejected: the user asked for a workspace change, but this run has not produced substantive file mutation evidence.',
        'Inspection, directory setup, or successful validation alone is not evidence that the requested change was implemented.',
        'Use write_file, apply_patch, or a concrete workspace-mutating command to make the requested change, then run meaningful verification before finalizing.',
        'Only finalize without a mutation if there is a concrete blocker; state that blocker plainly in the final answer instead of recording a completed build.'
      ].join('\n'),
      meta: { presentation: 'notice' }
    };
  }
  const passCountThreshold = requestedValidationPassCountThreshold(prompt);
  if (passCountThreshold !== undefined) {
    const bestPassCount = highestCompletedValidationPassCount(turns);
    if (bestPassCount === undefined || bestPassCount <= passCountThreshold) {
      return {
        ok: false,
        output: [
          `finalize_build rejected: the user required validation pass count above ${passCountThreshold}, but this run does not have completed validation evidence above that threshold.`,
          bestPassCount === undefined
            ? 'No completed validation result with a parsed pass count was found in this run.'
            : `Highest completed validation pass count found: ${bestPassCount}.`,
          'Run or update validation so the completed output proves the requested higher pass count before finalizing.'
        ].join('\n'),
        meta: { presentation: 'notice' }
      };
    }
  }
  const passedCommands = claimedPassedValidationCommands(action.args.validation);
  if (passedCommands.length === 0) {
    return undefined;
  }
  const successfulCommands = successfulExecCommands(turns);
  const missingCommands = passedCommands.filter((command) => !successfulCommands.some((successful) => commandsMatch(command, successful)));
  if (missingCommands.length === 0) {
    return undefined;
  }
  return {
    ok: false,
    output: [
      'finalize_build rejected: passed validation must be backed by a completed successful exec_command or wait_command result from this run.',
      `Missing completed successful command result for: ${missingCommands.join(', ')}`,
      'Run the command first, or mark the validation as failed or blocked with the concrete reason.'
    ].join('\n'),
    meta: { presentation: 'notice' }
  };
}

function promptExplicitlyForbidsFinalizeBuild(prompt: string): boolean {
  return /\b(?:do\s+not|don't|dont|never)\b(?!\s+forget\b)[\s\S]{0,120}\b`?finalize_build`?\b/i.test(prompt)
    || /\b(?:without|no)\s+`?finalize_build`?\b/i.test(prompt);
}

function requestedValidationPassCountThreshold(prompt: string): number | undefined {
  const matches = prompt.matchAll(/\b(?:pass(?:ed)?\s+count|pass\s+count|count)\b.{0,60}\b(?:above|greater\s+than|more\s+than)\s+(\d+)\b/gi);
  let threshold: number | undefined;
  for (const match of matches) {
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(parsed)) {
      threshold = threshold === undefined ? parsed : Math.max(threshold, parsed);
    }
  }
  return threshold;
}

function highestCompletedValidationPassCount(turns: AgentTurn[]): number | undefined {
  let highest: number | undefined;
  for (const turn of turns) {
    const evidence = successfulCommandEvidenceFromTurn(turn);
    if (!evidence || !looksLikeValidationCommand(evidence.command)) {
      continue;
    }
    for (const passCount of validationPassCounts(evidence.output)) {
      highest = highest === undefined ? passCount : Math.max(highest, passCount);
    }
  }
  return highest;
}

function validationPassCounts(output: string): number[] {
  return [...output.matchAll(/\b(\d+)\s+passed\b/gi)]
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .filter((count) => Number.isFinite(count));
}

function duplicateFailedPatchRetryResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (action.tool !== 'apply_patch' || typeof action.args.patch !== 'string') {
    return undefined;
  }
  const patch = normalizePatchForDuplicateCheck(action.args.patch);
  const path = primaryPatchPath(action.args.patch);
  let stalePatchFailures = 0;
  let staleFailuresForPath = 0;
  const maxStalePatchFailuresBeforeBlock = 3;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.kind !== 'tool') {
      continue;
    }
    if (turn.toolResult?.ok === true && isFileMutationTool(turn.toolCall?.tool)) {
      return undefined;
    }
    if (
      turn.toolCall?.tool === 'apply_patch'
      && turn.toolResult?.ok === false
      && typeof turn.toolCall.args.patch === 'string'
      && normalizePatchForDuplicateCheck(turn.toolCall.args.patch) === patch
      && /apply_patch: hunk .* did not match/i.test(turn.toolResult.output)
    ) {
      return {
        ok: false,
        output: [
          'The exact same apply_patch hunk already failed because the patch context did not match.',
          'Do not retry that patch unchanged.',
          'The next action should be read_file, read_files, search_text, list_tree, or a read-only exec_command for the target file.',
          'After that fresh read, issue one smaller patch with current surrounding context, or use write_file only after reading the full current file and confirming full replacement is appropriate.'
        ].join('\n'),
        meta: { presentation: 'notice' }
      };
    }
    if (turn.toolCall?.tool !== 'apply_patch' || turn.toolResult?.ok !== false || typeof turn.toolCall.args.patch !== 'string') {
      continue;
    }
    if (!/apply_patch: hunk .* did not match/i.test(turn.toolResult.output)) {
      continue;
    }
    stalePatchFailures += 1;
    const previousPatch = turn.toolCall.args.patch;
    const samePath = path && primaryPatchPath(previousPatch) === path;
    if (samePath) {
      staleFailuresForPath += 1;
      if (staleFailuresForPath >= maxStalePatchFailuresBeforeBlock) {
        return {
          ok: false,
          output: [
            'Repeated apply_patch attempts against this same file have failed because patch context did not match.',
            'Stop calling apply_patch for this file in this run unless you have a genuinely different, exact hunk from a fresh read.',
            'Do not use exec_command, sed, cp, Python, or helper scripts to hand-edit source after stale patch failures.',
            'If patching is still blocked, read the full current file and use the write_file tool with overwriteExisting: true only when full replacement is appropriate.'
          ].join('\n'),
          meta: { presentation: 'notice' }
        };
      }
    }
    if (stalePatchFailures >= maxStalePatchFailuresBeforeBlock) {
      return {
        ok: false,
        output: [
          'Repeated apply_patch attempts have failed because patch context did not match.',
          'Stop retrying stale apply_patch context.',
          'Do not use exec_command, sed, cp, Python, or helper scripts to hand-edit source after stale patch failures.',
          'If patching is still blocked, read the full current file and use the write_file tool with overwriteExisting: true only when full replacement is appropriate.'
        ].join('\n'),
        meta: { presentation: 'notice' }
      };
    }
  }
  return undefined;
}

function stalePatchReadLoopResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (!isReadOnlyInspectionAction(action)) {
    return undefined;
  }
  const failure = lastPatchContextFailure(turns);
  if (!failure) {
    return undefined;
  }
  if (failure.path && !readOnlyActionMayInspectPath(action, failure.path)) {
    return undefined;
  }
  const turnsAfterFailure = turns.slice(failure.index + 1);
  if (turnsAfterFailure.some(isWorkspaceMutationTurn)) {
    return undefined;
  }
  const refreshCount = turnsAfterFailure.filter(isSuccessfulReadOnlyInspectionTurn).length;
  const maxReadOnlyRefreshesAfterStalePatch = 2;
  if (refreshCount < maxReadOnlyRefreshesAfterStalePatch) {
    return undefined;
  }
  return {
    ok: false,
    output: [
      `Read-only recovery loop guard: apply_patch already failed because the patch context did not match${failure.path ? ` in ${failure.path}` : ''}.`,
      `The agent has already refreshed context ${refreshCount} time${refreshCount === 1 ? '' : 's'} after that failure without making a successful file change.`,
      'Stop broad inspection. Use the refreshed context to issue one focused apply_patch hunk with exact current surrounding lines, or use write_file only after reading enough current content for an intentional full replacement.',
      'If the missing edit still cannot be made, report the concrete blocker instead of continuing read-only inspection.'
    ].join('\n'),
    meta: { presentation: 'notice' }
  };
}

function normalizePatchForDuplicateCheck(patch: string): string {
  return patch.replace(/\r\n/g, '\n').trim();
}

function primaryPatchPath(patch: string): string | undefined {
  const normalized = patch.replace(/\r\n/g, '\n');
  const updateFile = normalized.match(/^\*\*\* Update File:\s*(.+)$/m);
  if (updateFile?.[1]) {
    return updateFile[1].trim();
  }
  const destination = normalized.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  if (destination?.[1] && destination[1] !== '/dev/null') {
    return destination[1].trim();
  }
  const source = normalized.match(/^---\s+(?:a\/)?(.+)$/m);
  if (source?.[1] && source[1] !== '/dev/null') {
    return source[1].trim();
  }
  return undefined;
}

function patchContextRecoveryRequiredResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (!isFileMutationTool(action.tool)) {
    return undefined;
  }
  const failure = lastPatchContextFailure(turns);
  if (!failure || hasContextRefreshAfter(turns, failure.index)) {
    return undefined;
  }
  const mutationPaths = fileMutationPaths(action);
  if (failure.path && mutationPaths.length > 0 && !mutationPaths.includes(failure.path)) {
    return undefined;
  }
  return {
    ok: false,
    output: [
      `Previous apply_patch failed because the patch context did not match${failure.path ? ` in ${failure.path}` : ''}.`,
      'This guard applies to the latest failed patch attempt; reads from before that failed patch do not count as refreshed context.',
      'Before another file mutation, inspect the current file contents or nearby target region with read_file, read_files, search_text, list_tree, or a targeted read-only exec_command.',
      'Then issue a smaller patch with exact current context. Use write_file only after re-reading the current file and only when full replacement is appropriate. Do not retry stale patch context.'
    ].join('\n'),
    meta: { presentation: 'notice' }
  };
}

function lastPatchContextFailure(turns: AgentTurn[]): { index: number; path?: string } | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (
      turn.kind === 'tool'
      && turn.toolCall?.tool === 'apply_patch'
      && turn.toolResult?.ok === false
      && /apply_patch: hunk .* did not match/i.test(turn.toolResult.output)
    ) {
      const line = turn.toolResult.output.split('\n').find((item) => /apply_patch: hunk .* did not match/i.test(item));
      const path = line?.match(/ did not match in (.+)\.$/)?.[1]?.trim();
      return { index, path };
    }
  }
  return undefined;
}

function hasContextRefreshAfter(turns: AgentTurn[], failureIndex: number): boolean {
  return turns.slice(failureIndex + 1).some((turn) => {
    return isSuccessfulReadOnlyInspectionTurn(turn);
  });
}

function isSuccessfulReadOnlyInspectionTurn(turn: AgentTurn): boolean {
  if (turn.kind !== 'tool' || turn.toolResult?.ok !== true || !turn.toolCall) {
    return false;
  }
  return isReadOnlyInspectionAction(turn.toolCall);
}

function isReadOnlyInspectionAction(action: ToolCall): boolean {
  if (isReadOnlyInspectionTool(action.tool)) {
    return true;
  }
  if (action.tool !== 'exec_command' || typeof action.args.command !== 'string') {
    return false;
  }
  return looksLikeReadOnlyInspectionCommand(action.args.command);
}

function isReadOnlyInspectionTool(tool: string | undefined): boolean {
  return tool === 'read_file'
    || tool === 'read_files'
    || tool === 'search_text'
    || tool === 'search_paths'
    || tool === 'list_tree'
    || tool === 'inspect_file';
}

function readOnlyActionMayInspectPath(action: ToolCall, failedPath: string): boolean {
  if (action.tool === 'exec_command' && typeof action.args.command === 'string') {
    return action.args.command.includes(failedPath) || action.args.command.includes(failedPath.replace(/^\.\//, ''));
  }
  const requestedPaths = [action.args.path, action.args.target, action.args.file]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().replace(/^\.\//, ''));
  if (requestedPaths.length === 0 || action.tool === 'read_files') {
    return true;
  }
  const normalizedFailedPath = failedPath.replace(/^\.\//, '');
  return requestedPaths.some((requestedPath) =>
    requestedPath === normalizedFailedPath
    || normalizedFailedPath.startsWith(`${requestedPath}/`)
    || normalizedFailedPath.endsWith(`/${requestedPath}`)
    || requestedPath.endsWith(`/${normalizedFailedPath}`)
  );
}

function looksLikeReadOnlyInspectionCommand(command: string): boolean {
  return /\b(?:cat|sed|nl|rg|grep|ls|find|head|tail|wc|od)\b/.test(command.trim());
}

function fileMutationPaths(action: ToolCall): string[] {
  if (action.tool === 'write_file') {
    return [action.args.path, action.args.target, action.args.file]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());
  }
  if (action.tool !== 'apply_patch' || typeof action.args.patch !== 'string') {
    return [];
  }
  const paths = new Set<string>();
  for (const line of action.args.patch.split(/\r?\n/)) {
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) {
      continue;
    }
    const path = line.slice(4).trim().replace(/^[ab]\//, '');
    if (path && path !== '/dev/null') {
      paths.add(path);
    }
  }
  return [...paths];
}

function cosmeticSuccessMessageEditAfterValidationResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (!isFileMutationTool(action.tool)) {
    return undefined;
  }
  const newContent = typeof action.args.newText === 'string'
    ? action.args.newText
    : typeof action.args.content === 'string'
      ? action.args.content
      : typeof action.args.patch === 'string'
        ? action.args.patch
        : '';
  if (
    !/\b(?:all\s+)?(?:tests?|build|checks?|validation)\s+(?:passed|pass|succeeded|successful|green)\b/i.test(newContent)
    && !/\b(?:all\s+)?features?\s+validated\b/i.test(newContent)
    && !/\bfully\s+validated\b/i.test(newContent)
  ) {
    return undefined;
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  const successfulValidationAfterMutation = turns
    .slice(lastMutationIndex + 1)
    .some((turn) => {
      const evidence = successfulCommandEvidenceFromTurn(turn);
      return Boolean(evidence && looksLikeValidationCommand(evidence.command));
    });
  if (!successfulValidationAfterMutation) {
    return undefined;
  }
  return {
    ok: false,
    output: [
      'Refusing cosmetic success-message edit after validation already exited with 0.',
      'Do not change project files only to make test output say "passed"; trust the successful validation result and answer the user.',
      'Only edit files now if there is a real implementation or test-coverage gap, not a missing success log.'
    ].join('\n'),
    meta: { presentation: 'notice' }
  };
}

function cosmeticSuccessCommandEditAfterValidationResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (action.tool !== 'exec_command' || typeof action.args.command !== 'string') {
    return undefined;
  }
  const command = action.args.command;
  if (!isCosmeticValidationStatusMutationCommand(command)) {
    return undefined;
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  const successfulValidationAfterMutation = turns
    .slice(lastMutationIndex + 1)
    .some((turn) => {
      const evidence = successfulCommandEvidenceFromTurn(turn);
      return Boolean(evidence && looksLikeValidationCommand(evidence.command));
    });
  if (!successfulValidationAfterMutation) {
    return undefined;
  }
  return {
    ok: false,
    output: [
      'Refusing cosmetic validation-status shell edit after validation already exited with 0.',
      'Do not use exec_command to add comments or text such as "validation pass" or "all checks confirmed" only to create mutation evidence.',
      'Make the requested functional change, or if no change is needed, answer with the existing validation evidence instead of editing project files.'
    ].join('\n'),
    meta: { presentation: 'notice' }
  };
}

function duplicateSuccessfulValidationCommandResult(action: ToolCall, turns: AgentTurn[]): ToolResult | undefined {
  if (action.tool !== 'exec_command' || typeof action.args.command !== 'string') {
    return undefined;
  }
  const command = action.args.command.trim();
  if (!looksLikeValidationCommand(command)) {
    return undefined;
  }
  const lastMutationIndex = findLastToolTurnIndex(turns, isWorkspaceMutationTurn);
  const normalizedCommand = normalizeCommandForEvidence(command);
  const cwd = normalizeExecCwd(action.args.cwd);
  const previous = turns
    .slice(lastMutationIndex + 1)
    .find((turn) => {
      const evidence = successfulCommandEvidenceFromTurn(turn);
      return Boolean(
        evidence
        && normalizeCommandForEvidence(evidence.command) === normalizedCommand
        && evidence.cwd === cwd
      );
    });
  if (!previous?.toolResult) {
    return undefined;
  }
  return {
    ok: true,
    output: [
      `Command exited with 0 (reused previous successful validation): ${command}`,
      'This identical validation command already succeeded after the latest file change.',
      'Do not rerun identical validation only because stdout is short or lacks a success phrase; use this as passed validation or run a different check if one is genuinely needed.',
      previous.toolResult.output ? `Previous output:\n${previous.toolResult.output}` : undefined
    ].filter(Boolean).join('\n')
  };
}

function normalizeExecCwd(value: unknown): string {
  return typeof value === 'string' ? normalizeCommandForEvidence(value) : '';
}

function looksLikeValidationCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\b.*\b(test|build|check|typecheck|lint)\b/i.test(command)
    || /\b(node|python|pytest|go|cargo)\b.*\b(test|tests?|validate|check)\b/i.test(command);
}

function looksLikeValidationOrRunCommand(command: string): boolean {
  if (looksLikeValidationCommand(command)) {
    return true;
  }
  const normalized = normalizeCommandForEvidence(command);
  return /(?:^|[;&|]\s*)(?:gcc|g\+\+|clang|cc)\b[\s\S]*\s-o\s+\S+/i.test(normalized)
    || /(?:^|[;&|]\s*)(?:make|cmake|pytest|python3?|node|deno|bun|go|cargo|java|javac|mvn|gradle|bash|sh)\b[\s\S]{0,120}\b(?:run|test|tests?|check|validate|verify|\S+\.(?:c|py|js|ts|sh|go|rs|java))\b/i.test(normalized)
    || /(?:^|[;&|]\s*)\.\/\S+/.test(normalized)
    || /(?:^|[;&|]\s*)\/(?:app|tmp|workspace)\/\S+/.test(normalized);
}

function claimedPassedValidationCommands(validation: unknown): string[] {
  if (!Array.isArray(validation)) {
    return [];
  }
  return validation
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .filter((entry) => entry.status === 'passed' && typeof entry.command === 'string' && entry.command.trim().length > 0)
    .map((entry) => String(entry.command).trim());
}

interface CommandEvidence {
  command: string;
  cwd: string;
  output: string;
  commandId?: string;
}

function successfulExecCommands(turns: AgentTurn[]): string[] {
  return turns
    .map(successfulCommandEvidenceFromTurn)
    .filter((evidence): evidence is CommandEvidence => Boolean(evidence))
    .map((evidence) => evidence.command);
}

function hasSuccessfulValidationCommand(turns: AgentTurn[]): boolean {
  return turns
    .map(successfulCommandEvidenceFromTurn)
    .some((evidence) => Boolean(evidence && looksLikeValidationCommand(evidence.command)));
}

function successfulCommandEvidenceFromTurn(turn: AgentTurn): CommandEvidence | undefined {
  if (turn.kind !== 'tool' || turn.toolResult?.ok !== true) {
    return undefined;
  }
  const runningCommand = turn.toolResult.meta?.runningCommand;
  if (turn.toolCall?.tool === 'wait_command') {
    if (!runningCommand || !runningCommandExitedSuccessfully(runningCommand)) {
      return undefined;
    }
    return commandEvidenceFromRunningMeta(runningCommand, turn.toolResult.output);
  }
  if (turn.toolCall?.tool !== 'exec_command') {
    return undefined;
  }
  if (runningCommand) {
    if (!runningCommandExitedSuccessfully(runningCommand)) {
      return undefined;
    }
    return commandEvidenceFromRunningMeta(runningCommand, turn.toolResult.output);
  }
  const command = typeof turn.toolCall.args.command === 'string' ? turn.toolCall.args.command.trim() : '';
  if (!command) {
    return undefined;
  }
  return {
    command,
    cwd: normalizeExecCwd(turn.toolCall.args.cwd),
    output: turn.toolResult.output
  };
}

function pendingRunningValidationCommand(turns: AgentTurn[]): CommandEvidence | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const pending = runningCommandEvidenceFromTurn(turns[index]);
    if (!pending || !looksLikeValidationCommand(pending.command)) {
      continue;
    }
    const laterTurns = turns.slice(index + 1);
    const laterCompletion = laterTurns.some((turn) => {
      const runningCommand = turn.toolResult?.meta?.runningCommand;
      return runningCommand?.status === 'exited' && commandsMatch(pending.command, runningCommand.command);
    });
    if (!laterCompletion) {
      return pending;
    }
  }
  return undefined;
}

function runningCommandEvidenceFromTurn(turn: AgentTurn): CommandEvidence | undefined {
  if (turn.kind !== 'tool' || turn.toolResult?.ok !== true) {
    return undefined;
  }
  if (turn.toolCall?.tool !== 'exec_command' && turn.toolCall?.tool !== 'wait_command') {
    return undefined;
  }
  const runningCommand = turn.toolResult.meta?.runningCommand;
  if (!runningCommand || runningCommand.status !== 'running') {
    return undefined;
  }
  return commandEvidenceFromRunningMeta(runningCommand, turn.toolResult.output);
}

function runningCommandExitedSuccessfully(runningCommand: RunningCommandMeta): boolean {
  return runningCommand.status === 'exited'
    && runningCommand.exitCode === 0;
}

function commandEvidenceFromRunningMeta(runningCommand: RunningCommandMeta, output: string): CommandEvidence | undefined {
  const command = runningCommand.command.trim();
  if (!command) {
    return undefined;
  }
  return {
    command,
    cwd: normalizeExecCwd(runningCommand.cwd),
    output,
    commandId: runningCommand.id
  };
}

type NpmValidationTask = 'test' | 'build';

function requestedNpmValidationTasks(prompt: string): NpmValidationTask[] {
  const tasks: NpmValidationTask[] = [];
  if (/\bnpm\s+(?:--prefix\s+\S+\s+)?(?:run\s+)?test\b/i.test(prompt)) {
    tasks.push('test');
  }
  if (/\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+build\b/i.test(prompt)) {
    tasks.push('build');
  }
  return tasks;
}

function commandSatisfiesNpmTask(command: string, task: NpmValidationTask): boolean {
  const normalized = normalizeCommandForEvidence(command);
  if (task === 'test') {
    return /\bnpm\s+(?:--prefix\s+\S+\s+)?(?:(?:run\s+)?test)\b/.test(normalized);
  }
  return /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+build\b/.test(normalized);
}

function renderNpmTask(task: NpmValidationTask): string {
  return task === 'test' ? 'npm test' : 'npm run build';
}

function claimsValidationPassed(answer: string): boolean {
  return /\b(?:all\s+)?(?:tests?|build|checks?|validation)\b.{0,80}\b(?:passed|pass|succeeded|successful|works?|green)\b/i.test(answer)
    || /\b(?:passed|pass|succeeded|successful|works?|green)\b.{0,80}\b(?:all\s+)?(?:tests?|build|checks?|validation)\b/i.test(answer);
}

function commandsMatch(claimed: string, actual: string): boolean {
  const normalizedClaim = normalizeCommandForEvidence(claimed);
  const normalizedActual = normalizeCommandForEvidence(actual);
  if (
    normalizedActual === normalizedClaim
    || normalizedActual.endsWith(`&& ${normalizedClaim}`)
    || normalizedActual.endsWith(`; ${normalizedClaim}`)
  ) {
    return true;
  }

  const actualParts = splitCommandForEvidence(normalizedActual);
  const claimedParts = splitCommandForEvidence(normalizedClaim);
  return claimedParts.length > 0
    && claimedParts.every((claimedPart) => actualParts.some((actualPart) => commandPartMatches(claimedPart, actualPart)));
}

function normalizeCommandForEvidence(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/\s+\d?>&\d+\b/g, '')
    .replace(/\s+\([^)]*(?:static|browser|smoke|validation|tests?|checks?|syntax)[^)]*\)\s*$/i, '')
    .trim();
}

function splitCommandForEvidence(command: string): string[] {
  return normalizeCommandForEvidence(command)
    .split(/\s*(?:&&|;)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function commandPartMatches(claimed: string, actual: string): boolean {
  if (claimed === actual || actual.endsWith(` ${claimed}`)) {
    return true;
  }
  const claimedTokens = claimed.split(/\s+/u);
  const actualTokens = actual.split(/\s+/u);
  if (claimedTokens.length !== actualTokens.length || claimedTokens.length === 0) {
    return false;
  }
  return claimedTokens.every((token, index) => evidenceTokenMatches(token, actualTokens[index]!));
}

function evidenceTokenMatches(claimed: string, actual: string): boolean {
  if (claimed === actual) {
    return true;
  }
  const claimedHasPath = claimed.includes('/') || claimed.includes('\\');
  const actualHasPath = actual.includes('/') || actual.includes('\\');
  if (!claimedHasPath && !actualHasPath) {
    return false;
  }
  return basenameForEvidence(actual) === basenameForEvidence(claimed);
}

function basenameForEvidence(value: string): string {
  const cleaned = value.replace(/\\/g, '/').replace(/^['"]|['"]$/g, '');
  return cleaned.slice(cleaned.lastIndexOf('/') + 1);
}

function validationWasRequested(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(?:verify|validate|validation|tests?|check|checks|smoke|lint|typecheck)\b/.test(text)) {
    return true;
  }
  if (/\b(?:npm|pnpm|yarn|bun)\b.{0,40}\b(?:test|build|check|lint|typecheck)\b/.test(text)) {
    return true;
  }
  if (/\b(?:run|rerun|re-run|execute)\b.{0,40}\b(?:npm|pnpm|yarn|bun|tests?|build|checks?|lint|typecheck|validation|pytest|go test|cargo test)\b/.test(text)) {
    return true;
  }
  if (/\b(?:make sure|ensure|confirm)\b.{0,40}\b(?:it|the (?:app|project|site|game|server))\b.{0,20}\b(?:runs?|starts?|works?)\b/.test(text)) {
    return true;
  }
  return false;
}

function mentionsValidationNotRun(answer: string): boolean {
  return /\b(not|wasn'?t|were?n'?t|did not|didn'?t)\b.{0,80}\b(run|rerun|re-run|verify|validate|validation|test|tests|build|check)\b/i.test(answer)
    || /\b(run|rerun|re-run|verify|validate|validation|test|tests|build|check)\b.{0,80}\b(not|wasn'?t|were?n'?t|did not|didn'?t)\b/i.test(answer);
}

const FINAL_RESPONSE_PASS_INSTRUCTION = [
  'The previous step used a tool and this is the final no-tools response pass.',
  'Do not call any more tools.',
  'Respond with exactly one valid JSON object and no Markdown fences.',
  'Use {"answer":"short user-facing result"}.',
  'Using only the visible user request, conversation context, and tool results, tell the user what changed, whether it was actually verified, and any concrete blocker.',
  'If files were created but no runnable command was verified, say that plainly.',
  'For npm or web apps, include the project directory and exact npm command only when the scripts are known from the tool results.'
].join('\n');

const FINAL_RESPONSE_MAX_TOKENS = 1024;

function finalResponseMaxTokens(maxTokens: number | undefined): number {
  return maxTokens === undefined ? FINAL_RESPONSE_MAX_TOKENS : Math.min(maxTokens, FINAL_RESPONSE_MAX_TOKENS);
}

const EMPTY_MODEL_RESPONSE_RETRY_INSTRUCTION = [
  'The previous model call ended with thinking only and no JSON content. This is a Gemma CLI protocol failure.',
  'Do not continue reasoning silently. Emit exactly one JSON object now.',
  'If work is needed, call one tool with {"tool":"tool_name","args":{...}}.',
  'If no more work is needed, answer with {"answer":"..."} using only confirmed session evidence.'
].join('\n');

const OUTPUT_LIMIT_RETRY_INSTRUCTION = [
  'The previous model call hit the output token limit before Gemma CLI received a complete JSON response.',
  'Thinking is disabled for this retry.',
  'Do not continue or repeat the truncated draft.',
  'Choose the next concrete action immediately and emit exactly one JSON object.',
  'If work is needed, call one tool with {"tool":"tool_name","args":{...}}.',
  'If the task cannot be completed, answer with {"answer":"blocked: ..."} and state the concrete blocker.'
].join('\n');

const TRANSIENT_MODEL_TRANSPORT_RETRY_INSTRUCTION = [
  'The previous local model request failed because the provider transport disconnected before a complete JSON response was received.',
  'Thinking is disabled for this retry.',
  'Continue the same task from the current tool history; do not assume unfinished draft text was applied unless a tool result says it was.',
  'Return exactly one JSON object: either {"answer":"..."} or {"tool":"tool_name","args":{...}}.'
].join('\n');
const gemmaStringDelimiter = '<|"|>';

function isEmptyModelContentError(error: unknown): boolean {
  return error instanceof Error && /did not include text content|response was empty|empty response|no JSON content/i.test(error.message);
}

function isOutputLimitModelError(error: unknown): boolean {
  return error instanceof Error && /output token limit|done_reason=(?:length|max[_ -]?tokens?)/i.test(error.message);
}

function isTransientModelTransportError(error: unknown): boolean {
  return error instanceof Error && /fetch failed|network error|socket hang up|ECONNRESET|ECONNREFUSED|terminated|AbortError|operation was aborted|stream was aborted/i.test(error.message);
}

function parseActionOrRecoveryInstruction(text: string): ({ answer: string } | ToolCall) | { retryInstruction: string } {
  try {
    return parseAction(text);
  } catch (error) {
    return {
      retryInstruction: [
        'Your previous response could not be parsed by Gemma CLI.',
        error instanceof Error ? `Parser error: ${error.message}` : `Parser error: ${String(error)}`,
        'Do not repeat the malformed response.',
        'Return exactly one valid JSON object with no Markdown fences.',
        'To answer, use {"answer":"short result"}.',
        'To use a tool, use {"tool":"tool_name","args":{...}}.',
        'JSON strings must escape literal newlines as \\n and escape quotes and backslashes.'
      ].join('\n')
    };
  }
}

class ProtocolRetryError extends Error {
  constructor(readonly retryInstruction: string) {
    super('Model response drifted outside the JSON protocol.');
  }
}

class CompleteToolCallStreamError extends Error {
  constructor(readonly raw: string) {
    super('Model streamed a complete tool call followed by raw transport markers.');
  }
}

class ModelProtocolMonitor {
  private content = '';
  private repeatedFragmentKey = '';
  private repeatedFragmentCount = 0;

  observe(chunk: StreamChunk): void {
    if (!chunk.content) {
      return;
    }
    this.content += chunk.content;
    const completeToolCall = completeToolCallWithNoisyTransportSuffix(this.content);
    if (completeToolCall) {
      throw new CompleteToolCallStreamError(completeToolCall);
    }
    const streamRepetitionReason = this.repeatedStreamFragmentReason(chunk.content);
    if (streamRepetitionReason) {
      throw new ProtocolRetryError(buildProtocolDriftRetryInstruction(streamRepetitionReason));
    }
    const reason = visibleProtocolDriftReason(this.content);
    if (!reason) {
      const repetitionReason = visibleRepetitionDriftReason(this.content);
      if (!repetitionReason) {
        return;
      }
      throw new ProtocolRetryError(buildProtocolDriftRetryInstruction(repetitionReason));
    }
    throw new ProtocolRetryError(buildProtocolDriftRetryInstruction(reason));
  }

  private repeatedStreamFragmentReason(fragment: string): string | undefined {
    const key = repeatedStreamFragmentKey(fragment);
    if (!key) {
      this.repeatedFragmentKey = '';
      this.repeatedFragmentCount = 0;
      return undefined;
    }
    if (key === this.repeatedFragmentKey) {
      this.repeatedFragmentCount += 1;
    } else {
      this.repeatedFragmentKey = key;
      this.repeatedFragmentCount = 1;
    }
    if (this.repeatedFragmentCount < 12) {
      return undefined;
    }
    return `Model stream fragment repeated ${this.repeatedFragmentCount} times before a JSON action completed: ${streamFragmentPreview(fragment)}.`;
  }
}

function buildProtocolDriftRetryInstruction(reason: string): string {
  return [
    'Your previous response drifted outside the Gemma CLI JSON protocol before it completed.',
    `Reason: ${reason}`,
    'Do not continue that draft and do not include scratch text, Markdown fences, or multiple attempted tool calls.',
    'Return exactly one valid JSON object and nothing else.',
    'To use a tool, use {"tool":"tool_name","args":{...}}.',
    'If you need to correct a tool call, send only the corrected single JSON object now.'
  ].join('\n');
}

function repeatedStreamFragmentKey(fragment: string): string | undefined {
  const normalized = fragment.replace(/\r\n/g, '\n');
  if (normalized.length < 8) {
    return undefined;
  }
  return normalized;
}

function streamFragmentPreview(fragment: string): string {
  const preview = fragment.length > 120 ? `${fragment.slice(0, 120)}...` : fragment;
  return JSON.stringify(preview);
}

export function buildAgentSystemPrompt(options: AgentSystemPromptOptions = {}): string {
  const tools = options.tools ?? [];
  const toolDescriptions = renderToolContext(tools);
  const toolNames = tools.map((tool) => tool.name);
  const actModeInstructions = renderActModeInstructions(options.workspace, tools);
  const thinkingInstructions = buildGemmaThinkingInstructions(options.model, options.reasoningMode);
  const profile = modelProfileFor(options.model);
  const yolo = options.yolo ?? false;

  return [
    '<role>',
    'You are Gemma CLI, a local-model coding tool for terminal-based software engineering tasks and automation.',
    'Optimized for Gemma models, but works with any local model exposed by Ollama or LM Studio.',
    'Keep final answers short, factual, and outcome-first.',
    toolNames.length > 0 ? `Tools you can call this turn: ${toolNames.join(', ')}.` : '',
    '</role>',
    '',
    thinkingInstructions,
    renderResponseContract(profile),
    '',
    renderEnvironmentBlock(options),
    '<execution_strategy>',
    options.workspace ? `Workspace: ${options.workspace}` : '',
    'Be truthful about actions and results from this session only.',
    'Use tools for facts that depend on files or commands. Do not guess.',
    'Preserve exact user-provided paths, filenames, identifiers, and quoted strings unless asked to change them.',
    'Treat exact user-provided paths as authoritative. Do not normalize, rename, or silently fix them.',
    'Use tools when you need workspace facts or must create an artifact.',
    'First inspect what you already have and answer from grounded facts when possible.',
    'Use exec_command for npm commands, build commands, installs, app scaffolding commands, validation, chmod, and running project tools; do not use shell heredocs, echo, printf, or python -c for hand-written multiline file contents when write_file is available.',
    'After a tool result, base your answer only on the tool output. Do not invent file names, scripts, dependencies, or command results.',
    'After a tool result, do not restate the full task or repeat earlier analysis. Extract the new facts, decide the next concrete action, then emit either one tool call or the final answer.',
    'If a tool result says ok:false, fix the tool call or explain the failure; do not pretend the tool succeeded.',
    'For exec_command, ok:true means the process exited with status 0. Trust that exit status even when stdout is quiet or does not contain words like "passed".',
    '</execution_strategy>',
    '',
    renderSearchStrategy(toolNames),
    renderRuntimeQueryExample(toolNames),
    '<workspace_build_rules>',
    actModeInstructions,
    '</workspace_build_rules>',
    '',
    renderToolUseDiscipline(yolo),
    '',
    '<attachment_rules>',
    'The CLI validates local media before the model call and only includes attachments the selected provider/model can accept.',
    'When supported images, audio, PDFs, or sampled video frames are present in the user message, inspect them directly from the message context.',
    'If the user only asks about attached media, answer directly from the attachment. Do not discuss file paths, tool availability, or whether you can read the file.',
    'Do not claim you inspected an unsupported, missing, or unsampled file. If the CLI reports a capability or sampling blocker, state that blocker plainly.',
    '</attachment_rules>',
    (options.systemContext ?? []).length > 0 ? `Additional skills and instructions:\n${(options.systemContext ?? []).join('\n\n')}` : '',
    renderGemmaNativeToolDeclarations(tools, options.model),
    '<available_tools>',
    toolDescriptions || '- none',
    '</available_tools>'
  ].filter(Boolean).join('\n');
}

function renderResponseContract(profile: ReturnType<typeof modelProfileFor>): string {
  const lines = [
    '<response_contract>',
    'Respond with exactly one complete action and no Markdown fences.',
    'Preferred portable format for a final answer: {"answer":"your final answer"}.',
    'Preferred portable format for one tool call: {"tool":"tool_name","args":{"name":"value"}}. Never put a tool call inside an answer string.',
    'JSON strings must be valid JSON: escape literal newlines as \\n and escape backslashes and quotes. Prefer concise one-line final answers.'
  ];
  if (profile.family === 'gemma4') {
    lines.push(
      'Gemma 4 native tool-call transport is also accepted when the runtime emits it: <|tool_call>call:tool_name{key:<|"|>value<|"|>}<tool_call|><|tool_response>.',
      'Use only one response format per turn. Do not emit visible scratch text before or after a JSON action or native tool call.'
    );
  } else {
    lines.push('Never emit raw transport syntax such as <|channel>, <channel|>, <|tool_call|>, <tool_call|>, <|tool_response|>, or jsonset.');
  }
  lines.push('</response_contract>');
  return lines.join('\n');
}

function renderToolUseDiscipline(yolo: boolean): string {
  return [
    '<tool_use_discipline>',
    'Available tools are direct tools: each tool call performs one concrete action immediately.',
    'Use the tool parameters exactly as documented. Prefer canonical parameter names over aliases.',
    'Call one tool per assistant turn.',
    'Gemma CLI shows tool progress automatically. In this JSON protocol, do not add status prose before a tool call; emit the JSON tool object immediately.',
    'If a tool fails, avoid retry loops. Try a different safe approach when useful.',
    'If a tool result is thin, partial, empty, malformed, or only a scaffold, treat it as insufficient evidence rather than completion.',
    'After one refined retry, stop looping and explain what is confirmed, what is not confirmed, and what blocked further work.',
    yolo
      ? 'Yolo mode is active: workspace tools run without user permission prompts. Still avoid destructive operations outside the workspace and stop on repeated failures.'
      : 'When a tool would modify or read paths outside the workspace, the host may prompt the user for permission. Treat denials as terminal: do not retry the same path.',
    '</tool_use_discipline>'
  ].join('\n');
}

function renderSearchStrategy(toolNames: string[]): string {
  const has = (name: string) => toolNames.includes(name);
  if (!has('search_paths') && !has('search_text') && !has('list_tree') && !has('read_file') && !has('inspect_file')) {
    return '';
  }
  const lines = ['<search_strategy>'];
  lines.push('Pick the cheapest tool that answers the question. Avoid reading whole files when a search would do.');
  if (has('search_paths') || has('list_tree')) {
    lines.push('To find files by name or pattern: use search_paths (glob) or list_tree. Do not grep through every file.');
  }
  if (has('search_text')) {
    lines.push('To find code by content (symbols, strings, error messages): use search_text with a tight regex and a small max_results cap. Add a path filter to scope the search.');
  }
  if (has('read_file') || has('inspect_file')) {
    lines.push('To open a file: read_file with line ranges when you know roughly where to look. Reserve full reads for small files or when ranges are unknown.');
  }
  lines.push('Prefer parallel-style steps: when several independent lookups would help, plan them in successive turns instead of reading sequentially through one big file.');
  lines.push('Cap result counts. If a search returns hundreds of matches, narrow the regex or path filter rather than scrolling.');
  lines.push('</search_strategy>');
  return lines.join('\n');
}

function renderRuntimeQueryExample(toolNames: string[]): string {
  if (!toolNames.includes('exec_command')) return '';
  return [
    '<runtime_query_example>',
    'When the user asks for runtime facts the workspace can answer (current time, disk space, git status, environment variables, process list), call exec_command yourself instead of printing a shell snippet as advisory text.',
    'Wrong: replying with a code block like ```bash\\ndate\\n``` and asking the user to run it.',
    'Right: emit {"tool":"exec_command","args":{"command":"date"}} and then answer using the tool result.',
    '</runtime_query_example>'
  ].join('\n');
}

export function renderEnvironmentBlock(options: AgentSystemPromptOptions): string {
  const env = options.environment;
  if (!env && !options.workspace) return '';
  const lines: string[] = ['<environment>'];
  if (options.workspace) lines.push(`workspace: ${options.workspace}`);
  if (env?.platform) lines.push(`platform: ${env.platform}${env.arch ? ` (${env.arch})` : ''}${env.osRelease ? ` ${env.osRelease}` : ''}`);
  if (env?.shell) lines.push(`shell: ${env.shell}`);
  if (env?.nodeVersion) lines.push(`node: ${env.nodeVersion}`);
  if (env?.time) {
    lines.push(`time: ${env.time}${env.timezone ? ` (${env.timezone})` : ''}`);
  } else if (env?.date) {
    lines.push(`date: ${env.date}`);
  }
  if (env?.git) {
    const git = env.git;
    const dirty = git.dirty === undefined ? '' : git.dirty ? ' (dirty)' : ' (clean)';
    if (git.branch) lines.push(`git: ${git.branch}${dirty}${git.repoRoot ? `  root=${git.repoRoot}` : ''}`);
    if (git.lastCommit) lines.push(`last commit: ${git.lastCommit}`);
  }
  lines.push(shellGuidance(env));
  lines.push('</environment>');
  return lines.join('\n');
}

function shellGuidance(env: AgentEnvironment | undefined): string {
  const platform = env?.platform?.toLowerCase();
  if (platform === 'win32') {
    return 'Use PowerShell-compatible commands. Avoid POSIX-only syntax (no `&&` chaining unless cmd.exe; prefer `;` in PowerShell). Use forward or backslashes per platform conventions.';
  }
  if (platform === 'darwin') {
    return 'Use POSIX shell commands (zsh/bash on macOS). Prefer BSD variants when relevant (e.g., `sed -i ""`, `date` without GNU `-d` flag).';
  }
  if (platform === 'linux') {
    return 'Use POSIX shell commands (bash/sh on Linux). Prefer GNU variants when relevant (e.g., `sed -i`, `date -d`).';
  }
  return 'Use POSIX shell commands appropriate for the host platform.';
}

function renderActModeInstructions(workspace: string | undefined, tools: Tool[]): string {
  const toolSet = new Set(tools.map((tool) => tool.name));
  const canReadFiles =
    toolSet.has('inspect_file')
    || toolSet.has('read_file')
    || toolSet.has('read_files')
    || toolSet.has('list_tree')
    || toolSet.has('search_paths')
    || toolSet.has('search_text');
  const canEditFiles = toolSet.has('write_file') || toolSet.has('apply_patch');
  const canRunCommands = toolSet.has('exec_command');
  const hasExecCommand = toolSet.has('exec_command');
  const hasWriteFile = toolSet.has('write_file');

  return [
    'Act mode is active.',
    workspace ? `Workspace: ${workspace}` : undefined,
    renderPromptBullets('Execution & File Mutation Rules', [
      'Act like a builder and complete the task end-to-end when feasible.',
      'If the conversation already contains an approved plan or planning handoff, treat it as the current execution spec and start implementing instead of re-planning unless a missing requirement blocks work.',
      'Use the tools available in this turn to inspect, edit, run commands, and verify work when those capabilities are present.',
      canEditFiles || canRunCommands
        ? 'Before creating, initializing, or scaffolding a project in a user-named directory, perform one read-only orientation step: inspect the parent directory when the target is probably new, or inspect the target path when it may already exist. Do not start broad writes, dependency installation, or scaffolding until you know whether the target is missing, empty, or already contains project files.'
        : undefined,
      canEditFiles
        ? 'If the user asks you to create a named file or path, create it on disk instead of only drafting it in the reply unless they explicitly asked for inline content.'
        : 'This turn does not include file-writing tools. If the user asks you to create a named file or path, say plainly that you cannot create it in the workspace from this turn.',
      canEditFiles || canRunCommands
        ? `Printing file contents, markdown code fences, shell snippets, or commands such as cat > file is not file creation. To create files, call ${[
          toolSet.has('write_file') ? 'write_file' : undefined,
          toolSet.has('apply_patch') ? 'apply_patch' : undefined,
          hasExecCommand ? 'exec_command' : undefined
        ].filter(Boolean).join(', ')}.`
        : undefined,
      canEditFiles
        ? 'When the user asks to work in the current working directory or workspace root, put the project files there. Do not create an extra wrapper directory unless the user asks for one or the existing workspace structure clearly requires it.'
        : undefined,
      canReadFiles && canEditFiles
        ? 'Read before editing existing files. Use complete writes for new files or complete rewrites.'
        : canEditFiles
          ? 'Read before editing existing files when a read tool is available. Use complete writes for new files or complete rewrites.'
          : undefined,
      hasWriteFile
        ? 'write_file creates missing parent directories automatically, so provide only the path and complete content unless the schema explicitly requires more.'
        : undefined,
      hasWriteFile
        ? 'For small multi-file apps where the file contents are already known, write each complete file with a separate write_file call before long explanation or design narration.'
        : undefined,
      hasWriteFile
        ? 'Use write_file when creating or replacing a file with complete known content.'
        : undefined,
      hasWriteFile && hasExecCommand
        ? 'For multiline source, config, hook, script, HTML, CSS, JSON, or YAML content, prefer write_file over echo, printf, cat heredocs, or python -c file creation. Use exec_command afterward for chmod, execution, installs, and validation.'
        : undefined,
      toolSet.has('apply_patch')
        ? 'Use apply_patch for existing-file diffs only when you have exact current surrounding context from a recent read. If a patch context fails once, immediately reread the target region and then use a smaller patch or a complete write_file replacement; do not retry stale context.'
        : undefined,
      toolSet.has('apply_patch')
        ? 'For apply_patch, the patch argument is one JSON string containing unified diff text. Use JSON \\n escapes between diff lines so the tool receives real newline-separated lines; do not double-escape hunk lines as literal \\n text.'
        : undefined,
      hasWriteFile
        ? 'For write_file, output final file contents only. Do not include scratch notes, planning bullets, self-corrections, placeholder keys, dummy values, or lines like "Wait, let\'s fix...", "Need to make sure...", or "Now I\'ll..." inside file content.'
        : undefined,
      hasWriteFile
        ? 'If you notice a bug while composing a file, correct it before you send the tool call. If a draft is still wrong after a write, inspect or edit it in a later step instead of narrating the correction inside the file content.'
        : undefined
    ]),
    renderPromptBullets('Validation & Dependencies', [
      canRunCommands
        ? 'Use command tools for execution and verification when they materially help.'
        : 'This turn does not include command tools. If command execution is needed, say so plainly instead of implying it ran.',
      hasExecCommand
        ? 'When you create or change files, prefer the strongest validation the workspace already provides. Use project-level build, check, typecheck, lint, or test commands when they cover the change instead of doing file-by-file manual review in text.'
        : 'When you create or change files, use the strongest validation available in this turn and say plainly when you cannot run the workspace checks yourself.',
      hasExecCommand
        ? 'For long-running installs, builds, training jobs, solvers, service startup checks, or tests that may be quiet for minutes, set exec_command timeoutMs to a realistic no-output budget up to 600000 or make the command print periodic progress. If exec_command reports that a command is still running with a commandId, do not start the same command again; call wait_command for progress or completion, validate with a separate finite command when appropriate, answer if the running service is the requested result, or call cancel_command if it should stop.'
        : undefined,
      hasExecCommand
        ? 'For background services, use a shell pattern like `nohup <command> > /tmp/<service>.log 2>&1 &`, record the PID, sleep briefly, verify it with `kill -0 <PID>` or `/proc/<PID>`, and inspect the log before assuming the service is healthy.'
        : undefined,
      hasExecCommand
        ? 'If pgrep, ps, or pidof are missing, check process state with `/proc/<PID>`, `kill -0 <PID>`, or `/proc/<PID>/cmdline` before installing extra packages.'
        : undefined,
      hasExecCommand
        ? 'In Linux containers, common missing-command packages include pgrep/ps/pidof -> procps, ss/ip -> iproute2, netstat/ifconfig -> net-tools, curl -> curl, jq -> jq, dig/nslookup -> dnsutils or bind-utils, lsof -> lsof, wget -> wget, tree -> tree, and zip/unzip -> zip/unzip.'
        : undefined,
      hasExecCommand
        ? 'When a command or validation approach fails, inspect the error and change strategy. Do not repeat the exact same failing command or approach more than twice.'
        : undefined,
      hasExecCommand
        ? 'For Node or package-managed web app work, use the package manager and scripts already present. Create package.json scripts only when the user asks for a package-managed app, existing package metadata should be extended, or reusable commands materially improve development or verification. If you do create package metadata, do not leave the npm init default test script in place.'
        : undefined,
      hasExecCommand
        ? 'For package-managed runnable web apps, package metadata should include a working start or dev script. For static web apps without package metadata, a direct browser, file, syntax, or runtime smoke check can be enough.'
        : undefined,
      hasExecCommand
        ? 'If you create or change a CLI, run at least one direct CLI command with exec_command before calling it functional. Library tests alone do not prove the CLI entry point starts.'
        : undefined,
      hasExecCommand
        ? 'Do not use a build script that only echoes or prints success as proof of a project build. If you add a build or check script, make it syntax-check or otherwise execute the actual entry files.'
        : undefined,
      'Do not add project dependencies unless the implementation actually imports or runs them. For simple static apps, prefer dependency-free files and ordinary one-off checks when enough.',
      'For project initialization or scaffolding, prefer non-interactive commands and flags. If a setup command is cancelled, hangs, or waits for input, do not repeat it unchanged.',
      'Do not treat dependency installation, a partial scaffold, or one file write as a finished setup. Before you stop, make sure declared scripts, referenced entry files, and basic verification actually work.',
      'For generated artifacts such as SVG, HTML, JSON, XML, or config files, validate the artifact with a real parser, renderer, existing project script, or focused one-off command instead of relying on visual inspection of the text.',
      'Do not create a new validator or test script just to prove a simple static artifact exists. Create one only when the user asks for it, the project already has a test harness it should join, or the behavior is complex enough that reusable validation is worth maintaining.',
      'When you do create a validator or test script, make it assert every important requested behavior and constraint, not just file existence or a few generic forbidden strings.',
      'When a package script runs from the project directory, make validator paths relative to that script working directory or import.meta.url; do not prefix the project folder again inside the validator.',
      'When checking for remote assets, inspect URL-bearing attributes, imports, and CSS url() references, and allow inline SVG namespace URLs such as http://www.w3.org/2000/svg.',
      'After you change files, do not stop until you have run a meaningful verification command or explained the concrete blocker.',
      'A failing or timed-out verification command means the task is not complete yet.',
      'If a command is reported as interactive, stuck, timed out, cancelled, or ok:false, treat it as failed even when partial output contains success-looking text such as "All tests passed". Fix the hang or run a validation command that exits cleanly before claiming validation passed.'
    ]),
    renderPromptBullets('Generated Web App Quality', [
      'Prefer self-contained local assets, CSS, canvas, gradients, inline SVG, or placeholders for generated offline web projects. Do not hotlink remote images or scripts unless the user asks for external assets.',
      'Do not use alert(), confirm(), or prompt() as the main interaction feedback. Show state, errors, scores, confirmations, and progress in the DOM.',
      'For interactive web projects, include accessible controls, visible state changes, responsive layout rules, and some meaningful verification. Prefer existing scripts, browser/dev-server checks, syntax checks, or focused one-off commands before adding new validator files.',
      'For browser JavaScript, validation must execute or syntax-check the changed script. A validator that only checks file existence or that an HTML tag exists is not enough after JavaScript edits.',
      'Never write self-correction notes, scratch reasoning, or phrases like "Correction:", "Wait, let\'s fix", or "Error in my thought" into generated files. Fix the file content before calling a write tool.',
      'For responsive web projects, include explicit responsive CSS evidence such as @media, minmax(), clamp(), container queries, or auto-fit grid tracks. If you create a validator for a responsive project, make it check that evidence.'
    ]),
    renderPromptBullets('Communication Workflow', [
      canEditFiles || canRunCommands
        ? 'When file creation or workspace mutation is the task, make the next assistant action the required JSON tool call instead of a plan or status sentence. Do not claim completion before tool results.'
        : undefined,
      canEditFiles || canRunCommands
        ? 'Summarize only after files exist and verification has run or after you have a concrete blocker.'
        : undefined,
      'After tool work, always send a useful user-facing completion message. Mention the project path, the exact command to run when known, what validation actually passed, and any remaining blocker.',
      'If package scripts, syntax checks, runtime checks, or browser checks were not run, say they were not run. Do not imply the app is runnable just because file writes succeeded.',
      'Do not stop at promises or next steps when the task is actionable and tools are available.',
      'Before destructive commands or unrequested overwrites, ask for confirmation in the final answer and prefer safe alternatives.',
      'Always end tool work with a short user-facing completion message. Summarize the concrete result, mention verification status if relevant, and call out any remaining blocker plainly.',
      'Do not end with tool calls only, reasoning only, or an empty reply.'
    ])
  ].filter(Boolean).join('\n');
}

function renderPromptBullets(title: string, bullets: Array<string | undefined>): string | undefined {
  const filtered = bullets.filter((bullet): bullet is string => Boolean(bullet && bullet.trim().length > 0));
  if (filtered.length === 0) {
    return undefined;
  }

  return [
    `**${title}:**`,
    ...filtered.map((bullet) => `- ${bullet}`)
  ].join('\n');
}

function renderToolContext(tools: Tool[]): string {
  if (tools.length === 0) {
    return '';
  }
  const capabilities = summarizeCapabilities(tools);
  return [
    `Available tool names: ${tools.map((tool) => tool.name).join(', ')}.`,
    capabilities,
    ...tools.map(renderTool)
  ].filter(Boolean).join('\n');
}

function summarizeCapabilities(tools: Tool[]): string {
  const byCapability = new Map<string, string[]>();
  for (const tool of tools) {
    const capability = tool.capability ?? 'other';
    byCapability.set(capability, [...(byCapability.get(capability) ?? []), tool.name]);
  }
  return [...byCapability.entries()]
    .map(([capability, names]) => `Capability ${capability}: ${names.join(', ')}`)
    .join('\n');
}

function renderTool(tool: Tool): string {
  return [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    tool.capability ? `Capability: ${tool.capability}` : undefined,
    tool.requiredParameters?.length ? `Required parameters: ${tool.requiredParameters.join(', ')}` : undefined,
    tool.parameters ? `Parameters:\n${Object.entries(tool.parameters).map(([name, description]) => `- ${name}: ${description}`).join('\n')}` : undefined,
    tool.parameterAliases ? `Aliases:\n${Object.entries(tool.parameterAliases).map(([name, aliases]) => `- ${name}: ${aliases.join(', ')}`).join('\n')}` : undefined,
    tool.examples?.length ? `Examples:\n${tool.examples.map((example) => `- {"tool":"${tool.name}","args":${JSON.stringify(example)}}`).join('\n')}` : undefined
  ].filter(Boolean).join('\n');
}

async function runToolSafely(tool: Tool, action: ToolCall): Promise<ToolResult> {
  try {
    return await tool.run(action.args);
  } catch (error) {
    return {
      ok: false,
      output: `Tool ${action.tool} crashed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function unknownToolMessage(toolName: string): string {
  if (toolName === 'replace') {
    return [
      'Unknown tool: replace.',
      'Gemma CLI intentionally does not expose exact old_string/new_string replacement because Gemma models repeatedly corrupt or churn that payload shape.',
      'Use apply_patch with current surrounding context for existing-file diffs, or write_file for complete file creation/replacement.'
    ].join('\n');
  }
  return `Unknown tool: ${toolName}`;
}

function parseAction(text: string): { answer: string } | ToolCall {
  const normalized = normalizeGemmaModelOutput(text);
  if (!normalized && text.trim()) {
    throw new Error('Model response contained thinking only and no JSON content.');
  }
  const rawTrimmed = normalized || text.trim();
  const nativeToolCall = parseGemmaNativeToolCall(rawTrimmed);
  if (nativeToolCall) {
    return normalizeToolCall(nativeToolCall);
  }
  const trimmed = stripCodeFence(rawTrimmed);
  const recoverableLooseWriteFile = parseLooseWriteFileToolCall(trimmed);
  if (recoverableLooseWriteFile) {
    return recoverableLooseWriteFile;
  }
  const envelopeDrift = visibleProtocolDriftReason(rawTrimmed);
  if (envelopeDrift) {
    throw new Error(envelopeDrift);
  }
  const jsonSpan = firstJsonObjectSpan(trimmed);
  if (!jsonSpan) {
    const looseSingleStringArg = parseLooseSingleStringArgToolCall(trimmed);
    if (looseSingleStringArg) {
      return looseSingleStringArg;
    }
    if (looksLikeGemmaNativeToolCall(rawTrimmed)) {
      throw new Error('Model emitted malformed Gemma native tool-call transport.');
    }
    if (looksLikeToolCallJson(trimmed)) {
      throw new Error('Model emitted malformed tool-call JSON and it was not shown as assistant text.');
    }
    return { answer: text.trim() };
  }
  const jsonText = jsonSpan.text;

  const parsed = parseJsonWithRepair(jsonText);
  if (!parsed.ok) {
    const looseSingleStringArg = parseLooseSingleStringArgToolCall(trimmed);
    if (looseSingleStringArg) {
      return looseSingleStringArg;
    }
    if (looksLikeGemmaNativeToolCall(rawTrimmed)) {
      throw new Error('Model emitted malformed Gemma native tool-call transport.');
    }
    if (looksLikeToolCallJson(jsonText)) {
      throw new Error('Model emitted malformed tool-call JSON and it was not shown as assistant text.');
    }
    return { answer: text.trim() };
  }
  if (!parsed.value || typeof parsed.value !== 'object') {
    throw new Error('Model response JSON must be an object.');
  }

  if ('answer' in parsed.value) {
    const answer = (parsed.value as { answer: unknown }).answer;
    if (typeof answer !== 'string') {
      throw new Error('answer must be a string.');
    }
    const nestedToolCall = parseToolCallOnly(answer);
    if (nestedToolCall) {
      return nestedToolCall;
    }
    return { answer };
  }

  const candidate = toolCallFromObject(parsed.value);
  if (!candidate) {
    throw new Error('Model response must include either answer or tool plus args.');
  }

  return candidate;
}

function normalizeToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    tool: normalizeToolName(toolCall.tool)
  };
}

function normalizeToolName(name: string): string {
  const normalized = name.trim().replace(/^tool:/iu, '').replace(/[.:;：]+$/u, '');
  const aliases: Record<string, string> = {
    list_dir: 'list_tree',
    list_directory: 'list_tree'
  };
  return aliases[normalized] ?? normalized;
}

function toolCallFromObject(value: unknown): ToolCall | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as { tool?: unknown; args?: unknown };
  if (typeof candidate.tool !== 'string' || !candidate.args || typeof candidate.args !== 'object') {
    return undefined;
  }

  const args = { ...(candidate.args as Record<string, unknown>) };
  if (candidate.tool === 'write_file') {
    const drifted = value as { path?: unknown; content?: unknown };
    if (args.path === undefined && typeof drifted.path === 'string') {
      args.path = drifted.path;
    }
    if (args.content === undefined && typeof drifted.content === 'string') {
      args.content = drifted.content;
    }
  }

  return {
    tool: normalizeToolName(candidate.tool),
    args
  };
}

function stripCodeFence(text: string): string {
  if (!text.startsWith('```')) {
    return text;
  }
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseToolCallOnly(text: string): ToolCall | undefined {
  const trimmed = stripCodeFence(normalizeGemmaModelOutput(text)).trim();
  const nativeToolCall = parseGemmaNativeToolCall(trimmed);
  if (nativeToolCall) {
    return normalizeToolCall(nativeToolCall);
  }
  const jsonText = firstJsonObject(trimmed);
  if (!jsonText || jsonText.length !== trimmed.length) {
    return undefined;
  }

  const parsed = parseJsonWithRepair(jsonText);
  if (parsed.ok) {
    return toolCallFromObject(parsed.value);
  }
  return parseLooseSingleStringArgToolCall(trimmed);
}

function parseJsonWithRepair(text: string): { ok: true; value: unknown } | { ok: false } {
  for (const candidate of jsonRepairCandidates(text)) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // Try the next local repair candidate.
    }
  }
  return { ok: false };
}

function jsonRepairCandidates(text: string): string[] {
  const candidates = [
    text,
    repairInvalidJsonEscapes(text),
    repairJsonSmartQuotes(text),
    repairInvalidJsonEscapes(repairJsonSmartQuotes(text))
  ];
  return [...new Set(candidates)];
}

function repairJsonSmartQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function repairInvalidJsonEscapes(text: string): string {
  return text.replace(/\\([^"\\/bfnrtu])/g, '$1');
}

function parseLooseWriteFileToolCall(text: string): ToolCall | undefined {
  const cleaned = stripTrailingGemmaToolCallMarker(text.trim());
  if (!/"tool"\s*:\s*"write_file"/.test(cleaned) || !/"args"\s*:/.test(cleaned)) {
    return undefined;
  }

  const contentFirstPrefix = cleaned.match(/^\s*\{\s*"tool"\s*:\s*"write_file"\s*,\s*"args"\s*:\s*\{\s*"content"\s*:\s*"/);
  if (contentFirstPrefix) {
    const suffix = /"\s*\}?\s*(?:,\s*"overwriteExisting"\s*:\s*(true|false|"true"|"false"))?\s*,\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}\s*\}?\s*$/.exec(cleaned);
    if (suffix?.index !== undefined && suffix.index >= contentFirstPrefix[0].length) {
      return {
        tool: 'write_file',
        args: {
          content: decodeLooseJsonString(cleaned.slice(contentFirstPrefix[0].length, suffix.index)),
          ...(suffix[1] !== undefined ? { overwriteExisting: decodeLooseBoolean(suffix[1]) } : {}),
          path: decodeLooseJsonString(suffix[2])
        }
      };
    }
  }

  const pathFirstPrefix = cleaned.match(/^\s*\{\s*"tool"\s*:\s*"write_file"\s*,\s*"args"\s*:\s*\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"content"\s*:\s*"/);
  if (pathFirstPrefix) {
    const suffix = /"\s*(?:,\s*"overwriteExisting"\s*:\s*(true|false|"true"|"false"))?\s*\}\s*\}?\s*$/.exec(cleaned);
    if (suffix?.index !== undefined && suffix.index >= pathFirstPrefix[0].length) {
      return {
        tool: 'write_file',
        args: {
          path: decodeLooseJsonString(pathFirstPrefix[1]),
          content: decodeLooseJsonString(cleaned.slice(pathFirstPrefix[0].length, suffix.index)),
          ...(suffix[1] !== undefined ? { overwriteExisting: decodeLooseBoolean(suffix[1]) } : {})
        }
      };
    }
  }

  return undefined;
}

function decodeLooseBoolean(text: string): boolean {
  return text.replace(/^"|"$/g, '').trim().toLowerCase() === 'true';
}

function parseLooseSingleStringArgToolCall(text: string): ToolCall | undefined {
  const cleaned = stripTrailingGemmaToolCallMarker(text.trim());
  const looseQuoted = parseLooseQuotedSingleStringArgToolCall(cleaned);
  if (looseQuoted) {
    return looseQuoted;
  }

  if (!cleaned.includes(gemmaStringDelimiter)) {
    return undefined;
  }

  const prefix = cleaned.match(/^\s*\{\s*"tool"\s*:\s*"([A-Za-z0-9_.:-]+)"\s*,\s*"args"\s*:\s*\{\s*"([A-Za-z_][\w-]*)"\s*:\s*"/u)
    ?? cleaned.match(/^\s*\{\s*"tool"\s*:\s*"([A-Za-z0-9_.:-]+)"\s*,\s*"args"\s*:\s*\{\s*"?([A-Za-z_][\w-]*)\s*:\s*<\|"\|>/u);
  if (!prefix) {
    return undefined;
  }

  const tool = normalizeToolName(prefix[1]);
  if (tool === 'write_file' || tool === 'apply_patch') {
    return undefined;
  }

  const remainder = cleaned.slice(prefix[0].length);
  const delimiterIndex = remainder.indexOf(gemmaStringDelimiter);
  if (delimiterIndex === -1 && prefix[0].endsWith(gemmaStringDelimiter)) {
    const afterDelimiter = stripTrailingGemmaToolCallMarker(remainder);
    if (afterDelimiter.replace(/[}\]\s"]+/g, '') !== '') {
      return undefined;
    }

    return {
      tool,
      args: {
        [prefix[2]]: decodeLooseJsonString(remainder.replace(/[}\]\s"]+$/g, ''))
      }
    };
  }
  if (delimiterIndex === -1) {
    return undefined;
  }

  const afterDelimiter = stripTrailingGemmaToolCallMarker(remainder.slice(delimiterIndex + gemmaStringDelimiter.length));
  if (afterDelimiter.replace(/[}\]\s"]+/g, '') !== '') {
    return undefined;
  }

  return {
    tool,
    args: {
      [prefix[2]]: decodeLooseJsonString(remainder.slice(0, delimiterIndex))
    }
  };
}

function parseLooseQuotedSingleStringArgToolCall(cleaned: string): ToolCall | undefined {
  const prefix = cleaned.match(/^\s*\{\s*"tool"\s*:\s*"([A-Za-z0-9_.:-]+)"\s*,\s*"args"\s*:\s*\{\s*"([A-Za-z_][\w-]*)"\s*:\s*"/u);
  if (!prefix) {
    return undefined;
  }

  const tool = normalizeToolName(prefix[1]);
  if (tool === 'write_file' || tool === 'apply_patch') {
    return undefined;
  }

  const suffix = /"\s*\}\s*\}\s*$/u.exec(cleaned);
  if (!suffix || suffix.index === undefined || suffix.index < prefix[0].length) {
    return undefined;
  }

  const content = cleaned.slice(prefix[0].length, suffix.index);
  return {
    tool,
    args: {
      [prefix[2]]: decodeLooseJsonString(content)
    }
  };
}

function stripTrailingGemmaToolCallMarker(text: string): string {
  return text.replace(/(?:\s*<\|?tool_call\|?>\s*\}*|\s*<\|tool_response>\s*\}*)+\s*$/u, '');
}

function decodeLooseJsonString(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt]|.)/g, (match, escape: string) => {
    switch (escape) {
      case '"':
      case '\\':
      case '/':
        return escape;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        if (escape.startsWith('u')) {
          return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
        }
        return match.slice(1);
    }
  });
}

function looksLikeToolCallJson(text: string): boolean {
  const normalized = repairJsonSmartQuotes(text);
  return /["']tool["']\s*:\s*["'][^"']+["']/.test(normalized) && /["']args["']\s*:/.test(normalized);
}

function completeToolCallWithNoisyTransportSuffix(text: string): string | undefined {
  const toolJson = stripCodeFence(text);
  const jsonSpan = firstJsonObjectSpan(toolJson);
  if (!jsonSpan || !looksLikeToolCallJson(jsonSpan.text)) {
    return undefined;
  }
  const suffix = toolJson.slice(jsonSpan.end);
  const markerCount = (suffix.match(/<\|?tool_call\|?>/g) ?? []).length;
  if (markerCount < 2) {
    return undefined;
  }
  return stripTrailingGemmaToolCallMarker(suffix).trim() ? undefined : text;
}

function visibleProtocolDriftReason(text: string): string | undefined {
  const toolJson = stripCodeFence(text);
  const topJsonSpan = firstJsonObjectSpan(toolJson);
  if (topJsonSpan && looksLikeToolCallJson(topJsonSpan.text)) {
    const suffix = stripTrailingGemmaToolCallMarker(toolJson.slice(topJsonSpan.end)).trim();
    if (!suffix) {
      return undefined;
    }
    return 'Visible text appeared after a JSON tool action.';
  }

  const rawToolCallMarkers = (text.match(/<\|?tool_call\|?>/g) ?? []).length;
  if (rawToolCallMarkers >= 4) {
    return 'Raw tool-call transport markers repeated in visible output.';
  }

  const trimmed = text.trimStart();
  if (/^<thought\b/i.test(trimmed)) {
    return 'Visible <thought> scratch text was emitted before a JSON action.';
  }

  if (!trimmed.startsWith('```')) {
    return undefined;
  }
  const afterOpeningFence = trimmed.replace(/^```(?:json)?\s*/i, '');
  const jsonSpan = firstJsonObjectSpan(afterOpeningFence);
  if (!jsonSpan || !looksLikeToolCallJson(jsonSpan.text)) {
    return undefined;
  }
  const afterJson = afterOpeningFence.slice(jsonSpan.end).trimStart();
  if (!afterJson.startsWith('```')) {
    return undefined;
  }
  const afterClosingFence = afterJson.replace(/^```\s*/, '').trim();
  if (!afterClosingFence) {
    return undefined;
  }
  return 'Tool-call JSON was followed by extra visible text after the closing Markdown fence.';
}

function visibleRepetitionDriftReason(text: string): string | undefined {
  const responseContractMarkers = (text.match(/<\/?\s*response[_\s-]*contract\s*>/gi) ?? []).length;
  if (responseContractMarkers >= 3) {
    return `Visible response_contract marker repeated ${responseContractMarkers} times before a JSON action completed.`;
  }

  const normalized = text
    .replace(/\\n/g, ' ')
    .replace(/[^a-zA-Z0-9']+/g, ' ')
    .toLowerCase()
    .trim();
  if (!normalized) {
    return undefined;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  for (let phraseLength = 2; phraseLength <= 8; phraseLength += 1) {
    for (let offset = 0; offset < phraseLength; offset += 1) {
      let previous = '';
      let count = 0;
      for (let index = offset; index <= words.length - phraseLength; index += phraseLength) {
        const phrase = words.slice(index, index + phraseLength).join(' ');
        if (phrase === previous) {
          count += 1;
        } else {
          previous = phrase;
          count = 1;
        }
        if (count >= 8) {
          return `Visible generated phrase repeated ${count} times before a JSON action: ${JSON.stringify(phrase.slice(0, 120))}.`;
        }
      }
    }
  }

  return undefined;
}

function firstJsonObject(text: string): string | undefined {
  return firstJsonObjectSpan(text)?.text;
}

function firstJsonObjectSpan(text: string): { text: string; start: number; end: number } | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(start, i + 1), start, end: i + 1 };
      }
    }
  }

  return undefined;
}
