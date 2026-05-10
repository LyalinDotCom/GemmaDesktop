import { contentToText } from './content.js';
import type { ChatMessage, GenerateOptions, Tool, ToolCall } from './types.js';

export type ModelProfileFamily = 'gemma4' | 'generic';

export interface ModelProfile {
  family: ModelProfileFamily;
  name?: string;
  model?: string;
  promptFormat: 'gemma4' | 'generic';
  isLargeGemmaReasoningModel: boolean;
}

const gemma4ModelPattern = /(?:^|[/:\s_-])gemma[-_]?4(?:$|[/:\s._-])/i;
const leadingGemma4Pattern = /^gemma[-_]?4[:/]/i;
const largeGemma4Pattern = /(?:^|[/:\s_-])(?:26b|31b)(?:$|[/:\s._-])/i;
const gemmaThoughtChannelPattern = /<\|channel>thought\s*[\s\S]*?<channel\|>/g;
const gemmaTurnEndPattern = /\s*<turn\|>\s*$/;
const gemmaStringDelimiter = '<|"|>';

export function modelProfileFor(model: string | undefined): ModelProfile {
  if (isGemma4ModelId(model)) {
    return {
      family: 'gemma4',
      name: 'gemma4_profile',
      model,
      promptFormat: 'gemma4',
      isLargeGemmaReasoningModel: isLargeGemma4ModelId(model)
    };
  }

  return {
    family: 'generic',
    model,
    promptFormat: 'generic',
    isLargeGemmaReasoningModel: false
  };
}

export function isGemma4ModelId(model: string | undefined): boolean {
  return Boolean(model && (gemma4ModelPattern.test(model) || leadingGemma4Pattern.test(model)));
}

export function isLargeGemma4ModelId(model: string | undefined): boolean {
  return Boolean(model && isGemma4ModelId(model) && largeGemma4Pattern.test(model));
}

export function shouldEnableProviderReasoning(
  model: string | undefined,
  options: Pick<GenerateOptions, 'reasoningMode'>,
  providerSupportsReasoning = true
): boolean {
  if (options.reasoningMode === 'off') {
    return false;
  }
  if (options.reasoningMode === 'on') {
    return true;
  }
  return providerSupportsReasoning && modelProfileFor(model).family === 'gemma4';
}

export function buildGemmaThinkingInstructions(
  model: string | undefined,
  reasoningMode: GenerateOptions['reasoningMode'] = 'auto'
): string | undefined {
  if (reasoningMode === 'off' || modelProfileFor(model).family !== 'gemma4') {
    return undefined;
  }

  return [
    '<|think|>',
    'Thinking mode is enabled for this Gemma 4 coding conversation.',
    'Use the native thought channel to reason through tool choices, code generation, failures, validation, and self-correction before taking external actions.',
    'Do not paste raw thought tokens or scratch reasoning into normal assistant text; keep visible answers concise, grounded, and useful to the user.'
  ].join('\n');
}

export function buildGemma4Prompt(messages: ChatMessage[], options: Pick<GenerateOptions, 'reasoningMode'> & { model?: string } = {}): string {
  const turns = messages.map((message) => {
    const role = gemmaRoleFor(message.role);
    return `<|turn>${role}\n${messageContentText(message)}<turn|>`;
  });
  const generationPrompt = '<|turn>model\n';
  const emptyThoughtChannel = shouldAppendEmptyGemmaThoughtChannel(options.model, options.reasoningMode)
    ? '<|channel>thought\n<channel|>'
    : '';
  return [...turns, `${generationPrompt}${emptyThoughtChannel}`].join('\n');
}

export function stripGemmaThoughtChannels(text: string): string {
  return text.replace(gemmaThoughtChannelPattern, '');
}

export function normalizeGemmaModelOutput(text: string): string {
  return stripGemmaThoughtChannels(text).replace(gemmaTurnEndPattern, '').trim();
}

export function parseGemmaNativeToolCall(text: string): ToolCall | undefined {
  const cleaned = normalizeGemmaModelOutput(text);
  const match = cleaned.match(/^<\|?tool_call\|?>\s*call:([A-Za-z0-9_.:-]+)\s*([\s\S]*?)\s*<\|?tool_call\|?>(?:\s*<\|tool_response>)?$/);
  if (!match) {
    return undefined;
  }

  const parsedArgs = parseGemmaStructuredArguments((match[2] ?? '').trim());
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    return undefined;
  }

  return {
    tool: match[1]!,
    args: parsedArgs as Record<string, unknown>
  };
}

export function looksLikeGemmaNativeToolCall(text: string): boolean {
  return /<\|?tool_call\|?>/.test(text) || /<\|?tool_response>/.test(text);
}

export function renderGemmaNativeToolDeclarations(tools: Tool[], model: string | undefined): string {
  if (tools.length === 0 || modelProfileFor(model).family !== 'gemma4') {
    return '';
  }

  return [
    '<gemma_native_tools>',
    'Gemma 4 native tool-call transport is accepted as a fallback when the runtime emits it. Call exactly one declared tool, then stop at <|tool_response>.',
    ...tools.map(renderGemmaNativeToolDeclaration),
    '</gemma_native_tools>'
  ].join('\n');
}

function shouldAppendEmptyGemmaThoughtChannel(model: string | undefined, reasoningMode: GenerateOptions['reasoningMode'] = 'auto'): boolean {
  return reasoningMode === 'off' && isLargeGemma4ModelId(model);
}

function gemmaRoleFor(role: ChatMessage['role']): 'system' | 'user' | 'model' {
  if (role === 'assistant') {
    return 'model';
  }
  if (role === 'tool') {
    return 'user';
  }
  return role;
}

function messageContentText(message: ChatMessage): string {
  const text = contentToText(
    typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text')
  );
  return message.role === 'tool' ? `Tool result:\n${text}` : text;
}

function parseGemmaStructuredArguments(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    const parser = new GemmaStructuredParser(text);
    return parser.parseComplete();
  } catch {
    return undefined;
  }
}

class GemmaStructuredParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseComplete(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new Error('Trailing Gemma structured data.');
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    if (this.startsWith(gemmaStringDelimiter)) {
      return this.parseDelimitedString();
    }
    const char = this.peek();
    if (char === '{') {
      return this.parseObject();
    }
    if (char === '[') {
      return this.parseArray();
    }
    if (char === '"') {
      return this.parseJsonString();
    }
    return this.parseBareValue();
  }

  private parseObject(): Record<string, unknown> {
    this.expect('{');
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    while (this.peek() !== '}') {
      const key = this.parseKey();
      this.skipWhitespace();
      this.expect(':');
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.peek() === ',') {
        this.index += 1;
        this.skipWhitespace();
        continue;
      }
      break;
    }
    this.expect('}');
    return result;
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const result: unknown[] = [];
    this.skipWhitespace();
    while (this.peek() !== ']') {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek() === ',') {
        this.index += 1;
        this.skipWhitespace();
        continue;
      }
      break;
    }
    this.expect(']');
    return result;
  }

  private parseKey(): string {
    this.skipWhitespace();
    if (this.peek() === '"') {
      return this.parseJsonString();
    }
    const match = /^[A-Za-z_$][\w$-]*/.exec(this.text.slice(this.index));
    if (!match) {
      throw new Error('Expected Gemma object key.');
    }
    this.index += match[0].length;
    return match[0];
  }

  private parseDelimitedString(): string {
    this.index += gemmaStringDelimiter.length;
    const end = this.text.indexOf(gemmaStringDelimiter, this.index);
    if (end === -1) {
      throw new Error('Unterminated Gemma string delimiter.');
    }
    const value = this.text.slice(this.index, end);
    this.index = end + gemmaStringDelimiter.length;
    return value;
  }

  private parseJsonString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      this.index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
    }
    throw new Error('Unterminated JSON string.');
  }

  private parseBareValue(): unknown {
    const start = this.index;
    while (this.index < this.text.length && !/[,\]}]/.test(this.text[this.index]!)) {
      this.index += 1;
    }
    const raw = this.text.slice(start, this.index).trim();
    if (!raw) {
      throw new Error('Expected Gemma value.');
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
      return Number(raw);
    }
    return raw;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? '')) {
      this.index += 1;
    }
  }

  private startsWith(value: string): boolean {
    return this.text.startsWith(value, this.index);
  }

  private peek(): string | undefined {
    return this.text[this.index];
  }

  private expect(value: string): void {
    this.skipWhitespace();
    if (this.text[this.index] !== value) {
      throw new Error(`Expected ${value}.`);
    }
    this.index += 1;
  }
}

function renderGemmaNativeToolDeclaration(tool: Tool): string {
  const properties = Object.entries(tool.parameters ?? {})
    .map(([name, description]) => `${name}:{type:${gemmaString(inferGemmaParameterType(name, description))},description:${gemmaString(description)}}`)
    .join(',');
  const required = (tool.requiredParameters ?? [])
    .map((name) => gemmaString(name))
    .join(',');
  return `<|tool>declaration:${tool.name}{description:${gemmaString(tool.description)},parameters:{type:${gemmaString('OBJECT')},properties:{${properties}},required:[${required}]}}<tool|>`;
}

function gemmaString(value: string): string {
  return `${gemmaStringDelimiter}${value.replaceAll(gemmaStringDelimiter, '')}${gemmaStringDelimiter}`;
}

function inferGemmaParameterType(name: string, description: string): 'STRING' | 'NUMBER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT' {
  const normalizedName = name.toLowerCase();
  const normalizedDescription = description.toLowerCase();
  if (/\barray\b|\blist\s+of\b/.test(normalizedDescription) || /\brequests?\b/.test(normalizedName)) {
    return 'ARRAY';
  }
  const normalized = `${normalizedName} ${normalizedDescription}`;
  if (/\bobject\b|\brecord\b/.test(normalized)) {
    return 'OBJECT';
  }
  if (/\bboolean\b|\bset true\b|\bwhether\b|\boverwrite\b|\bcreate directories\b|\binclude hidden\b|\bregex\b|\bcase sensitive\b|\bwhole word\b/.test(normalized)) {
    return 'BOOLEAN';
  }
  if (/\binteger\b|\bnumber\b|\bcount\b|\blimit\b|\boffset\b|\bbytes?\b|\btimeout\b|\bmax\b/.test(normalized)) {
    return 'NUMBER';
  }
  return 'STRING';
}
