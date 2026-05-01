import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { extractFileEditBlocksFromToolResult } from '../../src/main/fileEdits'
import { Message } from '../../src/renderer/src/components/Message'
import type { ChatMessage } from '../../src/renderer/src/types'

describe('file edit extraction', () => {
  it('normalizes direct tool edit artifacts to workspace-relative chat blocks', () => {
    const blocks = extractFileEditBlocksFromToolResult({
      toolName: 'edit_file',
      workingDirectory: '/tmp/project',
      structuredOutput: {
        edit: {
          path: '/tmp/project/src/runtime.ts',
          changeType: 'edited',
          addedLines: 7,
          removedLines: 1,
          diff: 'diff --git a/src/runtime.ts b/src/runtime.ts',
        },
      },
    })

    expect(blocks).toEqual([
      {
        type: 'file_edit',
        path: 'src/runtime.ts',
        changeType: 'edited',
        addedLines: 7,
        removedLines: 1,
        diff: 'diff --git a/src/runtime.ts b/src/runtime.ts',
      },
    ])
  })

  it('extracts delegated workspace editor results in write order', () => {
    const blocks = extractFileEditBlocksFromToolResult({
      toolName: 'workspace_editor_agent',
      workingDirectory: '/tmp/project',
      structuredOutput: {
        appliedWrites: [
          {
            path: 'src/runtime.ts',
            edit: {
              path: 'src/runtime.ts',
              changeType: 'edited',
              addedLines: 7,
              removedLines: 1,
              diff: 'runtime diff',
            },
          },
          {
            path: 'src/systemPrompts.ts',
            edit: {
              path: 'src/systemPrompts.ts',
              changeType: 'created',
              addedLines: 4,
              removedLines: 0,
              diff: 'prompt diff',
            },
          },
        ],
      },
    })

    expect(blocks.map((block) => block.path)).toEqual([
      'src/runtime.ts',
      'src/systemPrompts.ts',
    ])
    expect(blocks[1]?.changeType).toBe('created')
  })
})

describe('file edit message rendering', () => {
  it('renders a compact collapsed edit row inside assistant messages', () => {
    const message: ChatMessage = {
      id: 'assistant-file-edit-1',
      role: 'assistant',
      content: [
        {
          type: 'file_edit',
          path: 'src/runtime.ts',
          changeType: 'edited',
          addedLines: 7,
          removedLines: 1,
          diff: 'diff --git a/src/runtime.ts b/src/runtime.ts\n@@ -1,1 +1,2 @@\n-old\n+new',
        },
      ],
      timestamp: 1_700_000_000_000,
    }

    const html = renderToStaticMarkup(
      createElement(Message, { message }),
    )

    expect(html).toContain('data-file-edit-state="collapsed"')
    expect(html).toContain('Edited')
    expect(html).toContain('src/runtime.ts')
    expect(html).toContain('+7')
    expect(html).toContain('-1')
    expect(html).not.toContain('Copy diff')
  })
})
