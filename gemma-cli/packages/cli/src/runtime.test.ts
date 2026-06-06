import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Skill } from '@gemma-sdk/agent';
import { isLikelyDirectMediaQuestion, promptTextForMediaContent, resolveRuntimeSkills } from './runtime.js';

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
