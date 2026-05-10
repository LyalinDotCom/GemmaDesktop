export type BuildExecCommandPolicyResult = {
  kind: 'allow' | 'ask' | 'deny'
  normalizedCommand: string
  rootCommand: string
  reason: string
}

const VERIFICATION_PATTERNS = [
  /\b(?:npm|pnpm)\s+run\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\b(?:npm|pnpm)\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\byarn\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\bbun\s+run\s+(?:check|build|test|typecheck|lint|verify)\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bpython(?:3)?\s+-m\s+pytest\b/i,
  /\bpython(?:3)?\s+-m\s+compileall\b/i,
  /\btsc(?:\s|$)/i,
  /\beslint\b/i,
  /\bruff\s+check\b/i,
  /\bmypy\b/i,
  /\bcargo\s+(?:test|check)\b/i,
  /\bgo\s+test\b/i,
] as const

const SAFE_READ_ROOT_COMMANDS = new Set([
  'pwd',
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'tree',
  'find',
  'grep',
  'rg',
  'sed',
  'awk',
  'cut',
  'sort',
  'uniq',
  'which',
  'where',
  'echo',
  'printf',
  'env',
  'printenv',
])

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'grep',
])

const NETWORK_OR_INSTALL_ROOTS = new Set([
  'curl',
  'wget',
  'brew',
  'pip',
  'pip3',
  'poetry',
])

const FILE_MUTATION_ROOTS = new Set([
  'rm',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'ln',
  'install',
  'rsync',
  'tar',
  'unzip',
  'zip',
])

const PROCESS_LAUNCH_PATTERNS = [
  /\b(?:npm|pnpm)\s+run\s+(?:dev|start|serve|watch)\b/i,
  /\byarn\s+(?:dev|start|serve|watch)\b/i,
  /\bbun\s+run\s+(?:dev|start|serve|watch)\b/i,
  /\b(?:vite|next|astro|webpack-dev-server)\b/i,
  /\bpython(?:3)?\s+-m\s+http\.server\b/i,
] as const

const CHAIN_OR_REDIRECTION_PATTERN = /&&|\|\||[|<>;]|\r?\n/
const SHELL_BACKGROUND_OPERATOR_PATTERN = /(?:^|[^&])&(?!&)/
const BACKGROUNDED_STARTUP_PROBE_PATTERN =
  /(?:^|[^&])&(?!&)[\s\S]*\b(?:sleep\s+\d+(?:\.\d+)?|curl|wget|nc|lsof)\b/i

const HARD_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bsudo\b/i,
    reason:
      'Build mode refuses commands that require sudo or broader machine-level privilege escalation.',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason:
      'Build mode refuses destructive git resets like "git reset --hard". Use a safer alternative instead.',
  },
  {
    pattern: /\bgit\s+checkout\s+--\b/i,
    reason:
      'Build mode refuses destructive git checkout reverts like "git checkout --". Use a safer alternative instead.',
  },
  {
    pattern: /\bgit\s+clean\b/i,
    reason:
      'Build mode refuses destructive git clean operations by default.',
  },
  {
    pattern: /\b(?:shutdown|reboot|halt)\b/i,
    reason:
      'Build mode refuses host-level power commands.',
  },
  {
    pattern: /\brm\s+-rf\s+\/(?:\s|$)/i,
    reason:
      'Build mode refuses commands that attempt to delete the filesystem root.',
  },
]

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function tokenizeShellCommand(command: string): string[] {
  return command.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|\S+/g) ?? []
}

function unwrapToken(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
    || (token.startsWith('`') && token.endsWith('`'))
  ) {
    return token.slice(1, -1)
  }

  return token
}

function lowerToken(token: string): string {
  return unwrapToken(token).trim().toLowerCase()
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

type CommandContext = {
  commandIndex: number
  rootCommand: string
  subcommand: string
}

function resolveCommandContext(tokens: string[]): CommandContext {
  let index = 0
  while (index < tokens.length && isEnvAssignmentToken(tokens[index] ?? '')) {
    index += 1
  }

  const current = lowerToken(tokens[index] ?? '')
  if (current === 'env' || current.endsWith('/env')) {
    index += 1
    while (
      index < tokens.length
      && (
        lowerToken(tokens[index] ?? '').startsWith('-')
        || isEnvAssignmentToken(tokens[index] ?? '')
      )
    ) {
      index += 1
    }
  }

  return {
    commandIndex: index,
    rootCommand: lowerToken(tokens[index] ?? ''),
    subcommand: lowerToken(tokens[index + 1] ?? ''),
  }
}

function matchesVerificationCommand(command: string): boolean {
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(command))
}

function matchesProcessLaunch(command: string): boolean {
  return PROCESS_LAUNCH_PATTERNS.some((pattern) => pattern.test(command))
}

function usesShellBackgroundOperator(command: string): boolean {
  return SHELL_BACKGROUND_OPERATOR_PATTERN.test(command)
}

function usesBackgroundedStartupProbe(command: string): boolean {
  return BACKGROUNDED_STARTUP_PROBE_PATTERN.test(command)
}

function isSafeSedCommand(tokens: string[]): boolean {
  return !tokens.some((token) => /^-i(?:$|['"]?$)/i.test(token) || token === '--in-place')
}

function isSafeGitCommand(commandContext: CommandContext): boolean {
  return SAFE_GIT_SUBCOMMANDS.has(commandContext.subcommand)
}

function asksForNetworkOrInstall(tokens: string[], normalizedCommand: string): boolean {
  const commandContext = resolveCommandContext(tokens)
  const { rootCommand, subcommand } = commandContext

  if (rootCommand === 'npm' && ['install', 'i', 'add', 'create', 'update'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'pnpm' && ['install', 'i', 'add', 'dlx', 'create', 'update'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'yarn' && ['install', 'add', 'dlx', 'create', 'up'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'bun' && ['install', 'add', 'x', 'create', 'update'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'git' && ['clone', 'fetch', 'pull', 'push'].includes(subcommand)) {
    return true
  }

  if ((rootCommand === 'pip' || rootCommand === 'pip3' || rootCommand === 'poetry') && subcommand === 'install') {
    return true
  }

  if (rootCommand === 'uv' && ['sync', 'add', 'pip'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'cargo' && ['install', 'add'].includes(subcommand)) {
    return true
  }

  if (rootCommand === 'go' && ['get', 'install'].includes(subcommand)) {
    return true
  }

  return NETWORK_OR_INSTALL_ROOTS.has(rootCommand) || /\bnpx\b/i.test(normalizedCommand)
}

export function evaluateBuildExecCommandPolicy(command: string): BuildExecCommandPolicyResult {
  const normalizedCommand = normalizeCommand(command)
  const tokens = tokenizeShellCommand(normalizedCommand)
  const commandContext = resolveCommandContext(tokens)
  const { rootCommand } = commandContext

  if (normalizedCommand.length === 0) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason: 'Build mode requires approval for empty or malformed shell commands.',
    }
  }

  for (const entry of HARD_DENY_PATTERNS) {
    if (entry.pattern.test(normalizedCommand)) {
      return {
        kind: 'deny',
        normalizedCommand,
        rootCommand,
        reason: entry.reason,
      }
    }
  }

  if (
    matchesProcessLaunch(normalizedCommand) &&
    usesShellBackgroundOperator(normalizedCommand) &&
    usesBackgroundedStartupProbe(normalizedCommand)
  ) {
    return {
      kind: 'deny',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode refuses backgrounded dev-server startup probes in exec_command because "& sleep/curl" style checks can hide startup failures and leave untracked processes behind. Use the background process tools for dev servers or watchers, then inspect the tracked process output.',
    }
  }

  if (matchesProcessLaunch(normalizedCommand) && usesShellBackgroundOperator(normalizedCommand)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for shell-backgrounded process-launch commands. Prefer the background process tools for dev servers or watchers so startup output, failures, and cleanup stay tracked.',
    }
  }

  if (CHAIN_OR_REDIRECTION_PATTERN.test(normalizedCommand)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for shell commands that use chaining, pipes, redirection, or multiline scripts.',
    }
  }

  if (matchesProcessLaunch(normalizedCommand)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for long-running local processes. Prefer the background process tools for dev servers or watchers when possible.',
    }
  }

  if (asksForNetworkOrInstall(tokens, normalizedCommand)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for shell commands that may install dependencies or access the network.',
    }
  }

  if (matchesVerificationCommand(normalizedCommand)) {
    return {
      kind: 'allow',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode allows common verification commands without extra approval.',
    }
  }

  if (rootCommand === 'git' && isSafeGitCommand(commandContext)) {
    return {
      kind: 'allow',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode allows read-only git inspection commands without extra approval.',
    }
  }

  if (rootCommand === 'sed' && !isSafeSedCommand(tokens)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for in-place shell edits. Prefer write_file, write_files, or edit_file for direct file mutations when possible.',
    }
  }

  if (FILE_MUTATION_ROOTS.has(rootCommand)) {
    return {
      kind: 'ask',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode requires approval for shell commands that may mutate files or project state outside the direct file tools.',
    }
  }

  if (SAFE_READ_ROOT_COMMANDS.has(rootCommand)) {
    return {
      kind: 'allow',
      normalizedCommand,
      rootCommand,
      reason:
        'Build mode allows common read-only shell inspection commands without extra approval.',
    }
  }

  return {
    kind: 'ask',
    normalizedCommand,
    rootCommand,
    reason:
      'Build mode requires approval for shell commands that are outside the safe read-only and verification allowlist.',
  }
}
