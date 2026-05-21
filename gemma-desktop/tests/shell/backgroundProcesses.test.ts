import { describe, expect, it } from 'vitest'
import { extractBackgroundProcessPreviewUrl } from '../../src/shared/backgroundProcesses'

describe('background process preview URLs', () => {
  it('extracts local dev server URLs from process output', () => {
    expect(extractBackgroundProcessPreviewUrl(
      'VITE ready\nLocal: http://localhost:5173/\n',
    )).toBe('http://localhost:5173/')
  })

  it('normalizes local addresses without a protocol', () => {
    expect(extractBackgroundProcessPreviewUrl(
      'server running at localhost:3000',
    )).toBe('http://localhost:3000/')
  })

  it('strips copied punctuation and terminal color escapes', () => {
    expect(extractBackgroundProcessPreviewUrl(
      '\u001B[32mLocal:\u001B[0m (http://127.0.0.1:4173/app).',
    )).toBe('http://127.0.0.1:4173/app')
  })

  it('ignores unrelated remote URLs', () => {
    expect(extractBackgroundProcessPreviewUrl(
      'docs at https://example.com, server still starting',
    )).toBeNull()
  })
})
