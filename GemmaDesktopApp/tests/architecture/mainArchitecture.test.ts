import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ipcSourcePath = path.resolve(process.cwd(), 'src/main/ipc.ts')
const appToolsSourcePath = path.resolve(process.cwd(), 'src/main/appTools.ts')
const modelMappingSourcePath = path.resolve(process.cwd(), 'src/main/modelMapping.ts')
const sessionConfigSourcePath = path.resolve(process.cwd(), 'src/main/sessionConfig.ts')
const sessionStoreSourcePath = path.resolve(process.cwd(), 'src/main/sessionStore.ts')
const smartContentSourcePath = path.resolve(process.cwd(), 'src/main/smartContent.ts')
const streamingMessagesSourcePath = path.resolve(process.cwd(), 'src/main/streamingMessages.ts')

const EXPECTED_IPC_CHANNELS = [
  'sidebar:get',
  'sidebar:pin-session',
  'sidebar:unpin-session',
  'sidebar:flag-followup',
  'sidebar:unflag-followup',
  'sidebar:remember-active-session',
  'sidebar:move-pinned-session',
  'sidebar:set-session-order',
  'sidebar:clear-session-order',
  'sidebar:set-project-order',
  'sidebar:clear-project-order',
  'sidebar:close-project',
  'sidebar:reopen-project',
  'global-chat:get-state',
  'global-chat:get-session',
  'global-chat:assign-session',
  'global-chat:clear-assignment',
  'sessions:list',
  'sessions:search',
  'talk:ensure-session',
  'talk:list-sessions',
  'talk:start-session',
  'talk:switch-session',
  'talk:clear-session',
  'sessions:create',
  'sessions:get',
  'sessions:save-draft',
  'sessions:update',
  'sessions:delete',
  'sessions:rename',
  'sessions:send-message',
  'sessions:send-hidden-instruction',
  'sessions:run-shell-command',
  'sessions:write-shell-input',
  'sessions:resize-shell',
  'sessions:close-shell',
  'sessions:run-research',
  'sessions:compact',
  'sessions:clear-history',
  'sessions:cancel',
  'sessions:resolve-tool-approval',
  'memory:read',
  'memory:write',
  'memory:append-note',
  'skills:list-installed',
  'skills:search-catalog',
  'skills:install',
  'skills:remove',
  'plan:answer-question',
  'plan:dismiss-exit',
  'plan:exit',
  'automations:list',
  'automations:get',
  'automations:create',
  'automations:update',
  'automations:delete',
  'automations:run-now',
  'automations:cancel-run',
  'debug:get-session-logs',
  'debug:get-session-config',
  'debug:clear-session-logs',
  'environment:inspect',
  'environment:models',
  'environment:runtimes',
  'environment:load-default-models',
  'environment:reload-models',
  'environment:bootstrap-state',
  'environment:retry-bootstrap',
  'environment:ensure-gemma-model',
  'doctor:inspect',
  'doctor:open-privacy-settings',
  'system:stats',
  'system:open-emoji-panel',
  'system:model-token-usage',
  'browser:get-state',
  'browser:navigate',
  'browser:reload',
  'browser:stop-loading',
  'browser:go-back',
  'browser:go-forward',
  'browser:take-control',
  'browser:release-control',
  'browser:set-panel-bounds',
  'browser:close',
  'folders:pick-directory',
  'folders:open-path',
  'links:open-target',
  'attachments:plan-pdf-processing',
  'attachments:discard-pending',
  'files:save-text',
  'workspace:inspect',
  'workspace:start-watch',
  'workspace:stop-watch',
  'terminals:list-installed',
  'terminalDrawer:get-state',
  'terminalDrawer:start',
  'terminalDrawer:write-input',
  'terminalDrawer:resize',
  'terminalDrawer:terminate',
  'terminals:open-directory',
  'media:request-camera-access',
  'media:request-microphone-access',
  'speech:inspect',
  'speech:install',
  'speech:repair',
  'speech:remove',
  'speech:start-session',
  'speech:send-chunk',
  'speech:stop-session',
  'speech:finish-session',
  'read-aloud:inspect',
  'read-aloud:list-voices',
  'read-aloud:cancel-current',
  'assistant-narration:generate',
  'thinking-summary:generate',
  'read-aloud:synthesize',
  'read-aloud:test',
  'notifications:update-attention-context',
  'notifications:get-permission-state',
  'notifications:dismiss-permission-prompt',
  'notifications:send-test',
  'settings:get',
  'settings:update',
]

function readSource(path: string): string {
  return readFileSync(path, 'utf8')
}

function listIpcChannels(source: string): string[] {
  return [...source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)]
    .flatMap((match) => match[1] ? [match[1]] : [])
}

describe('main process architecture', () => {
  it('keeps the IPC channel surface explicit while handlers are decomposed', () => {
    expect(listIpcChannels(readSource(ipcSourcePath))).toEqual(EXPECTED_IPC_CHANNELS)
  })

  it('keeps smart content and PDF extraction out of the IPC composition layer', () => {
    const ipcSource = readSource(ipcSourcePath)
    const smartContentSource = readSource(smartContentSourcePath)

    expect(ipcSource).toContain('createSmartContentService')
    expect(smartContentSource).toContain('extractPdfText')
    expect(smartContentSource).toContain('renderPdfPages')

    expect(ipcSource).not.toContain('extractPdfText')
    expect(ipcSource).not.toContain('renderPdfPages')
    expect(ipcSource).not.toContain('createWorkspaceSearchBackend')
    expect(ipcSource).not.toContain('PDF_RENDER_SCALE')
    expect(ipcSource).not.toMatch(/function\s+(resolveInspectableFile|materializeInspectableContent|extractPdfToCachedText|derivePdfArtifact)\b/)
  })

  it('keeps extracted app-main domains behind named modules instead of rebuilding them in ipc.ts', () => {
    const ipcSource = readSource(ipcSourcePath)

    expect(readSource(appToolsSourcePath)).toContain('createAppTools')
    expect(readSource(sessionStoreSourcePath)).toContain('class SessionStore')
    expect(readSource(modelMappingSourcePath)).toContain('createConfiguredRuntimeAdapters')
    expect(readSource(sessionConfigSourcePath)).toContain('APP_SESSION_METADATA_KEY')
    expect(readSource(streamingMessagesSourcePath)).toContain('StreamingContentBlock')

    expect(ipcSource).not.toMatch(/function\s+(sanitizeVersion|mapRuntimes|deriveOptimizationTags|createConfiguredRuntimeAdapters)\b/)
    expect(ipcSource).not.toMatch(/type\s+Streaming(Text|Thinking|FileEdit|Warning)Block\b/)
    expect(ipcSource).not.toMatch(/interface\s+AppSessionConfig\b/)
    expect(ipcSource).not.toContain("APP_SESSION_METADATA_KEY = 'gemmaDesktopApp'")
  })
})
