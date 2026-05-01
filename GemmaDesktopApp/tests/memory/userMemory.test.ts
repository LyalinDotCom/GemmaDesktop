import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendUserMemoryNote,
  buildMemoryDistillerUserPrompt,
  buildUserMemorySystemSection,
  getUserMemoryFilePath,
  postProcessDistilledNote,
  readUserMemory,
  sanitizeMemoryNote,
  USER_MEMORY_FILE_NAME,
  USER_MEMORY_MAX_NOTE_CHARS,
  writeUserMemory,
} from '../../src/main/userMemory'

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-memory-'))
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('getUserMemoryFilePath', () => {
  it('resolves to memory.md inside the userData directory', () => {
    const resolved = getUserMemoryFilePath(tempDir)
    expect(resolved).toBe(path.join(path.resolve(tempDir), USER_MEMORY_FILE_NAME))
  })
})

describe('readUserMemory', () => {
  it('returns an empty string when the memory file does not exist', async () => {
    const result = await readUserMemory(tempDir)
    expect(result).toBe('')
  })

  it('returns file contents normalized to LF line endings', async () => {
    await fs.writeFile(
      getUserMemoryFilePath(tempDir),
      'line one\r\nline two\r\n',
      'utf8',
    )
    const result = await readUserMemory(tempDir)
    expect(result).toBe('line one\nline two\n')
  })
})

describe('writeUserMemory', () => {
  it('writes an empty string when given only whitespace', async () => {
    await writeUserMemory(tempDir, '   \n\t\n  ')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8')
    expect(raw).toBe('')
  })

  it('trims the document and ensures a trailing newline', async () => {
    await writeUserMemory(tempDir, '  a line  \n   \n another line  \n\n')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8')
    expect(raw).toBe('a line\n\n another line\n')
  })

  it('removes trailing whitespace on each line', async () => {
    await writeUserMemory(tempDir, 'first line   \nsecond   ')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8')
    expect(raw).toBe('first line\nsecond\n')
  })
})

describe('appendUserMemoryNote', () => {
  it('creates the file with a bullet when memory was previously empty', async () => {
    const result = await appendUserMemoryNote(tempDir, 'Users name is Dmitry Lyalin')
    expect(result.appendedNote).toBe('Users name is Dmitry Lyalin')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8')
    expect(raw).toBe('- Users name is Dmitry Lyalin\n')
  })

  it('appends a new bullet on its own line when memory already has content', async () => {
    await writeUserMemory(tempDir, '- Prefers dark mode')
    await appendUserMemoryNote(tempDir, 'Timezone is Pacific')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8')
    expect(raw).toBe('- Prefers dark mode\n- Timezone is Pacific\n')
  })

  it('returns an empty appended note when the input sanitizes to nothing', async () => {
    const result = await appendUserMemoryNote(tempDir, '   \n  ')
    expect(result.appendedNote).toBe('')
    const raw = await fs.readFile(getUserMemoryFilePath(tempDir), 'utf8').catch(() => null)
    expect(raw).toBeNull()
  })
})

describe('sanitizeMemoryNote', () => {
  it('collapses internal whitespace', () => {
    expect(sanitizeMemoryNote('  Users  name   is\n\tDmitry  ')).toBe('Users name is Dmitry')
  })

  it('truncates notes longer than the max character budget with an ellipsis', () => {
    const long = 'a'.repeat(USER_MEMORY_MAX_NOTE_CHARS + 10)
    const result = sanitizeMemoryNote(long)
    expect(result.length).toBe(USER_MEMORY_MAX_NOTE_CHARS + 1)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('buildUserMemorySystemSection', () => {
  it('returns undefined when memory is empty', () => {
    expect(buildUserMemorySystemSection('')).toBeUndefined()
    expect(buildUserMemorySystemSection('   \n\n ')).toBeUndefined()
  })

  it('produces a heading plus the trimmed body when memory has content', () => {
    const section = buildUserMemorySystemSection('- fact one\n- fact two\n')
    expect(section).toBeDefined()
    expect(section).toContain('<user_memory_context>')
    expect(section).toContain('title: User Memory')
    expect(section).toContain('authoritative passive context')
    expect(section).toContain('<memory>')
    expect(section).toContain('- fact one')
    expect(section).toContain('- fact two')
    expect(section).toContain('</memory>')
    expect(section).toContain('</user_memory_context>')
  })
})

describe('postProcessDistilledNote', () => {
  it('takes the first non-empty line and strips wrapping quotes', () => {
    expect(postProcessDistilledNote('"Users name is Dmitry Lyalin"\nExtra reasoning.')).toBe(
      'Users name is Dmitry Lyalin',
    )
  })

  it('returns empty string when the model produced nothing meaningful', () => {
    expect(postProcessDistilledNote('   \n\n   ')).toBe('')
  })
})

describe('buildMemoryDistillerUserPrompt', () => {
  it('includes the raw user input verbatim inside the delimited block', () => {
    const prompt = buildMemoryDistillerUserPrompt('  i want to add my name "Dmitry Lyalin"  ')
    expect(prompt).toContain('i want to add my name "Dmitry Lyalin"')
    expect(prompt).toContain('Return only the distilled memory note.')
  })
})
