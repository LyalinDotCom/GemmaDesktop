import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectSkillsForPrompt, listInstalledSkills, loadSkills, mergeSkills, skillsToSystemContext } from './skills.js';

describe('skills', () => {
  it('loads markdown skills from .gemma/skills', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-skills-'));
    await mkdir(join(cwd, '.gemma', 'skills'), { recursive: true });
    await writeFile(join(cwd, '.gemma', 'skills', 'coding.md'), '# Coding\nPrefer small patches.', 'utf8');

    const skills = await loadSkills({ cwd });

    expect(skills).toMatchObject([{ name: 'Coding', content: '# Coding\nPrefer small patches.' }]);
    expect(skillsToSystemContext(skills)[0]).toContain('Skill: Coding');
  });

  it('loads folder skills from SKILL.md frontmatter', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-skills-'));
    await mkdir(join(cwd, '.gemma', 'skills', 'react-polish'), { recursive: true });
    await writeFile(join(cwd, '.gemma', 'skills', 'react-polish', 'SKILL.md'), [
      '---',
      'name: React Polish',
      'description: Make React apps feel finished.',
      '---',
      '',
      '# React Polish',
      '',
      'Validate the mounted app.',
      ''
    ].join('\n'), 'utf8');

    const skills = await loadSkills({ cwd, selected: ['react-polish'] });

    expect(skills).toMatchObject([
      {
        name: 'React Polish',
        description: 'Make React apps feel finished.',
        source: 'workspace'
      }
    ]);
    expect(skills[0]?.path).toMatch(/react-polish\/SKILL\.md$/);
    expect(skills[0]?.content).toBe('# React Polish\n\nValidate the mounted app.\n');
    expect(skillsToSystemContext(skills)[0]).not.toContain('---');
  });

  it('can select skills by heading name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-skills-'));
    await mkdir(join(cwd, '.gemma', 'skills'), { recursive: true });
    await writeFile(join(cwd, '.gemma', 'skills', 'a.md'), '# A\nA skill', 'utf8');
    await writeFile(join(cwd, '.gemma', 'skills', 'b.md'), '# B\nB skill', 'utf8');

    await expect(loadSkills({ cwd, selected: ['B'] })).resolves.toMatchObject([{ name: 'B' }]);
  });

  it('can explicitly load an installed React app builder skill by alias', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-skills-'));
    const dir = await installReactSkillFixture(cwd);

    await expect(loadSkills({ cwd, dirs: [dir], selected: ['react'] })).resolves.toMatchObject([
      {
        name: 'React App Builder',
        content: expect.stringContaining('Keep each file and write_file payload small enough')
      }
    ]);
    const [skill] = await loadSkills({ cwd, dirs: [dir], selected: ['react'] });
    expect(skill.path).toMatch(/react-app-builder\/SKILL\.md$/);
    expect(skill.content).toContain('Do not put a whole non-trivial app into one large App.jsx/App.tsx file');
    expect(skill.content).toContain('Do not add dead controls');
    expect(skill.content).not.toContain('---');
  });

  it('auto-detects an installed React skill from React app prompts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gemma-skills-'));
    const dir = installReactSkillFixtureSync(cwd);

    expect(detectSkillsForPrompt('Build a React black hole visualizer web app with controls', { cwd, dirs: [dir] })).toMatchObject([
      { name: 'React App Builder' }
    ]);
    expect(detectSkillsForPrompt('summarize package.json', { cwd, dirs: [dir] })).toEqual([]);
  });

  it('merges explicit and detected skills without duplicates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gemma-skills-'));
    const dir = await installReactSkillFixture(cwd);
    const explicit = await loadSkills({ cwd, dirs: [dir], selected: ['react'] });
    const merged = mergeSkills(explicit, detectSkillsForPrompt('Create a React notes app', { cwd, dirs: [dir] }));

    expect(merged.map((skill) => skill.name)).toEqual(['React App Builder']);
    expect(listInstalledSkills({ cwd, dirs: [dir] }).map((skill) => skill.name)).toContain('React App Builder');
    expect(skillsToSystemContext(merged)[0]).toContain('Skill: React App Builder');
  });
});

async function installReactSkillFixture(root: string): Promise<string> {
  const dir = join(root, 'skills');
  await mkdir(join(dir, 'react-app-builder'), { recursive: true });
  await writeFile(join(dir, 'react-app-builder', 'SKILL.md'), reactSkillFixture(), 'utf8');
  return dir;
}

function installReactSkillFixtureSync(root: string): string {
  const dir = join(root, 'skills');
  mkdirSync(join(dir, 'react-app-builder'), { recursive: true });
  writeFileSync(join(dir, 'react-app-builder', 'SKILL.md'), reactSkillFixture(), 'utf8');
  return dir;
}

function reactSkillFixture(): string {
  return [
    '---',
    'name: React App Builder',
    'description: Use when building React apps.',
    '---',
    '',
    '# React App Builder',
    '',
    'Keep each file and write_file payload small enough.',
    'Do not put a whole non-trivial app into one large App.jsx/App.tsx file.',
    'Do not add dead controls.',
    ''
  ].join('\n');
}
