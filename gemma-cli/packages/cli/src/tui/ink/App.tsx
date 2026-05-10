import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Writable } from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import {
  addHistory,
  blockSlashCommandWhileAgentRunning,
  clearVisibleHistory,
  completeSlashInput,
  flash,
  handleTuiLine,
  listSessionModelInfos,
  preferredModelIndex,
  selectSessionModel,
  slashSuggestions,
  type SessionModelSelection,
  type TuiSession
} from '../../tui.js';
import { StaticHistory } from './StaticHistory.js';
import { Input } from './Input.js';
import { StatusLine } from './StatusLine.js';
import { Footer, reasoningFooterLabel } from './Footer.js';
import { Suggestions } from './Suggestions.js';
import { ModelPicker, filterModels, type ModelPickerState } from './ModelPicker.js';
import { PermissionPanel } from './PermissionPanel.js';
import { contextLabel } from './contextLabel.js';
import { editInput, moveInputCursor } from './inputControl.js';
import { streamPromptInk } from './streamPrompt.js';
import { runShellFromInk } from './streamShell.js';
import { ThinkingPreview } from './ThinkingPreview.js';
import { useTerminalSize } from './useTerminalSize.js';
import { tokenRateLabel } from '../tokenRate.js';
import type { SessionModelInfo } from '../../tui.js';
import type { WorkspacePermissionRequest } from '@gemma-sdk/agent';

type ModelSelection = Pick<SessionModelInfo, 'name' | 'provider'>;

interface PermissionPromptState {
  request: WorkspacePermissionRequest;
  resolve: (approved: boolean) => void;
}

interface Props {
  session: TuiSession;
  inputStream: NodeJS.ReadStream;
  output: NodeJS.WritableStream;
}

class NullOutput extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

export function App({ session, inputStream, output }: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [renderTick, redraw] = useState(0);
  const terminalSize = useTerminalSize(stdout);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [runningLabel, setRunningLabel] = useState<string | undefined>();
  const [activityLabel, setActivityLabel] = useState<string | undefined>();
  const [thinkingText, setThinkingText] = useState('');
  const [thinkingActive, setThinkingActive] = useState(false);
  const [modelPicker, setModelPicker] = useState<ModelPickerState | undefined>();
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptState | undefined>();
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [busyStartedAt, setBusyStartedAt] = useState<number | undefined>();
  const [completionIndex, setCompletionIndex] = useState(0);
  const [staticRefreshKey, setStaticRefreshKey] = useState(0);
  const activeAbort = useRef<AbortController | undefined>(undefined);
  const nullOutput = useMemo(() => new NullOutput(), []);
  const inputRef = useRef(input);
  const cursorRef = useRef(cursor);
  const startupStarted = useRef(false);
  const initialResizeRefreshSkipped = useRef(false);
  inputRef.current = input;
  cursorRef.current = cursor;
  const forceRedraw = useCallback(() => redraw((value) => value + 1), []);
  const refreshStatic = useCallback(() => {
    output.write(ansiEscapes.clearTerminal);
    setStaticRefreshKey((value) => value + 1);
  }, [output]);

  useEffect(() => {
    session.requestToolPermission = async (request) => await new Promise<boolean>((resolve) => {
      setPermissionPrompt({ request, resolve });
      setActivityLabel('permission required');
      flash(session, 'permission required');
      forceRedraw();
    });
    return () => {
      session.requestToolPermission = undefined;
    };
  }, [forceRedraw, session]);

  useEffect(() => {
    if (!initialResizeRefreshSkipped.current) {
      initialResizeRefreshSkipped.current = true;
      return undefined;
    }

    const handler = setTimeout(() => {
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [refreshStatic, terminalSize.columns]);

  useEffect(() => {
    if (!busy) {
      setBusyStartedAt(undefined);
      return undefined;
    }
    setBusyStartedAt(Date.now());
    const timer = setInterval(() => {
      setSpinnerIndex((index) => index + 1);
      redraw((value) => value + 1);
    }, 120);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (session.startupModelSelection && !startupStarted.current) {
      startupStarted.current = true;
      setModelPicker({
        models: [],
        filter: '',
        selected: 0,
        loading: true,
        startup: true,
        hint: startupPickerHint(session.startupModelSelection.preferred, session.startupModelSelection.source)
      });
      setBusy(true);
      setRunningLabel('models');
      setActivityLabel('loading models');
      session.flash = 'loading local models...';
      forceRedraw();
      void listSessionModelInfos(session)
        .then((models) => {
          if (models.length === 0) {
            setModelPicker({
              models: [],
              filter: '',
              selected: 0,
              loading: false,
              startup: true,
              noModels: true,
              error: 'No local models found. Start Ollama or LM Studio and install or load a model, then restart Gemma CLI.'
            });
            flash(session, 'no local models found');
            return;
          }
          const preferredIndex = preferredModelIndex(models, session.startupModelSelection!.preferred);
          setModelPicker({
            models,
            filter: '',
            selected: Math.max(preferredIndex, 0),
            loading: false,
            startup: true,
            hint: preferredIndex >= 0
              ? startupPickerHint(session.startupModelSelection!.preferred, session.startupModelSelection!.source)
              : `${session.startupModelSelection!.preferred.provider}/${session.startupModelSelection!.preferred.model} is unavailable. Select a model to start.`
          });
          flash(session, `${models.length} local models found`);
        })
        .catch((error: unknown) => {
          setModelPicker({
            models: [],
            filter: '',
            selected: 0,
            loading: false,
            startup: true,
            noModels: true,
            error: error instanceof Error ? error.message : String(error)
          });
          flash(session, 'model discovery failed');
        })
        .finally(() => {
          setBusy(false);
          setRunningLabel(undefined);
          setActivityLabel(undefined);
          forceRedraw();
        });
      return;
    }
    if (!session.runtimeReady || startupStarted.current) return;
    startupStarted.current = true;
    setBusy(true);
    setRunningLabel('starting runtime');
    setActivityLabel('starting runtime');
    session.flash = 'starting runtime…';
    forceRedraw();
    void session.runtimeReady
      .then((runtime) => {
        session.runtime = runtime;
        session.runtimeReady = undefined;
        flash(session, 'runtime ready');
      })
      .catch((error: unknown) => {
        session.runtimeReady = undefined;
        addHistory(session, 'error', error instanceof Error ? error.message : String(error));
        flash(session, 'runtime startup failed');
      })
      .finally(() => {
        setBusy(false);
        setRunningLabel(undefined);
        setActivityLabel(undefined);
        forceRedraw();
      });
  }, [forceRedraw, session]);

  const width = terminalSize.columns;
  const height = terminalSize.rows;
  const suggestions = modelPicker ? [] : slashSuggestions(input) ?? [];
  const visibleSuggestions = suggestions.slice(0, Math.max(Math.min(height - 12, 6), 0));
  const modelPickerHeight = modelPicker ? Math.min(Math.max(height - 14, 5), 12) : 0;
  const visibleActivity = session.autoFollow === false
    ? `scrollback paused · End to follow live · ${activityLabel ?? runningLabel ?? 'working'}`
    : activityLabel ?? runningLabel;

  const clearInput = useCallback(() => {
    session.inputBuffer = '';
    session.commandSuggestions = undefined;
    flash(session, 'input cleared');
    setInput('');
    setCursor(0);
    setCompletionIndex(0);
    forceRedraw();
  }, [forceRedraw, session]);

  const openModelPicker = useCallback(async (filter = '') => {
    setModelPicker({ models: [], filter, selected: 0, loading: true });
    setBusy(true);
    setRunningLabel('models');
    setActivityLabel('loading models');
    flash(session, 'loading models…');
    forceRedraw();
    try {
      const models = await listSessionModelInfos(session);
      const selected = Math.max(models.findIndex((model) => model.name === session.runtime.model && model.provider === session.provider), 0);
      setModelPicker({ models, filter, selected, loading: false });
      flash(session, `${models.length} models loaded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelPicker({ models: [], filter, selected: 0, loading: false, error: message });
      flash(session, 'model listing failed');
    } finally {
      setBusy(false);
      setRunningLabel(undefined);
      setActivityLabel(undefined);
      forceRedraw();
    }
  }, [forceRedraw, session]);

  const chooseModelFromPicker = useCallback(async (model: ModelSelection, startup = false) => {
    setBusy(true);
    setRunningLabel('model');
    setActivityLabel(startup ? `starting with ${model.name}` : `switching to ${model.name}`);
    flash(session, startup ? `starting with ${model.name}...` : `switching to ${model.name}…`);
    forceRedraw();
    try {
      await selectSessionModel(session, model.name, model.provider);
      if (startup) {
        session.startupModelSelection = undefined;
      }
      setModelPicker(undefined);
      refreshStatic();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelPicker((current) => current ? { ...current, error: message } : current);
      if (!startup) {
        addHistory(session, 'error', message);
      }
      flash(session, 'model switch failed');
    } finally {
      setBusy(false);
      setRunningLabel(undefined);
      setActivityLabel(undefined);
      forceRedraw();
    }
  }, [forceRedraw, refreshStatic, session]);

  const submit = useCallback(async (rawLine = inputRef.current) => {
    const line = rawLine.trim();
    if (!line) return;
    if (busy) {
      if (session.agentRunning && line.startsWith('/')) {
        blockSlashCommandWhileAgentRunning(session);
        setInput('');
        setCursor(0);
        setCompletionIndex(0);
        session.inputBuffer = '';
        session.commandSuggestions = undefined;
        forceRedraw();
      }
      return;
    }
    setInput('');
    setCursor(0);
    setCompletionIndex(0);
    session.inputBuffer = '';
    session.commandSuggestions = undefined;
    session.autoFollow = true;
    session.scrollOffset = 0;

    if (line === '/quit' || line === '/exit') {
      exit();
      return;
    }
    if (line === '/clear-input') {
      clearInput();
      return;
    }
    if (line === '/clear') {
      clearVisibleHistory(session);
      flash(session, 'history cleared');
      refreshStatic();
      forceRedraw();
      return;
    }
    if (line === '/model') {
      await openModelPicker();
      return;
    }
    if (line.startsWith('!')) {
      const abort = new AbortController();
      activeAbort.current = abort;
      await runShellFromInk(session, line, inputStream, output, abort, {
        setBusy, setRunningLabel, setActivityLabel, forceRedraw
      });
      if (activeAbort.current === abort) activeAbort.current = undefined;
      return;
    }
    if (!line.startsWith('/')) {
      const abort = new AbortController();
      activeAbort.current = abort;
      await streamPromptInk(session, line, abort, {
        setBusy, setRunningLabel, setActivityLabel, setThinkingText, setThinkingActive, forceRedraw
      });
      if (activeAbort.current === abort) activeAbort.current = undefined;
      return;
    }

    setBusy(true);
    setRunningLabel(`/${line.slice(1).split(/\s+/, 1)[0]}`);
    setActivityLabel(`/${line.slice(1).split(/\s+/, 1)[0]}`);
    try {
      const beforeModel = session.runtime.model;
      const beforeProvider = session.provider;
      await handleTuiLine(session, line, nullOutput);
      if (session.runtime.model !== beforeModel || session.provider !== beforeProvider) {
        refreshStatic();
      } else {
        forceRedraw();
      }
    } finally {
      setBusy(false);
      setRunningLabel(undefined);
      setActivityLabel(undefined);
    }
  }, [busy, clearInput, exit, forceRedraw, inputStream, nullOutput, openModelPicker, output, refreshStatic, session]);

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      exit();
      return;
    }
    if (permissionPrompt) {
      if (/^y$/i.test(value)) {
        permissionPrompt.resolve(true);
        setPermissionPrompt(undefined);
        flash(session, 'permission approved');
        forceRedraw();
      } else if (/^n$/i.test(value) || key.escape || key.return) {
        permissionPrompt.resolve(false);
        setPermissionPrompt(undefined);
        flash(session, 'permission denied');
        forceRedraw();
      }
      return;
    }
    if (modelPicker) {
      handleModelPickerInput(modelPicker, setModelPicker, key, value, chooseModelFromPicker, session, forceRedraw, exit);
      return;
    }
    if (busy) {
      if (key.escape) {
        activeAbort.current?.abort();
        flash(session, 'cancelling…');
        forceRedraw();
        return;
      }
      if (key.backspace || key.delete) {
        editInput(inputRef.current, cursorRef.current, setInput, setCursor, session, 'backspace');
        return;
      }
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        moveInputCursor(key, inputRef.current, cursorRef.current, setCursor, width);
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        editInput(inputRef.current, cursorRef.current, setInput, setCursor, session, 'insert', normalizePastedInput(value));
      }
      return;
    }
    if (key.return && (key as { shift?: boolean }).shift) {
      editInput(inputRef.current, cursorRef.current, setInput, setCursor, session, 'insert', '\n');
      setCompletionIndex(0);
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.escape || (key.ctrl && value === 'u')) {
      clearInput();
      return;
    }
    if (key.tab || value === '\t') {
      setInput((current) => {
        const next = completeSlashInput(current, completionIndex);
        session.inputBuffer = next;
        session.commandSuggestions = slashSuggestions(next);
        setCursor(next.length);
        setCompletionIndex((index) => index + 1);
        if (next !== current) flash(session, 'command completed');
        return next;
      });
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      moveInputCursor(key, inputRef.current, cursorRef.current, setCursor, width);
      return;
    }
    if (key.backspace || key.delete) {
      editInput(inputRef.current, cursorRef.current, setInput, setCursor, session, 'backspace');
      setCompletionIndex(0);
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      editInput(inputRef.current, cursorRef.current, setInput, setCursor, session, 'insert', normalizePastedInput(value));
      setCompletionIndex(0);
    }
  });

  return (
    <>
      <StaticHistory
        key={`history-${session.historyRevision ?? 0}:${staticRefreshKey}`}
        session={session}
        width={width}
        staticKey={staticRefreshKey}
        redrawTick={renderTick}
      />
      <Box flexDirection="column" width={width}>
        {modelPicker && (
          <Box marginLeft={2}>
            <ModelPicker
              picker={modelPicker}
              currentModel={session.runtime.model}
              currentProvider={session.provider}
              width={width - 2}
              height={modelPickerHeight}
            />
          </Box>
        )}
        {permissionPrompt && (
          <Box marginX={1} marginY={1}>
            <PermissionPanel request={permissionPrompt.request} width={width - 2} />
          </Box>
        )}
        <Suggestions suggestions={visibleSuggestions} width={width} />
        {thinkingActive && thinkingText.trim() && (
          <ThinkingPreview text={thinkingText} width={width} />
        )}
        <Text> </Text>
        <StatusLine
          busy={busy}
          flash={session.flash}
          lastStats={session.lastStats}
          activity={visibleActivity}
          elapsedMs={busyStartedAt === undefined ? undefined : Date.now() - busyStartedAt}
          spinnerIndex={spinnerIndex}
          width={width}
        />
        <Text> </Text>
        <Input value={input} cursor={cursor} width={width} />
        <Footer
          cwd={session.runtime.cwd}
          model={session.runtime.model}
          reasoning={reasoningFooterLabel(session)}
          context={contextLabel(session)}
          tokenRate={session.agentRunning && session.liveTokenRate ? tokenRateLabel(session.liveTokenRate) : undefined}
          width={width}
        />
      </Box>
    </>
  );
}

function startupPickerHint(preferred: SessionModelSelection, source: 'explicit' | 'session' | 'preference' | 'default'): string {
  const label = `${preferred.provider}/${preferred.model}`;
  if (source === 'explicit') {
    return `Requested model: ${label}`;
  }
  if (source === 'session') {
    return `Last session model: ${label}`;
  }
  if (source === 'preference') {
    return `Last selected model: ${label}`;
  }
  return `Default model: ${label}`;
}

function normalizePastedInput(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function handleModelPickerInput(
  picker: ModelPickerState,
  setModelPicker: React.Dispatch<React.SetStateAction<ModelPickerState | undefined>>,
  key: { escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  value: string,
  chooseModel: (model: ModelSelection, startup?: boolean) => Promise<void>,
  session: TuiSession,
  forceRedraw: () => void,
  exit: () => void
): void {
  if (key.escape) {
    if (picker.startup) {
      exit();
      return;
    }
    setModelPicker(undefined);
    flash(session, 'model picker closed');
    forceRedraw();
    return;
  }
  if (picker.loading) return;
  if (picker.startup && picker.noModels) {
    if (/^q$/i.test(value)) {
      exit();
    }
    return;
  }
  const models = filterModels(picker);
  if (key.return) {
    const model = models[Math.max(0, Math.min(picker.selected, Math.max(models.length - 1, 0)))];
    if (model) void chooseModel(model, picker.startup === true);
    return;
  }
  if (key.upArrow || key.downArrow) {
    const delta = key.upArrow ? -1 : 1;
    setModelPicker((current) => {
      if (!current) return current;
      const filtered = filterModels(current);
      return { ...current, selected: Math.max(0, Math.min(current.selected + delta, Math.max(filtered.length - 1, 0))) };
    });
    return;
  }
  if (key.backspace || key.delete) {
    setModelPicker((current) => current ? { ...current, filter: current.filter.slice(0, -1), selected: 0, error: undefined } : current);
    return;
  }
  if (value && !key.ctrl && !key.meta && value.search(/[\r\n]/) === -1) {
    setModelPicker((current) => current ? { ...current, filter: `${current.filter}${value}`, selected: 0, error: undefined } : current);
  }
}
