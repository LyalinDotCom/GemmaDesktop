import { spawn } from 'node:child_process';
import type { Tool } from '@gemma-sdk/agent';

export interface ShellInput {
  command: string;
  interactive: boolean;
  repeat: boolean;
}

export function parseShellInput(line: string, previousCommand?: string): ShellInput {
  const trimmed = line.trim();
  if (trimmed === '!!') {
    if (!previousCommand) {
      throw new Error('No previous shell command to repeat.');
    }
    return { command: previousCommand, interactive: true, repeat: true };
  }

  if (!trimmed.startsWith('!')) {
    throw new Error('Shell command must start with !.');
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    throw new Error('Usage: ! <command>, ! -i <command>, or !!');
  }

  if (body.startsWith('-i ')) {
    const command = body.slice(3).trim();
    if (!command) {
      throw new Error('Usage: ! -i <command>');
    }
    return { command, interactive: true, repeat: false };
  }

  return { command: body, interactive: false, repeat: false };
}

export async function runShellTool(tools: Tool[], command: string, signal?: AbortSignal) {
  const shellTool = tools.find((tool) => tool.name === 'exec_command');
  if (!shellTool) {
    return { ok: false, output: 'exec_command tool is unavailable.' };
  }
  return shellTool.run({ command, signal });
}

export async function runInteractiveShell(command: string, cwd: string, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<number> {
  const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  const previousRawMode = input.isRaw;

  input.setRawMode?.(false);
  input.resume();
  output.write('\x1b[?25h\x1b[2J\x1b[H');
  output.write(`$ ${command}\n`);

  return await new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      shell: false,
      stdio: 'inherit'
    });
    child.on('error', (error) => {
      output.write(`\nfailed to start shell command: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => {
      input.setRawMode?.(previousRawMode ?? false);
      resolve(code ?? 0);
    });
  });
}
