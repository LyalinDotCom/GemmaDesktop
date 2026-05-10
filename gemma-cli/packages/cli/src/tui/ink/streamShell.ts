import { addHistory, flash, type TuiSession } from '../../tui.js';
import { parseShellInput, runInteractiveShell, runShellTool } from '../../shell.js';

export interface ShellHandlers {
  setBusy: (value: boolean) => void;
  setRunningLabel: (value: string | undefined) => void;
  setActivityLabel: (value: string | undefined) => void;
  forceRedraw: () => void;
}

export async function runShellFromInk(
  session: TuiSession,
  line: string,
  inputStream: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
  abortController: AbortController,
  handlers: ShellHandlers
): Promise<void> {
  try {
    const shell = parseShellInput(line, session.lastShellCommand);
    session.lastShellCommand = shell.command;
    handlers.setBusy(true);
    handlers.setRunningLabel(shell.interactive ? `interactive: ${shell.command}` : `shell: ${shell.command}`);
    handlers.setActivityLabel(shell.interactive ? `interactive ${shell.command}` : `shell ${shell.command}`);
    flash(session, shell.interactive ? 'interactive shell starting…' : 'running shell command…');
    handlers.forceRedraw();

    if (shell.interactive) {
      const code = await runInteractiveShell(shell.command, session.runtime.cwd, inputStream, output);
      addHistory(session, code === 0 ? 'command' : 'error', `$ ${shell.command}\ninteractive shell exited with ${code}`);
      flash(session, code === 0 ? 'interactive shell complete' : 'interactive shell failed');
      return;
    }

    const result = await runShellTool(session.runtime.tools, shell.command, abortController.signal);
    addHistory(session, result.ok ? 'command' : 'error', `${result.ok ? '$' : 'failed'} ${shell.command}\n${result.output}`);
    flash(session, result.ok ? 'shell command completed' : 'shell command needs attention');
  } catch (error) {
    if (abortController.signal.aborted) {
      addHistory(session, 'error', `cancelled shell command: ${line}`);
      flash(session, 'shell command cancelled');
    } else {
      addHistory(session, 'error', error instanceof Error ? error.message : String(error));
      flash(session, 'shell command failed');
    }
  } finally {
    handlers.setRunningLabel(undefined);
    handlers.setActivityLabel(undefined);
    handlers.setBusy(false);
    handlers.forceRedraw();
  }
}
