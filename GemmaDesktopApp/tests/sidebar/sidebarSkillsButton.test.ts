import { describe, expect, it } from 'vitest'
import { getSkillsButtonClassName } from '../../src/renderer/src/components/Sidebar'

describe('getSkillsButtonClassName', () => {
  it('uses explicit dark gradient tokens for the unselected button', () => {
    const className = getSkillsButtonClassName(0)

    expect(className).toContain('dark:bg-gradient-to-br')
    expect(className).toContain('dark:from-cyan-950/65')
    expect(className).toContain('dark:to-teal-950/55')
    expect(className).not.toContain('dark:bg-cyan-500/10')
  })

  it('uses explicit dark gradient tokens for the selected button', () => {
    const className = getSkillsButtonClassName(2)

    expect(className).toContain('dark:bg-gradient-to-br')
    expect(className).toContain('dark:from-sky-950/70')
    expect(className).toContain('dark:to-cyan-950/55')
    expect(className).not.toContain('dark:bg-sky-500/15')
  })
})
