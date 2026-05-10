import {
  addHistory,
  appendInterruptedRunToRuntimeHistory,
  appendRunToRuntimeHistory,
  appendRunTurnsToHistory,
  createToolProgressState,
  flash,
  formatUserPromptForHistory,
  recordToolStartHistory,
  recordToolTurnHistory,
  recordModelRunStats,
  toolResultStatusLabel,
  type TuiSession
} from '../../tui.js';
import { createRunModelActivityRecorder, recordRunError, recordRunResult, recordRunStart } from '../../diagnostics.js';
import { clipStart } from '../text/clip.js';
import { formatDuration, runCompletionMessage } from '../duration.js';
import { createTokenRateState, recordTokenRateChunk } from '../tokenRate.js';
import type { AgentTurn, ToolCall } from 'gemma-cli-core';

const progressRedrawIntervalMs = 120;

export interface StreamHandlers {
  setBusy: (value: boolean) => void;
  setRunningLabel: (value: string | undefined) => void;
  setActivityLabel: (value: string | undefined) => void;
  setThinkingText: (value: string) => void;
  setThinkingActive: (value: boolean) => void;
  forceRedraw: () => void;
}

export async function streamPromptInk(
  session: TuiSession,
  prompt: string,
  abortController: AbortController,
  handlers: StreamHandlers
): Promise<void> {
  const startedAt = Date.now();
  const runId = session.diagnostics ? await recordRunStart(session.diagnostics, prompt) : undefined;
  addHistory(session, 'user', formatUserPromptForHistory(prompt));
  let pendingThinkingText = '';
  let pendingThinkingChars = 0;
  let lastProgressRedrawAt = 0;
  const redrawProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressRedrawAt < progressRedrawIntervalMs) {
      return false;
    }
    lastProgressRedrawAt = now;
    handlers.forceRedraw();
    return true;
  };
  const setProgressLabel = (label: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressRedrawAt < progressRedrawIntervalMs) {
      return false;
    }
    handlers.setActivityLabel(label);
    lastProgressRedrawAt = now;
    handlers.forceRedraw();
    return true;
  };
  const flushThinking = (forceRedraw = false) => {
    if (pendingThinkingChars === 0 || !pendingThinkingText.trim()) return;
    const note = reasoningOffRequested(session)
      ? '\nprovider emitted reasoning despite think off request'
      : '';
    addHistory(session, 'thinking', `${thinkingSnippet(pendingThinkingText, 200)}\n${pendingThinkingChars} chars received${note}`);
    pendingThinkingText = '';
    pendingThinkingChars = 0;
    handlers.setThinkingText('');
    handlers.setThinkingActive(false);
    redrawProgress(forceRedraw);
  };

  handlers.setBusy(true);
  session.agentRunning = true;
  session.liveTokenRate = createTokenRateState(startedAt);
  handlers.setRunningLabel('agent');
  handlers.setActivityLabel('waiting for model');
  handlers.setThinkingText('');
  handlers.setThinkingActive(false);
  flash(session, 'thinking…');
  handlers.forceRedraw();

  const partialTurns: AgentTurn[] = [];
  const pendingToolCalls = new Map<number, ToolCall>();
  const modelActivity = createRunModelActivityRecorder(session.diagnostics, runId);

  try {
    const progress = createToolProgressState();
    let thinkingChars = 0;
    let contentChars = 0;
    const result = await session.runtime.run(prompt, {
      signal: abortController.signal,
      onModelStart(event) {
        handlers.setRunningLabel('model');
        setProgressLabel(event.finalization ? 'final summary pass' : `turn ${event.index + 1}`, true);
        flash(session, 'waiting for model…');
      },
      async onModelActivity(event) {
        await modelActivity.record(event);
        if (session.liveTokenRate) {
          recordTokenRateChunk(session.liveTokenRate, event.chunk);
        }
        if (event.chunk.thinking) {
          thinkingChars += event.chunk.thinking.length;
          pendingThinkingChars += event.chunk.thinking.length;
          pendingThinkingText = appendThinkingPreview(pendingThinkingText, event.chunk.thinking);
          if (setProgressLabel(`${reasoningActivityLabel(session)} ${thinkingChars} chars`)) {
            handlers.setThinkingText(pendingThinkingText);
            handlers.setThinkingActive(true);
          }
        } else if (event.chunk.content) {
          flushThinking(true);
          contentChars += event.chunk.content.length;
          setProgressLabel(`receiving ${contentChars} chars`);
        } else if (event.chunk.status) {
          setProgressLabel(event.chunk.status);
        } else if (event.chunk.done) {
          flushThinking(true);
          setProgressLabel('model response complete', true);
        }
      },
      onToolStart(event) {
        flushThinking(true);
        pendingToolCalls.set(event.index, event.toolCall);
        recordToolStartHistory(session, progress, event);
        handlers.setRunningLabel(`tool: ${event.toolCall.tool}`);
        setProgressLabel(`tool ${event.toolCall.tool}`, true);
        flash(session, `running ${event.toolCall.tool}`);
      },
      onTurn(event) {
        partialTurns[event.index] = event.turn;
        pendingToolCalls.delete(event.index);
        if (event.turn.kind === 'tool') {
          recordToolTurnHistory(session, progress, event);
          handlers.setRunningLabel('agent');
          const status = toolResultStatusLabel(event.turn.toolResult);
          setProgressLabel(`${event.turn.toolCall?.tool ?? 'tool'} ${status}`, true);
          flash(session, `${event.turn.toolCall?.tool ?? 'tool'} ${status === 'ok' ? 'completed' : status}`);
        }
      }
    });
    flushThinking(true);
    appendRunTurnsToHistory(session, result, progress);
    const elapsedMs = Date.now() - startedAt;
    session.lastStats = `model=${session.runtime.model} status=${result.completionStatus ?? 'completed'} turns=${result.stats.turns} tools=${result.stats.toolCalls} duration=${formatDuration(result.stats.durationMs)} elapsed=${formatDuration(elapsedMs)}`;
    recordModelRunStats(session, result.stats);
    appendRunToRuntimeHistory(session, prompt, result);
    if (runId && session.diagnostics) {
      await modelActivity.flush();
      await recordRunResult(session.diagnostics, runId, result, {
        modelOutputs: modelActivity.snapshots()
      });
    }
    flash(session, runCompletionMessage(result.completionStatus, elapsedMs));
  } catch (error) {
    const interruptedTurns = partialTurns.filter(Boolean);
    const interruptedMessage = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted) {
      appendInterruptedRunToRuntimeHistory(session, prompt, interruptedTurns, 'cancelled', interruptedMessage);
      if (runId && session.diagnostics) {
        await modelActivity.flush();
        await recordRunError(session.diagnostics, runId, error, 'cancelled', {
          turns: interruptedTurns,
          pendingToolCalls: [...pendingToolCalls.values()],
          modelOutputs: modelActivity.snapshots()
        });
      }
      addHistory(session, 'error', `cancelled: ${prompt}`);
      flash(session, 'run cancelled');
    } else {
      appendInterruptedRunToRuntimeHistory(session, prompt, interruptedTurns, 'failed', interruptedMessage);
      if (runId && session.diagnostics) {
        await modelActivity.flush();
        await recordRunError(session.diagnostics, runId, error, 'failed', {
          turns: interruptedTurns,
          pendingToolCalls: [...pendingToolCalls.values()],
          modelOutputs: modelActivity.snapshots()
        });
      }
      addHistory(session, 'error', error instanceof Error ? error.message : String(error));
      flash(session, 'run failed');
    }
  } finally {
    session.agentRunning = false;
    handlers.setRunningLabel(undefined);
    handlers.setActivityLabel(undefined);
    handlers.setThinkingText('');
    handlers.setThinkingActive(false);
    handlers.setBusy(false);
    handlers.forceRedraw();
  }
}

function appendThinkingPreview(current: string, chunk: string): string {
  const maxBuffer = 2_000;
  const next = `${current}${chunk}`;
  return next.length > maxBuffer ? next.slice(-maxBuffer) : next;
}

export function thinkingSnippet(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'receiving reasoning';
  return clipStart(normalized, Math.max(width, 1));
}

function reasoningActivityLabel(session: TuiSession): string {
  return reasoningOffRequested(session)
    ? 'reasoning received despite think off'
    : 'reasoning';
}

function reasoningOffRequested(session: TuiSession): boolean {
  const mode = session.reasoningMode ?? 'auto';
  if (mode === 'off') return true;
  return session.provider === 'ollama' && mode === 'auto' && !/gemma4/i.test(session.runtime.model);
}
