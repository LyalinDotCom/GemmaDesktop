import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from '../src/renderer/src/components/MarkdownContent'

const {
  accessMock,
  openExternalMock,
  openPathMock,
} = vi.hoisted(() => ({
  accessMock: vi.fn(),
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  __esModule: true,
  default: {
    access: accessMock,
  },
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
  },
}))

import {
  openLinkTarget,
  shouldOpenNavigationExternally,
} from '../src/main/links'

describe('external link handling', () => {
  beforeEach(() => {
    accessMock.mockReset()
    openExternalMock.mockReset()
    openPathMock.mockReset()

    accessMock.mockResolvedValue(undefined)
    openExternalMock.mockResolvedValue(undefined)
    openPathMock.mockResolvedValue('')
  })

  it('opens absolute filesystem paths with the system shell', async () => {
    await expect(openLinkTarget('/tmp/gemma-desktop/link-test.md')).resolves.toBe(true)

    expect(accessMock).toHaveBeenCalledWith(path.resolve('/tmp/gemma-desktop/link-test.md'))
    expect(openPathMock).toHaveBeenCalledWith(path.resolve('/tmp/gemma-desktop/link-test.md'))
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('opens safe external URLs with the system browser', async () => {
    await expect(openLinkTarget('https://gemma-desktop.dev/docs')).resolves.toBe(true)

    expect(openExternalMock).toHaveBeenCalledWith('https://gemma-desktop.dev/docs')
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('rejects unsafe or unsupported targets', async () => {
    await expect(openLinkTarget('javascript:alert(1)')).resolves.toBe(false)
    await expect(openLinkTarget('#details')).resolves.toBe(false)

    expect(openExternalMock).not.toHaveBeenCalled()
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('does not treat same-origin app navigations as external links', () => {
    expect(
      shouldOpenNavigationExternally(
        'http://localhost:5173/session/123',
        'http://localhost:5173/',
      ),
    ).toBe(false)

    expect(
      shouldOpenNavigationExternally(
        'https://gemma-desktop.dev/docs',
        'http://localhost:5173/',
      ),
    ).toBe(true)

    expect(
      shouldOpenNavigationExternally(
        'file:///Users/dmitry/readme.md',
        'file:///Applications/Gemma Desktop.app/index.html',
      ),
    ).toBe(true)
  })

  it('renders markdown anchors as external links', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        text: '[Docs](https://gemma-desktop.dev/docs)',
      }),
    )

    expect(html).toContain('href="https://gemma-desktop.dev/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('renders markdown bullet lists as semantic list markup', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        text: '* first item\n* second item',
      }),
    )

    expect(html).toContain('<ul>')
    expect(html).toContain('<li>first item</li>')
    expect(html).toContain('<li>second item</li>')
  })

  it('renders valid markdown tables as semantic table markup', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        text: [
          '| Outlet | Lens |',
          '| :--- | :--- |',
          '| MSNBC | Global |',
        ].join('\n'),
      }),
    )

    expect(html).toContain('<table')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th style="text-align:left">Outlet</th>')
    expect(html).toContain('<td style="text-align:left">MSNBC</td>')
  })

  it('repairs malformed table separator rows often produced by models', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        text: [
          '### **Differences in Perspective**',
          '| Outlet | Primary Focus & Framing |',
          '| :--- | :--- **Focus & Framing** |',
          '| **MSNBC** | **Global & Diplomatic:** Emphasizes international relations. |',
        ].join('\n'),
      }),
    )

    expect(html).toContain('<table')
    expect(html).toContain('<th style="text-align:left">Outlet</th>')
    expect(html).toContain(
      '<th style="text-align:left">Primary Focus &amp; Framing</th>',
    )
    expect(html).toContain(
      '<td style="text-align:left"><strong>MSNBC</strong></td>',
    )
    expect(html).toContain('Global &amp; Diplomatic:')
  })

  it('rewrites local markdown image paths through the gemma-desktop-file scheme', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        text: '![Screenshot](/tmp/gemma-desktop-inline-image.png)',
      }),
    )

    expect(html).toContain('src="gemma-desktop-file:///tmp/gemma-desktop-inline-image.png"')
    expect(html).toContain('alt="Screenshot"')
    expect(html).toContain('loading="lazy"')
  })
})
