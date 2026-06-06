import { describe, expect, it } from 'vitest';
import {
  buildGemma4Prompt,
  modelProfileFor,
  normalizeGemmaModelOutput,
  parseGemmaNativeToolCall,
  renderGemmaNativeToolDeclarations,
  shouldEnableProviderReasoning
} from './modelProfiles.js';
import type { Tool } from './types.js';

const sampleTool: Tool = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: {
    path: 'Workspace-relative file path.',
    limit: 'Optional line count limit.'
  },
  requiredParameters: ['path'],
  async run() {
    return { ok: true, output: '' };
  }
};

describe('model profiles', () => {
  it('recognizes dashed and Ollama Gemma 4 model ids', () => {
    expect(modelProfileFor('google/gemma-4-26b-a4b')).toMatchObject({
      family: 'gemma4',
      name: 'gemma4_profile',
      promptFormat: 'gemma4',
      isLargeGemmaReasoningModel: true
    });
    expect(modelProfileFor('gemma4:31b')).toMatchObject({
      family: 'gemma4',
      promptFormat: 'gemma4',
      isLargeGemmaReasoningModel: true
    });
    expect(modelProfileFor('qwen2.5-coder')).toMatchObject({
      family: 'generic',
      promptFormat: 'generic',
      isLargeGemmaReasoningModel: false
    });
    expect(modelProfileFor('qwen2.5-coder').name).toBeUndefined();
  });

  it('enables provider reasoning for Gemma 4 by default when supported', () => {
    expect(shouldEnableProviderReasoning('google/gemma-4-26b-a4b', {}, true)).toBe(true);
    expect(shouldEnableProviderReasoning('google/gemma-4-26b-a4b', { reasoningMode: 'off' }, true)).toBe(false);
    expect(shouldEnableProviderReasoning('qwen2.5-coder', {}, true)).toBe(false);
    expect(shouldEnableProviderReasoning('qwen2.5-coder', { reasoningMode: 'on' }, true)).toBe(true);
    expect(shouldEnableProviderReasoning('qwen2.5-coder', { reasoningMode: 'on' }, false)).toBe(false);
    expect(shouldEnableProviderReasoning('google/gemma-4-31b', { reasoningMode: 'on' }, false)).toBe(false);
    expect(shouldEnableProviderReasoning('google/gemma-4-26b-a4b', {}, false)).toBe(false);
  });

  it('recognizes hosted Gemini profiles without using Gemma 4 prompt formatting', () => {
    expect(modelProfileFor('gemini-3.5-flash')).toMatchObject({
      family: 'gemini',
      name: 'gemini_flash_profile',
      promptFormat: 'generic',
    });
    expect(modelProfileFor('gemini-3.1-pro-preview-customtools')).toMatchObject({
      family: 'gemini',
      name: 'gemini_custom_tools_profile',
      promptFormat: 'generic',
    });
  });

  it('builds Gemma 4 control-token prompts for LM Studio text requests', () => {
    const prompt = buildGemma4Prompt([
      { role: 'system', content: '<|think|>\nYou are helpful.' },
      { role: 'user', content: 'Hello.' }
    ], { model: 'google/gemma-4-26b-a4b' });

    expect(prompt).toContain('<|turn>system\n<|think|>\nYou are helpful.<turn|>');
    expect(prompt).toContain('<|turn>user\nHello.<turn|>');
    expect(prompt).toMatch(/<\|turn>model\n$/);
  });

  it('adds the empty thought channel for large Gemma 4 when thinking is disabled', () => {
    const prompt = buildGemma4Prompt([
      { role: 'user', content: 'Hello.' }
    ], { model: 'google/gemma-4-31b-it', reasoningMode: 'off' });

    expect(prompt).toContain('<|turn>model\n<|channel>thought\n<channel|>');
  });

  it('strips Gemma thought channels before parser-visible output', () => {
    expect(normalizeGemmaModelOutput('<|channel>thought\nplan\n<channel|>{"answer":"ok"}<turn|>')).toBe('{"answer":"ok"}');
  });

  it('parses native Gemma tool calls with thought channels and Gemma string delimiters', () => {
    expect(parseGemmaNativeToolCall([
      '<|channel>thought',
      'Need a file read.',
      '<channel|><|tool_call>call:read_file{path:<|"|>src/index.ts<|"|>,limit:120}<tool_call|><|tool_response>'
    ].join('\n'))).toEqual({
      tool: 'read_file',
      args: {
        path: 'src/index.ts',
        limit: 120
      }
    });
  });

  it('parses Gemma native calls that use JSON-style quoted values and arrays', () => {
    expect(parseGemmaNativeToolCall('<|tool_call>call:read_files{requests:[{path:"index.html"},{path:"style.css"}]}<tool_call|>')).toEqual({
      tool: 'read_files',
      args: {
        requests: [
          { path: 'index.html' },
          { path: 'style.css' }
        ]
      }
    });
  });

  it('renders Gemma native tool declarations only for Gemma profiles', () => {
    const declaration = renderGemmaNativeToolDeclarations([sampleTool], 'google/gemma-4-26b-a4b');
    expect(declaration).toContain('<|tool>declaration:read_file');
    expect(declaration).toContain('path:{type:<|"|>STRING<|"|>');
    expect(declaration).toContain('limit:{type:<|"|>NUMBER<|"|>');
    expect(renderGemmaNativeToolDeclarations([sampleTool], 'qwen2.5-coder')).toBe('');
  });

  it('does not infer array type from action words like list', () => {
    const declaration = renderGemmaNativeToolDeclarations([{
      name: 'list_tree',
      description: 'List a directory tree.',
      parameters: {
        path: 'Workspace-relative directory to list. Defaults to "." when omitted.',
        include: 'Optional glob or list of globs to include.',
        requests: 'Non-empty array of file read requests.'
      },
      async run() {
        return { ok: true, output: '' };
      }
    }], 'gemma4:26b');

    expect(declaration).toContain('path:{type:<|"|>STRING<|"|>');
    expect(declaration).toContain('include:{type:<|"|>ARRAY<|"|>');
    expect(declaration).toContain('requests:{type:<|"|>ARRAY<|"|>');
  });
});
