import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

import {
  defaultSkillRoots,
  discoverInstalledSkills,
  installSkillFromCatalog,
  removeInstalledSkill,
} from '../../src/main/skills'

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

describe('removeInstalledSkill', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-skill-remove-'))
    execFileMock.mockReset()
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('removes app-managed skill directories', async () => {
    const root = path.join(tempDir, 'skills')
    const directory = path.join(root, 'frontend-design')

    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: frontend-design\ndescription: Test skill\n---\n',
      'utf8',
    )

    await expect(
      removeInstalledSkill({
        skillName: 'frontend-design',
        directory,
        root,
      }),
    ).resolves.toBeUndefined()

    expect(execFileMock).not.toHaveBeenCalled()
    await expect(pathExists(directory)).resolves.toBe(false)
  })

  it('requires a known app-managed skill directory', async () => {
    await expect(
      removeInstalledSkill({
        skillName: 'frontend-design',
      }),
    ).rejects.toThrow('known app-managed directory')
  })

  it('removes the skill directory without touching external agent roots', async () => {
    const root = path.join(tempDir, 'skills')
    const directory = path.join(root, 'frontend-design')

    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: frontend-design\ndescription: Test skill\n---\n',
      'utf8',
    )

    await expect(
      removeInstalledSkill({
        skillName: 'frontend-design',
        directory,
        root,
      }),
    ).resolves.toBeUndefined()

    await expect(pathExists(directory)).resolves.toBe(false)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('refuses to delete directories outside the declared skill root', async () => {
    const root = path.join(tempDir, 'skills')
    const directory = path.join(tempDir, 'outside', 'frontend-design')

    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: frontend-design\ndescription: Test skill\n---\n',
      'utf8',
    )

    await expect(
      removeInstalledSkill({
        skillName: 'frontend-design',
        directory,
        root,
      }),
    ).rejects.toThrow(`outside ${path.resolve(root)}`)

    await expect(pathExists(directory)).resolves.toBe(true)
  })
})

describe('installSkillFromCatalog', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-skill-install-'))
    execFileMock.mockReset()
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('stages catalog installs in a throwaway universal skills root before copying into Gemma Desktop', async () => {
    const targetRoot = path.join(tempDir, 'Gemma Desktop', 'skills')
    let stagingDirectory = ''

    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        options: { cwd?: string },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        stagingDirectory = options.cwd ?? ''
        const stagedSkillDirectory = path.join(
          stagingDirectory,
          '.agents',
          'skills',
          'frontend-design',
        )

        expect(args).toEqual([
          'skills',
          'add',
          'vercel-labs/agent-skills',
          '-a',
          'universal',
          '--skill',
          'frontend-design',
          '--copy',
          '-y',
        ])

        void fs.mkdir(stagedSkillDirectory, { recursive: true })
          .then(() =>
            fs.writeFile(
              path.join(stagedSkillDirectory, 'SKILL.md'),
              '---\nname: Frontend Design\ndescription: Visible skill\n---\nUse this skill.\n',
              'utf8',
            ),
          )
          .then(() => callback(null, 'Installed', ''))
          .catch((error: Error) => callback(error, '', ''))
      },
    )

    await installSkillFromCatalog({
      repo: 'vercel-labs/agent-skills',
      skillName: 'frontend-design',
      targetRoot,
    })

    await expect(pathExists(path.join(targetRoot, 'frontend-design', 'SKILL.md'))).resolves.toBe(true)
    await expect(pathExists(stagingDirectory)).resolves.toBe(false)
  })
})

describe('discoverInstalledSkills', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-skill-discover-'))
    execFileMock.mockReset()
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns regular skills and .system skills through the same catalog', async () => {
    const root = path.join(tempDir, 'skills')
    const visibleDirectory = path.join(root, 'frontend-design')
    const systemDirectory = path.join(root, '.system', 'session-tooling')

    await fs.mkdir(visibleDirectory, { recursive: true })
    await fs.mkdir(systemDirectory, { recursive: true })
    await fs.writeFile(
      path.join(visibleDirectory, 'SKILL.md'),
      '---\nname: Frontend Design\ndescription: Visible skill\n---\nUse this skill.\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(systemDirectory, 'SKILL.md'),
      '---\nname: Session Tooling\ndescription: System skill\n---\nUse this skill.\n',
      'utf8',
    )

    const skills = await discoverInstalledSkills([root])

    expect(skills.map((skill) => skill.slug).sort()).toEqual([
      'frontend-design',
      'session-tooling',
    ])
    expect(
      Object.prototype.hasOwnProperty.call(skills[0] ?? {}, 'builtIn'),
    ).toBe(false)
  })

  it('uses the Gemma Desktop global skills directory as the default scan root', () => {
    expect(defaultSkillRoots('/tmp/Gemma Desktop')).toEqual([
      path.join('/tmp/Gemma Desktop', 'skills'),
    ])
  })

  it('labels the app-owned skills root as Gemma Desktop', async () => {
    const root = path.join(tempDir, 'Gemma Desktop', 'skills')
    const skillDirectory = path.join(root, 'frontend-design')

    await fs.mkdir(skillDirectory, { recursive: true })
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: Frontend Design\ndescription: Visible skill\n---\nUse this skill.\n',
      'utf8',
    )

    const [skill] = await discoverInstalledSkills([root])

    expect(skill?.rootLabel).toBe('Gemma Desktop')
  })
})
