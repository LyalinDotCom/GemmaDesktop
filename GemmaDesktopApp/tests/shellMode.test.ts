import { describe, expect, it } from 'vitest'
import {
  parseShellDraft,
  resolveComposerSubmitIntent,
} from '../src/renderer/src/lib/shellMode'

describe('shell mode composer helpers', () => {
  it('detects shell mode from a leading bang after whitespace', () => {
    expect(parseShellDraft('   !ls -la')).toEqual({
      isShellMode: true,
      visibleText: '!ls -la',
      command: 'ls -la',
    })
  })

  it('routes submit intent to shell even while plan mode is enabled', () => {
    expect(resolveComposerSubmitIntent({
      text: '!npm test',
      researchMode: false,
      planMode: true,
    })).toBe('shell')
  })

  it('keeps non-shell drafts on the normal chat path', () => {
    expect(resolveComposerSubmitIntent({
      text: 'ship the fix',
      researchMode: false,
      planMode: false,
    })).toBe('chat')
  })
})
