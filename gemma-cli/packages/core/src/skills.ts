import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export interface Skill {
  name: string;
  path: string;
  content: string;
  description?: string;
  source?: 'workspace' | 'user';
}

export interface LoadSkillsOptions {
  cwd?: string;
  dirs?: string[];
  selected?: string[];
}

interface AutoSkillSpec {
  id: string;
  aliases: string[];
  detect(prompt: string): boolean;
}

const autoSkillSpecs: AutoSkillSpec[] = [
  {
    id: 'react-app-builder',
    aliases: ['react', 'react-app-builder', 'react app builder', 'frontend-react'],
    detect: looksLikeReactAppPrompt
  }
];

export async function loadSkills(options: LoadSkillsOptions = {}): Promise<Skill[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const selected = new Set((options.selected ?? []).map(normalizeSkillName));
  const dirs = options.dirs ?? defaultSkillDirs(cwd, { includeUserSkills: selected.size > 0 });
  const skills: Skill[] = [];

  for (const dir of dirs) {
    const absoluteDir = resolve(cwd, dir);
    if (!(await existsDirectory(absoluteDir))) {
      continue;
    }

    for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
      const skill = await readSkillEntry(absoluteDir, entry.name, entry.isDirectory());
      if (!skill) {
        continue;
      }

      if (selected.size === 0 || skillMatchesSelection(skill, selected)) {
        skills.push(withSkillSource(skill, cwd));
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listInstalledSkills(options: { cwd?: string; dirs?: string[] } = {}): Skill[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const dirs = options.dirs ?? defaultSkillDirs(cwd, { includeUserSkills: true });
  const skills: Skill[] = [];

  for (const dir of dirs) {
    const absoluteDir = resolve(cwd, dir);
    if (!existsDirectorySync(absoluteDir)) {
      continue;
    }

    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const skill = readSkillEntrySync(absoluteDir, entry.name, entry.isDirectory());
      if (skill) {
        skills.push(withSkillSource(skill, cwd));
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function detectSkillsForPrompt(prompt: string, options: { cwd?: string; dirs?: string[] } = {}): Skill[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const dirs = options.dirs ?? defaultSkillDirs(cwd, { includeUserSkills: true });
  const selected = new Set(
    autoSkillSpecs
      .filter((spec) => spec.detect(prompt))
      .flatMap((spec) => [spec.id, ...spec.aliases])
      .map(normalizeSkillName)
  );
  if (selected.size === 0) {
    return [];
  }

  return listInstalledSkills({ cwd, dirs }).filter((skill) => skillMatchesSelection(skill, selected));
}

export function mergeSkills(base: Skill[], detected: Skill[]): Skill[] {
  const merged = [...base];
  const seen = new Set(base.map((skill) => normalizeSkillName(skill.name)));
  for (const skill of detected) {
    const key = normalizeSkillName(skill.name);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(skill);
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsToSystemContext(skills: Skill[]): string[] {
  return skills.map((skill) => `Skill: ${skill.name}\n${skill.content.trim()}`);
}

async function readSkillEntry(root: string, entryName: string, isDirectory: boolean): Promise<Skill | undefined> {
  if (isDirectory) {
    const path = join(root, entryName, 'SKILL.md');
    if (await existsFile(path)) {
      return readSkillFile(path, entryName);
    }
    return undefined;
  }

  if (!['.md', '.txt'].includes(extname(entryName))) {
    return undefined;
  }

  return readSkillFile(join(root, entryName), basename(entryName, extname(entryName)));
}

function readSkillEntrySync(root: string, entryName: string, isDirectory: boolean): Skill | undefined {
  if (isDirectory) {
    const path = join(root, entryName, 'SKILL.md');
    if (existsFileSync(path)) {
      return readSkillFileSync(path, entryName);
    }
    return undefined;
  }

  if (!['.md', '.txt'].includes(extname(entryName))) {
    return undefined;
  }

  return readSkillFileSync(join(root, entryName), basename(entryName, extname(entryName)));
}

async function readSkillFile(path: string, fallbackName: string): Promise<Skill> {
  return parseSkillFile(path, fallbackName, await readFile(path, 'utf8'));
}

function readSkillFileSync(path: string, fallbackName: string): Skill {
  return parseSkillFile(path, fallbackName, readFileSync(path, 'utf8'));
}

function parseSkillFile(path: string, fallbackName: string, rawContent: string): Skill {
  const document = parseSkillDocument(rawContent);
  return {
    name: document.name ?? skillName(fallbackName, document.content),
    path,
    content: document.content,
    description: document.description,
    source: 'workspace'
  };
}

function parseSkillDocument(rawContent: string): { name?: string; description?: string; content: string } {
  const frontmatter = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatter) {
    return { content: rawContent };
  }

  const metadata = parseFrontmatter(frontmatter[1] ?? '');
  return {
    name: metadata.name,
    description: metadata.description,
    content: rawContent.slice(frontmatter[0].length).replace(/^\r?\n/, '')
  };
}

function parseFrontmatter(frontmatter: string): { name?: string; description?: string } {
  const metadata: { name?: string; description?: string } = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^(name|description):\s*(.*)$/);
    if (match) {
      metadata[match[1] as 'name' | 'description'] = unquoteYamlScalar(match[2] ?? '').trim();
    }
  }
  return metadata;
}

function unquoteYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function skillName(fallbackName: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallbackName;
}

function skillMatchesSelection(skill: Skill, selected: Set<string>): boolean {
  const names = [
    skill.name,
    basename(skill.path),
    basename(skill.path, extname(skill.path)),
    basename(dirname(skill.path)),
    ...skillAliases(skill)
  ].map(normalizeSkillName);
  return names.some((name) => selected.has(name));
}

function skillAliases(skill: Skill): string[] {
  const directoryName = basename(dirname(skill.path));
  const spec = autoSkillSpecs.find((candidate) => candidate.id === directoryName || normalizeSkillName(candidate.id) === normalizeSkillName(skill.name));
  return spec?.aliases ?? [];
}

function looksLikeReactAppPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const mentionsReact = /\breact\b|\btsx\b|\bvite\b/.test(text);
  const mentionsAppWork = /\b(app|web app|website|frontend|ui|dashboard|visualizer|notetaking|notes?|component|page)\b/.test(text);
  const asksToBuild = /\b(build|create|make|add|update|change|implement|design|scaffold|generate)\b/.test(text);
  return mentionsReact && mentionsAppWork && asksToBuild;
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/\.(?:md|txt)$/i, '');
}

function defaultSkillDirs(cwd: string, options: { includeUserSkills: boolean }): string[] {
  return [
    ...(options.includeUserSkills ? [userSkillDir()] : []),
    join(cwd, '.gemma', 'skills')
  ];
}

function userSkillDir(): string {
  const home = process.env.GEMMA_CLI_HOME ?? join(homedir(), '.gemmacli');
  return join(home, 'skills');
}

function withSkillSource(skill: Skill, cwd: string): Skill {
  const userRoot = resolve(userSkillDir());
  const skillPath = resolve(skill.path);
  return {
    ...skill,
    source: isPathInside(userRoot, skillPath) ? 'user' : 'workspace'
  };
}

function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function existsDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existsFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
