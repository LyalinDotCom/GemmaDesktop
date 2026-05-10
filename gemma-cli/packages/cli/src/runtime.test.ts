import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Skill } from 'gemma-cli-core';
import { resolveRuntimeSkills } from './runtime.js';

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
