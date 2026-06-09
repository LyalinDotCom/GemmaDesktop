import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Skill } from '@gemma-sdk/agent';
import type { ChatMessage, GenerateOptions, ModelProvider } from '@gemma-sdk/agent';
import {
  buildDirectMediaSystemPrompt,
  isLikelyDirectMediaQuestion,
  promptTextForMediaContent,
  resolveRuntimeSkills,
  runDirectMediaRequest
} from './runtime.js';

describe('resolveRuntimeSkills', () => {
  it('adds an installed React skill for React app prompts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gemma-runtime-'));
    const dir = installReactSkillFixture(cwd);
    const skills = resolveRuntimeSkills([], 'Build a React black hole visualizer web app with controls.', { cwd, dirs: [dir] });

    expect(skills.map((skill) => skill.name)).toContain('React App Builder');
  });

  it('does not duplicate an explicitly loaded React skill', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gemma-runtime-'));
    const dir = installReactSkillFixture(cwd);
    const explicit: Skill = {
      name: 'React App Builder',
      path: '/tmp/react-app-builder/SKILL.md',
      content: 'explicit'
    };

    const skills = resolveRuntimeSkills([explicit], 'Create a React notes app.', { cwd, dirs: [dir] });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toBe(explicit);
  });
});

describe('promptTextForMediaContent', () => {
  it('keeps text-only prompts unchanged', () => {
    expect(promptTextForMediaContent('Describe this image.', 'Describe this image.')).toBe('Describe this image.');
  });

  it('tells local models to inspect attached media directly', () => {
    const prompt = promptTextForMediaContent([
      { type: 'text', text: 'Describe the image at @"/tmp/sample.jpg".' },
      { type: 'image_url', url: '/tmp/sample.jpg', mediaType: 'image/jpeg' }
    ], 'fallback');

    expect(prompt).toContain('Media attachments are included directly in this user message.');
    expect(prompt).toContain('Inspect the attached media itself');
    expect(prompt).toContain('Describe the image at @"/tmp/sample.jpg".');
  });
});

describe('isLikelyDirectMediaQuestion', () => {
  it('routes simple media understanding prompts away from workspace tools', () => {
    expect(isLikelyDirectMediaQuestion('Describe the attached image.', 1)).toBe(true);
    expect(isLikelyDirectMediaQuestion('Transcribe what is said in the attached audio.', 1)).toBe(true);
    expect(isLikelyDirectMediaQuestion('What do you see in this screenshot?', 1)).toBe(true);
  });

  it('keeps workspace tools for media-guided build and edit tasks', () => {
    expect(isLikelyDirectMediaQuestion('Use this screenshot to build a web app.', 1)).toBe(false);
    expect(isLikelyDirectMediaQuestion('Read this image and write a script from it.', 1)).toBe(false);
    expect(isLikelyDirectMediaQuestion('Describe the screenshot, then save the notes to a file.', 1)).toBe(false);
    expect(isLikelyDirectMediaQuestion('Describe the attached image.', 0)).toBe(false);
  });
});

describe('direct media requests', () => {
  it('uses a normal media prompt instead of the coding-agent JSON protocol', async () => {
    const provider = new CapturingProvider('{"answer":"That is one small step."}');
    const starts: unknown[] = [];
    const activities: unknown[] = [];
    const turns: unknown[] = [];
    const systemPrompt = buildDirectMediaSystemPrompt('gemma4:e2b', 'off');

    const result = await runDirectMediaRequest({
      provider,
      systemPrompt,
      promptText: 'Transcribe the audio at @"/tmp/sample.mp3". Return only the transcript.',
      attachments: [{ type: 'audio_url', url: '/tmp/sample.mp3', mediaType: 'audio/mpeg' }],
      generation: { reasoningMode: 'off', contextTokens: 131072, includeRawChunks: true },
      runOptions: {
        onModelStart(event) {
          starts.push(event);
        },
        onModelActivity(event) {
          activities.push(event);
        },
        onTurn(event) {
          turns.push(event);
        }
      }
    });

    expect(systemPrompt).toContain('Do not wrap the response in JSON');
    expect(systemPrompt).toContain('Do not say you need tools');
    expect(systemPrompt).not.toContain('Preferred portable format');
    expect(provider.messages).toEqual([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe the audio at @"/tmp/sample.mp3". Return only the transcript.' },
          { type: 'audio_url', url: '/tmp/sample.mp3', mediaType: 'audio/mpeg' }
        ]
      }
    ]);
    expect(provider.options).toMatchObject({ reasoningMode: 'off', contextTokens: 131072, includeRawChunks: true });
    expect(starts).toEqual([{ index: 0 }]);
    expect(activities).toEqual([{ index: 0, chunk: { content: '{"answer":"That is one small step."}', done: true } }]);
    expect(turns).toEqual([{ index: 0, turn: { kind: 'final', content: 'That is one small step.' } }]);
    expect(result).toMatchObject({
      answer: 'That is one small step.',
      turns: [{ kind: 'final', content: 'That is one small step.' }],
      stats: { turns: 1, toolCalls: 0 },
      completionStatus: 'completed'
    });
  });

  it('includes prior conversation history so follow-up media questions keep context', async () => {
    const provider = new CapturingProvider('It is brighter than the first image.');
    const history: ChatMessage[] = [
      { role: 'user', content: 'Describe the first image.' },
      { role: 'assistant', content: 'A dim sunset over water.' }
    ];

    await runDirectMediaRequest({
      provider,
      systemPrompt: buildDirectMediaSystemPrompt('gemma4:e2b', 'off'),
      promptText: 'How does this differ from the first image?',
      attachments: [{ type: 'image_url', url: '/tmp/second.png', mediaType: 'image/png' }],
      history,
      generation: { reasoningMode: 'off', includeRawChunks: true }
    });

    expect(provider.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'Describe the first image.' },
      { role: 'assistant', content: 'A dim sunset over water.' },
      { role: 'user', content: [{ type: 'text', text: 'How does this differ from the first image?' }, { type: 'image_url', url: '/tmp/second.png', mediaType: 'image/png' }] }
    ]);
  });
});

function installReactSkillFixture(root: string): string {
  const dir = join(root, 'skills');
  mkdirSync(join(dir, 'react-app-builder'), { recursive: true });
  writeFileSync(join(dir, 'react-app-builder', 'SKILL.md'), [
    '---',
    'name: React App Builder',
    'description: Use when building React apps.',
    '---',
    '',
    '# React App Builder',
    '',
    'Build solid React apps.',
    ''
  ].join('\n'), 'utf8');
  return dir;
}

class CapturingProvider implements ModelProvider {
  readonly name = 'test';
  messages: ChatMessage[] = [];
  options: GenerateOptions = {};

  constructor(private readonly response: string) {}

  async generate(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.messages = messages;
    this.options = options;
    await options.onActivity?.({ content: this.response, done: true });
    return this.response;
  }
}
