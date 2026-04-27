import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'

export interface InstalledSkillRecord {
  id: string
  slug: string
  name: string
  description: string
  location: string
  directory: string
  root: string
  rootLabel: string
  tokenEstimate: number
}

export interface SkillContextBundle {
  skill: InstalledSkillRecord
  text: string
  truncated: boolean
}

export interface SkillCatalogEntry {
  id: string
  repo: string
  skillName: string
  installsText?: string
  url?: string
}

const FRONTMATTER_REGEX =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.sql',
  '.css',
])

const MAX_FILES_PER_SKILL = 16
const MAX_SKILL_CHARS = 90_000
const SKILLS_CLI_STAGING_TARGET = 'universal'
const SKILLS_CLI_SETUP_STEPS = [
  '1. Install Node.js so `npx` is available in Terminal.',
  '2. Run `npx skills --help` and make sure it succeeds.',
  '3. Retry the skill search or install action in Gemma Desktop.',
].join('\n')

export function getGemmaDesktopSkillRoot(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), 'skills')
}

function normalizeActivationRootLabel(rootLabel: string): string {
  return rootLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function skillActivationId(skill: InstalledSkillRecord): string {
  return `${normalizeActivationRootLabel(skill.rootLabel)}:${skill.slug}`
}

function normalizeSkillLookupValue(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^['"`]+|['"`]+$/g, ''))
    .filter(Boolean)

  for (const line of lines) {
    const labeledMatch = line.match(
      /^(?:activation(?:[_\s-]?id)?|skill(?:[_\s-]?id)?|id)\s*:\s*(.+)$/i,
    )
    if (labeledMatch?.[1]) {
      return labeledMatch[1].trim().toLowerCase()
    }

    if (/^[a-z0-9-]+:[a-z0-9._/-]+$/i.test(line)) {
      return line.toLowerCase()
    }
  }

  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .toLowerCase()
}

function parseSimpleFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const lines = content.split(/\r?\n/)
  let name: string | undefined
  let description: string | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line == null) {
      continue
    }
    const nameMatch = line.match(/^\s*name:\s*(.*)$/)
    if (nameMatch?.[1] != null) {
      name = nameMatch[1].trim()
      continue
    }

    const descriptionMatch = line.match(/^\s*description:\s*(.*)$/)
    if (descriptionMatch?.[1] != null) {
      const descriptionLines = [descriptionMatch[1].trim()]
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]
        if (nextLine == null) {
          break
        }
        if (/^[ \t]+\S/.test(nextLine)) {
          descriptionLines.push(nextLine.trim())
          index += 1
          continue
        }
        break
      }
      description = descriptionLines.filter(Boolean).join(' ')
    }
  }

  if (name && description) {
    return { name, description }
  }
  return null
}

function parseSkillFrontmatter(
  content: string,
): { name: string; description: string; body: string } | null {
  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    return null
  }
  const frontmatter = match[1]
  if (!frontmatter) {
    return null
  }

  const parsed = parseSimpleFrontmatter(frontmatter)
  if (!parsed) {
    return null
  }

  return {
    name: parsed.name.replace(/[:\\/<>*?"|]/g, '-'),
    description: parsed.description,
    body: match[2]?.trim() ?? '',
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function labelForRoot(root: string): string {
  const normalized = path.resolve(root)
  const parentRootKey = path.basename(path.dirname(normalized))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  if (
    path.basename(normalized) === 'skills'
    && parentRootKey.includes('gemmadesktop')
  ) {
    return 'Gemma Desktop'
  }
  return path.basename(normalized) || normalized
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function removePathIfPresent(target: string): Promise<void> {
  try {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      await fs.unlink(target)
      return
    }
    await fs.rm(target, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

async function ensureSkillDirectoryRemoved(input: {
  skillName: string
  directory: string
  root: string
}): Promise<void> {
  const resolvedRoot = path.resolve(input.root)
  const resolvedDirectory = path.resolve(input.directory)

  if (!isPathWithinRoot(resolvedRoot, resolvedDirectory)) {
    throw new Error(
      `Refusing to remove ${input.skillName} because ${resolvedDirectory} is outside ${resolvedRoot}.`,
    )
  }

  if (path.basename(resolvedDirectory) !== input.skillName) {
    throw new Error(
      `Refusing to remove ${input.skillName} because the skill directory does not match the expected slug.`,
    )
  }

  if (!(await fileExists(resolvedDirectory))) {
    return
  }

  await removePathIfPresent(resolvedDirectory)

  if (await fileExists(resolvedDirectory)) {
    throw new Error(
      `Gemma Desktop could not verify that ${input.skillName} was removed from ${resolvedDirectory}.`,
    )
  }
}

async function discoverSkillFiles(
  root: string,
  maxDepth = 3,
): Promise<string[]> {
  const resolvedRoot = path.resolve(root)
  if (!(await fileExists(resolvedRoot))) {
    return []
  }

  const found: string[] = []

  async function walk(current: string, depth: number): Promise<void> {
    const skillPath = path.join(current, 'SKILL.md')
    if (await fileExists(skillPath)) {
      found.push(skillPath)
      return
    }

    if (depth <= 0) {
      return
    }

    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }
      await walk(path.join(current, entry.name), depth - 1)
    }
  }

  await walk(resolvedRoot, maxDepth)
  return found
}

export async function discoverInstalledSkills(
  roots: string[],
): Promise<InstalledSkillRecord[]> {
  const skills: InstalledSkillRecord[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    const files = await discoverSkillFiles(resolvedRoot)
    for (const skillFile of files) {
      if (seen.has(skillFile)) {
        continue
      }
      seen.add(skillFile)

      try {
        const raw = await fs.readFile(skillFile, 'utf8')
        const parsed = parseSkillFrontmatter(raw)
        if (!parsed) {
          continue
        }
        const directory = path.dirname(skillFile)
        skills.push({
          id: skillFile,
          slug: path.basename(directory),
          name: parsed.name,
          description: parsed.description,
          location: skillFile,
          directory,
          root: resolvedRoot,
          rootLabel: labelForRoot(resolvedRoot),
          tokenEstimate: tokenEstimate(raw),
        })
      } catch {
        continue
      }
    }
  }

  return skills.sort((left, right) => {
    if (left.rootLabel !== right.rootLabel) {
      return left.rootLabel.localeCompare(right.rootLabel)
    }
    return left.name.localeCompare(right.name)
  })
}

async function gatherBundleFiles(skillDirectory: string): Promise<string[]> {
  const files: string[] = []

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }

      if (entry.name === 'SKILL.md') {
        continue
      }

      if (!SUPPORTED_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue
      }

      files.push(target)
    }
  }

  await walk(skillDirectory)
  return files.sort()
}

function truncateText(
  value: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (value.length <= limit) {
    return { text: value, truncated: false }
  }
  return {
    text: `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`,
    truncated: true,
  }
}

export async function buildSkillContextBundles(
  selectedSkillIds: string[],
  installedSkills: InstalledSkillRecord[],
): Promise<SkillContextBundle[]> {
  const selectedSkills = installedSkills.filter((skill) =>
    selectedSkillIds.includes(skill.id),
  )

  const bundles: SkillContextBundle[] = []

  for (const skill of selectedSkills) {
    const rawSkill = await fs.readFile(skill.location, 'utf8')
    const parsed = parseSkillFrontmatter(rawSkill)
    if (!parsed) {
      continue
    }

    const sections: string[] = [
      `Skill: ${skill.name}`,
      `Description: ${skill.description}`,
      `Source root: ${skill.rootLabel}`,
      `Location: ${skill.directory}`,
      `SKILL.md:\n${parsed.body || rawSkill}`,
    ]

    const extraFiles = await gatherBundleFiles(skill.directory)
    const listedFiles = extraFiles.slice(0, MAX_FILES_PER_SKILL)

    if (listedFiles.length > 0) {
      sections.push(
        [
          'Bundled resources:',
          ...listedFiles.map((file) => `- ${path.relative(skill.directory, file) || path.basename(file)}`),
        ].join('\n'),
      )
    }

    const limitedBundle = truncateText(sections.join('\n\n'), MAX_SKILL_CHARS)

    bundles.push({
      skill,
      text: limitedBundle.text,
      truncated:
        limitedBundle.truncated
        || extraFiles.length > listedFiles.length,
    })
  }

  return bundles
}

export function resolveInstalledSkill(
  value: string,
  installedSkills: InstalledSkillRecord[],
): InstalledSkillRecord | undefined {
  const normalized = normalizeSkillLookupValue(value)
  if (!normalized) {
    return undefined
  }

  return installedSkills.find((skill) => {
    const candidates = [
      skillActivationId(skill),
      skill.id,
      skill.location,
      skill.slug,
      skill.name,
      skill.directory,
    ]

    return candidates.some(
      (candidate) => candidate.trim().toLowerCase() === normalized,
    )
  })
}

export function renderSkillCatalogInstructions(
  installedSkills: InstalledSkillRecord[],
): string | undefined {
  if (installedSkills.length === 0) {
    return undefined
  }

  return [
    'Available skills are discoverable for this session.',
    'Use progressive discovery: start from this catalog, then activate a skill only when it matches the task or the user explicitly asks for it.',
    'Call activate_skill with the exact activation id from the catalog to load the full instructions into context.',
    'After activation, only load bundled resources if the instructions point to a specific file and the active tool surface supports it.',
    'Only activated or explicitly preloaded skills should influence the answer.',
    ...installedSkills.map((skill) =>
      [
        `===== SKILL CATALOG ENTRY: ${skill.name} =====`,
        `Activation id: ${skillActivationId(skill)}`,
        `Description: ${skill.description}`,
        `Source root: ${skill.rootLabel}`,
        `Location: ${skill.location}`,
      ].join('\n'),
    ),
  ].join('\n\n')
}

export function renderSkillSystemInstructions(
  bundles: SkillContextBundle[],
): string | undefined {
  if (bundles.length === 0) {
    return undefined
  }

  return [
    'The user explicitly preloaded these skills for this session.',
    'Treat them as already activated procedural guidance and constraints.',
    'If multiple skills overlap, combine them sensibly and avoid repeating the same guidance back to the user.',
    ...bundles.map((bundle) =>
      [
        `===== BEGIN SKILL: ${bundle.skill.name} =====`,
        bundle.text,
        bundle.truncated
          ? 'Note: some skill content or bundled resource listings were trimmed to keep the session usable.'
          : '',
        `===== END SKILL: ${bundle.skill.name} =====`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
  ].join('\n\n')
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function compactErrorDetails(value: string): string | undefined {
  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

  if (!normalized) {
    return undefined
  }

  if (normalized.length <= 600) {
    return normalized
  }

  return `${normalized.slice(0, 600)}…`
}

function getSkillsCliStagingRoot(stagingDirectory: string): string {
  return path.join(stagingDirectory, '.agents', 'skills')
}

async function copyInstalledSkillToGemmaDesktopRoot(input: {
  skillName: string
  sourceRoot: string
  targetRoot: string
}): Promise<void> {
  const sourceDirectory = path.join(input.sourceRoot, input.skillName)
  const targetRoot = path.resolve(input.targetRoot)
  const targetDirectory = path.join(targetRoot, input.skillName)

  if (!(await fileExists(sourceDirectory))) {
    throw new Error(
      `Gemma Desktop installed ${input.skillName}, but could not find the staged skill at ${sourceDirectory}.`,
    )
  }

  await fs.mkdir(targetRoot, { recursive: true })
  await removePathIfPresent(targetDirectory)
  await fs.cp(sourceDirectory, targetDirectory, { recursive: true, force: true })
}

function describeSkillsCliAction(args: string[]): string {
  switch (args[0]) {
    case undefined:
      return 'run a skills command'
    case 'find':
      return 'search the skills.sh catalog'
    case 'add':
      return 'install a skill'
    case 'remove':
      return 'remove a skill'
  }

  return 'run a skills command'
}

function isMissingNpx(
  error: Error & { code?: string } | null,
  details: string | undefined,
): boolean {
  if (error?.code === 'ENOENT') {
    return true
  }

  const haystack = `${error?.message ?? ''}\n${details ?? ''}`.toLowerCase()
  return haystack.includes('spawn npx enoent')
    || haystack.includes('npx: command not found')
    || haystack.includes('npx not found')
}

function formatSkillsCliError(
  args: string[],
  error: Error & { code?: string } | null,
  output: string,
): Error {
  const details = compactErrorDetails(output)
  const action = describeSkillsCliAction(args)
  const command = ['npx', 'skills', ...args].map(quoteShellArg).join(' ')

  if (isMissingNpx(error, details)) {
    return new Error(
      [
        `Gemma Desktop could not ${action} because \`npx\` is not available on this machine.`,
        'Skill catalog features depend on the external `skills` CLI being runnable through `npx`.',
        '',
        'Expected setup:',
        SKILLS_CLI_SETUP_STEPS,
        '',
        `Command: ${command}`,
      ].join('\n'),
    )
  }

  return new Error(
    [
      `Gemma Desktop could not ${action} with the external \`skills\` CLI.`,
      'Skill catalog features depend on the external `skills` CLI being runnable through `npx`.',
      '',
      'Expected setup:',
      SKILLS_CLI_SETUP_STEPS,
      '',
      `Command: ${command}`,
      details ? `Details: ${details}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function runSkillsCli(
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'npx',
      ['skills', ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
        },
        maxBuffer: 1024 * 1024 * 8,
      },
      (error, stdout, stderr) => {
        const output = stripAnsi(`${stdout}\n${stderr}`).trim()
        if (error) {
          reject(
            formatSkillsCliError(
              args,
              error as Error & { code?: string },
              output || error.message,
            ),
          )
          return
        }
        resolve(output)
      },
    )
  })
}

export async function searchSkillsCatalog(
  query: string,
): Promise<SkillCatalogEntry[]> {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }

  const output = await runSkillsCli(['find', trimmed])
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const results: SkillCatalogEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) {
      continue
    }
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+?)\s+([0-9.]+[KMB]? installs)$/i.exec(
      line,
    )
    if (!match) {
      continue
    }
    const repo = match[1]
    const skillName = match[2]
    const installsText = match[3]
    if (!repo || !skillName || !installsText) {
      continue
    }

    const urlLine = lines[index + 1]
    const urlMatch = /https:\/\/skills\.sh\/\S+/i.exec(urlLine ?? '')
    results.push({
      id: `${repo}@${skillName}`,
      repo,
      skillName,
      installsText,
      ...(urlMatch?.[0] ? { url: urlMatch[0] } : {}),
    })
  }

  return results
}

export async function installSkillFromCatalog(input: {
  repo: string
  skillName: string
  targetRoot?: string
}): Promise<void> {
  const stagingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gemma-desktop-skills-'),
  )

  try {
    await runSkillsCli(
      [
        'add',
        input.repo,
        '-a',
        SKILLS_CLI_STAGING_TARGET,
        '--skill',
        input.skillName,
        '--copy',
        '-y',
      ],
      { cwd: stagingDirectory },
    )

    if (input.targetRoot) {
      await copyInstalledSkillToGemmaDesktopRoot({
        skillName: input.skillName,
        sourceRoot: getSkillsCliStagingRoot(stagingDirectory),
        targetRoot: input.targetRoot,
      })
    }
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true })
  }
}

export async function removeInstalledSkill(input: {
  skillName: string
  directory?: string
  root?: string
}): Promise<void> {
  if (input.directory && input.root) {
    await ensureSkillDirectoryRemoved({
      skillName: input.skillName,
      directory: input.directory,
      root: input.root,
    })
    return
  }

  throw new Error('Gemma Desktop can only remove skills with a known app-managed directory.')
}

export function defaultSkillRoots(userDataPath: string): string[] {
  return [getGemmaDesktopSkillRoot(userDataPath)]
}

export async function listAvailableSkills(input: {
  scanRoots: string[]
}): Promise<InstalledSkillRecord[]> {
  return await discoverInstalledSkills(input.scanRoots)
}

export function summarizeSkillSelection(
  selectedSkillIds: string[],
  installedSkills: InstalledSkillRecord[],
): string {
  const names = installedSkills
    .filter((skill) => selectedSkillIds.includes(skill.id))
    .map((skill) => skill.name)

  if (names.length === 0) {
    return 'No skills preloaded'
  }

  return names.join(', ')
}

export function parseSkillBodyPreview(text: string): string {
  return normalizeWhitespace(text).slice(0, 240)
}
