import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  Agent,
  assertContentSupported,
  buildAgentSystemPrompt,
  buildGemmaThinkingInstructions,
  buildPromptContentWithMedia,
  contentToText,
  createWorkspaceTools,
  detectSkillsForPrompt,
  getOllamaModelCapabilities,
  GeminiProvider,
  inferAttachmentCapabilities,
  listGeminiModelInfos,
  listLiteRtLmModelInfos,
  listLlamaCppModelInfos,
  listLmStudioModelInfos,
  LmStudioProvider,
  LiteRtLmProvider,
  LlamaCppProvider,
  loadSkills,
  mergeSkills,
  OllamaProvider,
  prepareOllama,
  skillsToSystemContext,
  type AgentEnvironment,
  type AgentRunResult,
  type AgentRunOptions,
  type ChatMessage,
  type ContentPart,
  type GenerateOptions,
  type ModelProvider,
  type StreamingModelProvider,
  type Skill,
  type Tool,
  type WorkspacePermissionHandler
} from '@gemma-sdk/agent';
import type { CliOptions } from './args.js';

export function detectAgentEnvironment(cwd?: string): AgentEnvironment {
  const shellEnv = process.env.SHELL ?? process.env.ComSpec ?? '';
  const shell = shellEnv ? path.basename(shellEnv) : undefined;
  const now = new Date();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: `${os.type()} ${os.release()}`,
    shell,
    nodeVersion: process.version,
    date: now.toISOString().slice(0, 10),
    time: formatLocalTime(now),
    timezone: detectTimezone(),
    git: cwd ? detectGitContext(cwd) : undefined
  };
}

function formatLocalTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short', hour12: false
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function detectTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function detectGitContext(cwd: string): { branch?: string; dirty?: boolean; repoRoot?: string; lastCommit?: string } | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim();
    } catch {
      return undefined;
    }
  };
  const repoRoot = run(['rev-parse', '--show-toplevel']);
  if (!repoRoot) return undefined;
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  const lastCommit = run(['log', '-1', '--pretty=%h %s']);
  return {
    branch,
    dirty: status === undefined ? undefined : status.length > 0,
    repoRoot,
    lastCommit
  };
}

export interface RuntimeHostOptions {
  outsideWorkspacePermission?: WorkspacePermissionHandler;
}

export interface Runtime {
  provider: ModelProvider;
  model: string;
  selectedModel?: string;
  cwd: string;
  maxTurns?: number;
  contextTokens?: number;
  requestedContextTokens?: number;
  loadedContextTokens?: number;
  providerReasoning?: boolean;
  systemPrompt?: string;
  systemPromptTokens?: number;
  attachmentCapabilities?: ReturnType<typeof inferAttachmentCapabilities>;
  tools: Tool[];
  skills: Skill[];
  history?: ChatMessage[];
  lastUserContent?: ChatMessage['content'];
  lastMediaNotices?: string[];
  run(prompt: string, options?: RuntimeRunOptions): Promise<AgentRunResult>;
  stream(prompt: string, options?: { signal?: AbortSignal }): AsyncIterable<{ content?: string; thinking?: string; done?: boolean }>;
}

export interface RuntimeRunOptions {
  signal?: AbortSignal;
  onModelStart?: AgentRunOptions['onModelStart'];
  onModelActivity?: AgentRunOptions['onModelActivity'];
  onToolStart?: AgentRunOptions['onToolStart'];
  onTurn?: AgentRunOptions['onTurn'];
}

export function resolveRuntimeSkills(base: Skill[], prompt: string, options: { cwd?: string; dirs?: string[] } = {}): Skill[] {
  return mergeSkills(base, detectSkillsForPrompt(prompt, options));
}

export async function createRuntime(options: CliOptions, hostOptions: RuntimeHostOptions = {}): Promise<Runtime> {
  const selectedModel = options.model ?? defaultModelForProvider(options.provider);
  if (options.provider === 'ollama') {
    await prepareOllama({
      model: selectedModel,
      baseUrl: options.ollamaUrl,
      autoStart: options.ollamaAutoStart
    });
  }
  const providerCapabilities = await resolveProviderAttachmentCapabilities(options.provider, selectedModel, {
    ollamaUrl: options.ollamaUrl,
    lmStudioUrl: options.lmStudioUrl,
    llamaCppUrl: options.llamaCppUrl,
    liteRtLmUrl: options.liteRtLmUrl,
    geminiApiKey: options.geminiApiKey,
    geminiApiBaseUrl: options.geminiApiBaseUrl
  });
  const model = selectedModel;
  const contextTokens = providerCapabilities.contextTokens ?? options.contextTokens;
  const provider =
    options.provider === 'gemini'
      ? new GeminiProvider({
          model,
          apiKey: options.geminiApiKey,
          baseUrl: options.geminiApiBaseUrl,
          temperature: options.temperature,
          topP: options.topP,
          maxTokens: options.maxTokens
        })
      : options.provider === 'lmstudio'
        ? new LmStudioProvider({
            model,
            baseUrl: options.lmStudioUrl,
            contextTokens,
            temperature: options.temperature,
            topP: options.topP,
            topK: options.topK,
            reasoning: providerCapabilities.supportsReasoning
          })
        : options.provider === 'llamacpp'
          ? new LlamaCppProvider({
              model,
              baseUrl: options.llamaCppUrl,
              contextTokens,
              temperature: options.temperature,
              topP: options.topP,
              maxTokens: options.maxTokens
            })
          : options.provider === 'litertlm'
            ? new LiteRtLmProvider({
                model,
                baseUrl: options.liteRtLmUrl,
                contextTokens,
                temperature: options.temperature,
                topP: options.topP,
                maxTokens: options.maxTokens
              })
        : new OllamaProvider({
            model,
            baseUrl: options.ollamaUrl,
            contextTokens,
            temperature: options.temperature,
            topP: options.topP,
            topK: options.topK
          });
  const tools = createWorkspaceTools({
    cwd: options.cwd,
    yolo: options.yolo,
    shellIdleTimeoutMs: options.shellIdleTimeoutMs,
    outsideWorkspacePermission: hostOptions.outsideWorkspacePermission
  });
  const attachmentCapabilities = inferAttachmentCapabilities({
    provider: options.provider,
    model: selectedModel,
    displayName: providerCapabilities.displayName,
    explicitImage: providerCapabilities.supportsImage,
    explicitAudio: providerCapabilities.supportsAudio,
    explicitPdf: providerCapabilities.supportsPdf
  });
  const skills = await loadSkills({ cwd: options.cwd, selected: options.skills });
  const systemContext = skillsToSystemContext(skills);
  const environment = detectAgentEnvironment(options.cwd);
  const systemPrompt = buildAgentSystemPrompt({ tools, systemContext, workspace: options.cwd, model, reasoningMode: options.reasoningMode, environment, yolo: options.yolo ?? false });
  const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
  const history = options.history ?? [];
  const runtime: Runtime = {
    provider,
    model,
    selectedModel,
    cwd: options.cwd,
    maxTurns: options.maxTurns,
    contextTokens,
    requestedContextTokens: options.contextTokens,
    loadedContextTokens: providerCapabilities.contextTokens,
    providerReasoning: providerCapabilities.supportsReasoning,
    systemPrompt,
    systemPromptTokens,
    attachmentCapabilities,
    tools,
    skills,
    history,
    async run(_prompt: string, _runOptions: RuntimeRunOptions = {}) {
      throw new Error('Runtime run not initialized.');
    },
    async *stream(_prompt: string, _streamOptions: { signal?: AbortSignal } = {}) {
      throw new Error('Runtime stream not initialized.');
    }
  };

  const runPrompt = async (prompt: string, runOptions: RuntimeRunOptions = {}) => {
    const media = await buildPromptContentWithMedia(prompt, options.cwd, attachmentCapabilities);
    assertContentSupported(media.content, attachmentCapabilities, model, options.provider);
    runtime.lastUserContent = media.content;
    runtime.lastMediaNotices = media.notices;
    const promptText = promptTextForMediaContent(media.content, prompt);
    const attachments = Array.isArray(media.content) ? media.content.filter((part) => part.type !== 'text') : undefined;
    const directMediaQuestion = isLikelyDirectMediaQuestion(promptText, attachments?.length ?? 0);
    const runSkills = resolveRuntimeSkills(skills, promptText, { cwd: options.cwd });
    const runSystemContext = skillsToSystemContext(runSkills);
    const runTools = directMediaQuestion ? [] : tools;
    runtime.systemPrompt = directMediaQuestion
      ? buildDirectMediaSystemPrompt(model, options.reasoningMode, runSystemContext)
      : buildAgentSystemPrompt({
          tools: runTools,
          systemContext: runSystemContext,
          workspace: options.cwd,
          model,
          reasoningMode: options.reasoningMode,
          environment,
          yolo: options.yolo ?? false
        });
    runtime.systemPromptTokens = Math.ceil(runtime.systemPrompt.length / 4);
    if (directMediaQuestion && attachments?.length) {
      return runDirectMediaRequest({
        provider,
        systemPrompt: runtime.systemPrompt,
        promptText,
        attachments,
        history,
        generation: {
          maxTokens: options.maxTokens,
          contextTokens,
          temperature: options.temperature,
          topP: options.topP,
          topK: options.topK,
          reasoningMode: options.reasoningMode,
          includeRawChunks: true,
          signal: runOptions.signal
        },
        runOptions
      });
    }
    const agent = new Agent({
      provider,
      tools: runTools,
      maxTurns: options.maxTurns ?? null,
      workspace: directMediaQuestion ? undefined : options.cwd,
      model,
      reasoningMode: options.reasoningMode,
      generation: {
        maxTokens: options.maxTokens,
        contextTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        reasoningMode: options.reasoningMode,
        includeRawChunks: true,
        signal: runOptions.signal
      },
      systemContext: runSystemContext,
      environment,
      history,
      yolo: options.yolo ?? false
    });
    return agent.run(promptText, {
      attachments,
      onModelStart: runOptions.onModelStart,
      onModelActivity: runOptions.onModelActivity,
      onToolStart: runOptions.onToolStart,
      onTurn: runOptions.onTurn
    });
  };

  runtime.run = runPrompt;
  runtime.stream = async function* stream(prompt: string, streamOptions = {}) {
      if (!isStreamingProvider(provider)) {
        streamOptions.signal?.throwIfAborted();
        const result = await runPrompt(prompt, { signal: streamOptions.signal });
        yield { content: result.answer, done: true };
        return;
      }

      const streamSkills = resolveRuntimeSkills(skills, prompt, { cwd: options.cwd });
      const streamSystemContext = skillsToSystemContext(streamSkills);
      yield* provider.generateStream([
        {
          role: 'system',
          content: [
            buildGemmaThinkingInstructions(model, options.reasoningMode),
            'You are Gemma CLI, a helpful local command-line assistant.',
            'Answer normally. Do not wrap the response in JSON in TUI streaming mode.',
            streamSystemContext.length > 0 ? `Additional skills and instructions:\n${streamSystemContext.join('\n\n')}` : ''
          ].filter(Boolean).join('\n')
        },
        { role: 'user', content: prompt }
      ], {
        maxTokens: options.maxTokens,
        contextTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        reasoningMode: options.reasoningMode,
        includeRawChunks: true,
        signal: streamOptions.signal
      });
    };
  return runtime;
}

export function buildDirectMediaSystemPrompt(
  model: string,
  reasoningMode: GenerateOptions['reasoningMode'],
  systemContext: string[] = []
): string {
  return [
    buildGemmaThinkingInstructions(model, reasoningMode),
    'You are Gemma CLI, a helpful local command-line assistant.',
    'The user attached media directly to this message.',
    'Inspect attached images, audio, PDFs, or sampled video frames directly from the message content.',
    'Answer the user media request directly. Do not say you need tools, filesystem access, or access to the media path.',
    'Do not wrap the response in JSON. Return only the answer requested by the user.',
    systemContext.length > 0 ? `Additional skills and instructions:\n${systemContext.join('\n\n')}` : ''
  ].filter(Boolean).join('\n');
}

export async function runDirectMediaRequest(options: {
  provider: ModelProvider;
  systemPrompt: string;
  promptText: string;
  attachments: ContentPart[];
  history?: ChatMessage[];
  generation: GenerateOptions;
  runOptions?: RuntimeRunOptions;
}): Promise<AgentRunResult> {
  const startedAt = Date.now();
  await options.runOptions?.onModelStart?.({ index: 0 });
  const answer = await options.provider.generate([
    { role: 'system', content: options.systemPrompt },
    // Carry prior conversation/--resume history so follow-up media questions
    // ("how does this differ from the first image?") keep their context.
    ...(options.history ?? []),
    {
      role: 'user',
      content: [
        { type: 'text', text: options.promptText },
        ...options.attachments
      ]
    }
  ], {
    ...options.generation,
    onActivity: async (chunk) => {
      await options.generation.onActivity?.(chunk);
      await options.runOptions?.onModelActivity?.({ index: 0, chunk });
    }
  });
  const finalAnswer = normalizeDirectMediaAnswer(answer);
  const finalTurn = { kind: 'final' as const, content: finalAnswer };
  await options.runOptions?.onTurn?.({ index: 0, turn: finalTurn });
  return {
    answer: finalAnswer,
    turns: [finalTurn],
    stats: {
      durationMs: Date.now() - startedAt,
      turns: 1,
      toolCalls: 0
    },
    completionStatus: 'completed'
  };
}

function normalizeDirectMediaAnswer(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed.startsWith('{')) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as { answer?: unknown };
    if (typeof parsed.answer === 'string') {
      return parsed.answer;
    }
  } catch {
    // Keep the raw model text when it is not valid JSON.
  }
  return trimmed;
}

export function promptTextForMediaContent(content: ChatMessage['content'], fallbackPrompt: string): string {
  if (!Array.isArray(content)) {
    return fallbackPrompt;
  }
  const text = content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const hasAttachments = content.some((part) => part.type !== 'text');
  if (!hasAttachments) {
    return text;
  }
  return [
    'Media attachments are included directly in this user message. Inspect the attached media itself; do not use tools or file reads to access the media path unless the user asks for filesystem work.',
    text
  ].filter(Boolean).join('\n');
}

export function isLikelyDirectMediaQuestion(promptText: string, attachmentCount: number): boolean {
  if (attachmentCount <= 0) {
    return false;
  }
  const lower = promptText.toLowerCase();
  if (/\b(build|scaffold|edit|modify|fix|implement|patch|save|run|test|install|execute|commit)\b/.test(lower)) {
    return false;
  }
  if (/\b(write|create)\b[\s\S]{0,40}\b(file|script|app|website|web app|page|component|svg|html|css|javascript|typescript|js|ts)\b/.test(lower)) {
    return false;
  }
  return /\b(describe|caption|transcribe|summarize|identify|classify|analyze|analyse|extract|read|what is|what's|what do you see|what is said)\b/.test(lower);
}

function defaultModelForProvider(provider: CliOptions['provider']): string {
  if (provider === 'ollama') return 'gemma4:26b';
  if (provider === 'gemini') return 'gemini-3.5-flash';
  return 'gemma-3-27b-it';
}

function isStreamingProvider(provider: ModelProvider): provider is StreamingModelProvider {
  return typeof (provider as Partial<StreamingModelProvider>).generateStream === 'function';
}

async function resolveProviderAttachmentCapabilities(
  provider: CliOptions['provider'],
  model: string,
  options: { ollamaUrl?: string; lmStudioUrl?: string; llamaCppUrl?: string; liteRtLmUrl?: string; geminiApiKey?: string; geminiApiBaseUrl?: string }
): Promise<{ displayName?: string; supportsImage?: boolean; supportsAudio?: boolean; supportsPdf?: boolean; supportsReasoning?: boolean; contextTokens?: number }> {
  try {
    if (provider === 'ollama') {
      return await getOllamaModelCapabilities(model, options.ollamaUrl);
    }
    if (provider === 'lmstudio') {
      const infos = await listLmStudioModelInfos(options.lmStudioUrl);
      const exact = infos.find((info) => info.name === model);
      return {
        displayName: exact?.displayName,
        supportsImage: exact?.supportsImage,
        supportsAudio: exact?.supportsAudio,
        supportsReasoning: exact?.supportsReasoning
      };
    }
    if (provider === 'llamacpp') {
      const infos = await listLlamaCppModelInfos(options.llamaCppUrl);
      const exact = infos.find((info) => info.name === model);
      return {
        displayName: exact?.displayName,
        supportsImage: false,
        supportsAudio: false,
        supportsReasoning: true
      };
    }
    if (provider === 'litertlm') {
      const infos = await listLiteRtLmModelInfos(options.liteRtLmUrl);
      const exact = infos.find((info) => info.name === model);
      return {
        displayName: exact?.displayName,
        supportsImage: false,
        supportsAudio: false,
        supportsReasoning: true
      };
    }
    if (provider === 'gemini') {
      const infos = await listGeminiModelInfos(options.geminiApiKey, options.geminiApiBaseUrl);
      const exact = infos.find((info) => info.name === model);
      return {
        displayName: exact?.displayName,
        supportsImage: exact?.supportsImage,
        supportsAudio: exact?.supportsAudio,
        supportsPdf: exact?.supportsPdf,
        supportsReasoning: exact?.supportsReasoning,
        contextTokens: exact?.contextTokens
      };
    }
  } catch {
    return {};
  }
  return {};
}

export function formatRunResult(result: AgentRunResult): string {
  const toolLines = result.turns
    .filter((turn) => turn.kind === 'tool' && turn.toolCall)
    .map((turn) => {
      const status = turn.toolResult?.meta?.presentation === 'notice'
        ? 'notice'
        : turn.toolResult?.ok ? 'ok' : 'failed';
      return `tool ${turn.toolCall?.tool}: ${status}`;
    });
  return [...toolLines, result.answer].join('\n');
}

export function messageContentToText(content: ChatMessage['content']): string {
  return contentToText(content);
}

/**
 * Append a completed prompt/response exchange onto a runtime's history so the
 * next call carries conversational context. Pushes in place onto the same array
 * the runtime closure reads, so stateless callers (e.g. ACP session/prompt)
 * become stateful across prompts.
 */
export function appendExchangeToRuntimeHistory(runtime: Runtime, prompt: string, result: AgentRunResult): void {
  runtime.history ??= [];
  runtime.history.push({ role: 'user', content: runtime.lastUserContent ?? prompt });
  runtime.lastUserContent = undefined;
  for (const turn of result.turns) {
    if (turn.kind === 'tool') {
      runtime.history.push({
        role: 'user',
        content: `Tool result for ${turn.toolCall?.tool ?? 'tool'}:\n${JSON.stringify({
          ok: turn.toolResult?.ok ?? true,
          output: turn.toolResult?.output ?? turn.content
        })}`
      });
    } else {
      runtime.history.push({ role: 'assistant', content: turn.content });
    }
  }
}
