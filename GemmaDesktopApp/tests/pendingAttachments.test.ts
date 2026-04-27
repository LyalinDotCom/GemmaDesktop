import { describe, expect, it } from 'vitest'
import { isManagedPendingAttachmentPath } from '../src/main/pendingAttachments'

describe('managed pending attachment paths', () => {
  it('accepts paths inside the session asset directory', () => {
    expect(
      isManagedPendingAttachmentPath(
        '/tmp/project/.gemma/session-state/session_123/assets',
        '/tmp/project/.gemma/session-state/session_123/assets/screenshots/capture.png',
      ),
    ).toBe(true)
  })

  it('rejects paths outside the session asset directory', () => {
    expect(
      isManagedPendingAttachmentPath(
        '/tmp/project/.gemma/session-state/session_123/assets',
        '/tmp/project/source/capture.png',
      ),
    ).toBe(false)
  })
})
