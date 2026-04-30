import { describe, expect, it } from 'vitest'
import { evaluateBuildExecCommandPolicy } from '../src/main/buildCommandPolicy'

describe('build exec command policy', () => {
  it('allows common read-only inspection commands', () => {
    expect(evaluateBuildExecCommandPolicy('rg "build mode" GemmaDesktopApp/src')).toMatchObject({
      kind: 'allow',
      rootCommand: 'rg',
    })

    expect(evaluateBuildExecCommandPolicy('git status --short')).toMatchObject({
      kind: 'allow',
      rootCommand: 'git',
    })

    expect(evaluateBuildExecCommandPolicy("sed -n '1,40p' package.json")).toMatchObject({
      kind: 'allow',
      rootCommand: 'sed',
    })

    expect(evaluateBuildExecCommandPolicy('env GIT_PAGER=cat git status --short')).toMatchObject({
      kind: 'allow',
      rootCommand: 'git',
    })
  })

  it('allows common verification commands', () => {
    expect(evaluateBuildExecCommandPolicy('npm run test')).toMatchObject({
      kind: 'allow',
      rootCommand: 'npm',
    })

    expect(evaluateBuildExecCommandPolicy('npm test')).toMatchObject({
      kind: 'allow',
      rootCommand: 'npm',
    })

    expect(evaluateBuildExecCommandPolicy('cargo check')).toMatchObject({
      kind: 'allow',
      rootCommand: 'cargo',
    })

    expect(evaluateBuildExecCommandPolicy('python -m pytest')).toMatchObject({
      kind: 'allow',
      rootCommand: 'python',
    })
  })

  it('requires approval for dependency installs and network access', () => {
    expect(evaluateBuildExecCommandPolicy('npm install')).toMatchObject({
      kind: 'ask',
      rootCommand: 'npm',
    })

    const envInstallPolicy = evaluateBuildExecCommandPolicy('env NODE_ENV=production npm install')
    expect(envInstallPolicy).toMatchObject({
      kind: 'ask',
      rootCommand: 'npm',
    })
    expect(envInstallPolicy.reason).toContain('install dependencies or access the network')

    expect(evaluateBuildExecCommandPolicy('curl https://example.com')).toMatchObject({
      kind: 'ask',
      rootCommand: 'curl',
    })
  })

  it('requires approval for long-running or shell-heavy commands', () => {
    expect(evaluateBuildExecCommandPolicy('npm run dev')).toMatchObject({
      kind: 'ask',
      rootCommand: 'npm',
    })

    expect(evaluateBuildExecCommandPolicy('rg todo src | head')).toMatchObject({
      kind: 'ask',
      rootCommand: 'rg',
    })
  })

  it('denies backgrounded process-launch startup probes that can hide startup failures', () => {
    const policy = evaluateBuildExecCommandPolicy('cd .tmp/sim10/ && npm run dev & sleep 5 && curl -I http://localhost:5173')

    expect(policy).toMatchObject({
      kind: 'deny',
      rootCommand: 'cd',
    })
    expect(policy.reason).toContain('"& sleep/curl" style checks can hide startup failures')
  })

  it('requires approval for plain shell-backgrounded process-launch commands', () => {
    const policy = evaluateBuildExecCommandPolicy('cd .tmp/sim10/ && npm run dev &')

    expect(policy).toMatchObject({
      kind: 'ask',
      rootCommand: 'cd',
    })
    expect(policy.reason).toContain('shell-backgrounded process-launch commands')
  })

  it('requires approval for direct file mutation commands', () => {
    expect(evaluateBuildExecCommandPolicy('mkdir -p src/components')).toMatchObject({
      kind: 'ask',
      rootCommand: 'mkdir',
    })

    expect(evaluateBuildExecCommandPolicy("sed -i '' 's/foo/bar/' src/index.ts")).toMatchObject({
      kind: 'ask',
      rootCommand: 'sed',
    })
  })

  it('denies obviously destructive commands', () => {
    expect(evaluateBuildExecCommandPolicy('git reset --hard HEAD')).toMatchObject({
      kind: 'deny',
      rootCommand: 'git',
    })

    expect(evaluateBuildExecCommandPolicy('sudo rm -rf /')).toMatchObject({
      kind: 'deny',
      rootCommand: 'sudo',
    })
  })
})
