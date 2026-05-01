import { afterAll, describe, expect, it } from 'vitest'
import { BrowserSessionManager } from '../../src/main/agentBrowser'

const runLiveBrowser = process.env.GEMMA_DESKTOP_RUN_BROWSER_TOOL_LIVE === '1'
const describeLive = runLiveBrowser ? describe : describe.skip

describeLive('agent browser live validation', () => {
  const sessionId = `browser-tool-live-${Date.now()}`
  const manager = new BrowserSessionManager({
    onStatus: () => undefined,
  })

  afterAll(async () => {
    await manager.disconnectSession(sessionId).catch(() => undefined)
  })

  it('reads a deterministic page through snapshot and evaluate', async () => {
    const pageHtml = [
      '<!doctype html>',
      '<html lang="en">',
      '<head><title>Browser Tool Fixture</title></head>',
      '<body>',
      '<main>',
      '<article>',
      '<h1>Offline Browser Tool Fixture</h1>',
      '<p>Static story body for browser tool regression coverage.</p>',
      '</article>',
      '</main>',
      '</body>',
      '</html>',
    ].join('')
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`

    await manager.callTool(sessionId, 'browser', {
      action: 'open',
      url,
    })

    const snapshot = await manager.callTool(sessionId, 'browser', {
      action: 'snapshot',
      maxChars: 8_000,
    })
    expect(snapshot.output).toContain('Offline Browser Tool Fixture')
    expect(snapshot.output).toContain('Static story body')

    const evaluated = await manager.callTool(sessionId, 'browser', {
      action: 'evaluate',
      function: '() => document.querySelector("h1")?.textContent?.trim()',
    })
    expect(evaluated.output).toContain('Offline Browser Tool Fixture')
  }, 90_000)
})
