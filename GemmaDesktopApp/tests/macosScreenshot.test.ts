import { describe, expect, it } from 'vitest'
import { buildMacOSScreencaptureArgs } from '../src/main/macosScreenshot'

describe('buildMacOSScreencaptureArgs', () => {
  it('builds the non-interactive full screen command', () => {
    expect(
      buildMacOSScreencaptureArgs(
        { target: 'full_screen' },
        '/tmp/screen.png',
      ),
    ).toEqual(['-x', '-m', '/tmp/screen.png'])
  })

  it('builds the interactive window command and omits the shadow when requested', () => {
    expect(
      buildMacOSScreencaptureArgs(
        {
          target: 'window',
          includeWindowShadow: false,
        },
        '/tmp/window.png',
      ),
    ).toEqual(['-x', '-i', '-w', '-W', '-o', '/tmp/window.png'])
  })
})
