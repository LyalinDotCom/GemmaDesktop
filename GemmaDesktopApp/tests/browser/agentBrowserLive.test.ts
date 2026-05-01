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

  it('reads a deterministic news page through snapshot, evaluate, and scan screenshots', async () => {
    const pageHtml = [
      '<!doctype html>',
      '<html lang="en">',
      '<head><title>Browser Tool Fixture</title></head>',
      '<style>',
      'body{margin:0;font-family:Arial,sans-serif;}',
      '.story{min-height:820px;display:flex;align-items:center;padding:40px;border-bottom:1px solid #ddd;}',
      'a{font-size:32px;line-height:1.2;color:#111;}',
      '</style>',
      '<body>',
      '<main>',
      '<article class="story">',
      '<h1>Offline Browser Tool Fixture</h1>',
      '<a href="https://www.cnn.com/2026/05/01/world/browser-fixture-story-one">CNN Fixture Story One: Opening headline visible in the first viewport</a>',
      '</article>',
      '<article class="story">',
      '<a href="https://www.cnn.com/2026/05/01/world/browser-fixture-story-two">CNN Fixture Story Two: Follow-up headline after one scroll</a>',
      '</article>',
      '<article class="story">',
      '<a href="https://www.cnn.com/2026/05/01/world/browser-fixture-story-three">CNN Fixture Story Three: Deeper headline after two scrolls</a>',
      '</article>',
      '<article class="story">',
      '<a href="https://www.cnn.com/2026/05/01/world/browser-fixture-story-four">CNN Fixture Story Four: Lower-page headline after three scrolls</a>',
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
    expect(snapshot.output).toContain('CNN Fixture Story One')

    const evaluated = await manager.callTool(sessionId, 'browser', {
      action: 'evaluate',
      function: '() => document.querySelector("h1")?.textContent?.trim()',
    })
    expect(evaluated.output).toContain('Offline Browser Tool Fixture')

    const scan = await manager.callTool(sessionId, 'browser', {
      action: 'scan_page',
      scrolls: 3,
      waitMs: 100,
      maxChars: 12_000,
    })
    const scanData = scan.structuredOutput ?? {}
    expect(scan.output).toContain('CNN Fixture Story One')
    expect(scan.output).toContain('CNN Fixture Story Four')
    expect(Number(scanData.screenshotCount)).toBeGreaterThanOrEqual(4)
    expect(Number(scanData.firstViewportStoryCount)).toBeLessThan(
      Number(scanData.uniqueStoryCount),
    )
  }, 90_000)
})
