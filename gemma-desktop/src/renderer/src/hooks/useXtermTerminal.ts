import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

const DEFAULT_TERMINAL_OPTIONS = {
  convertEol: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  fontSize: 12,
  lineHeight: 1.35,
  scrollback: 2000,
  theme: {
    background: '#101218',
    foreground: '#e5e7eb',
    cursor: '#f59e0b',
    selectionBackground: '#334155',
  },
}

interface UseXtermTerminalOptions {
  enabled: boolean
  terminalId: string | null
  transcript: string
  running: boolean
  onData?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
}

export function useXtermTerminal({
  enabled,
  terminalId,
  transcript,
  running,
  onData,
  onResize,
}: UseXtermTerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const renderedTranscriptRef = useRef('')
  const latestRunningRef = useRef(running)
  const latestOnDataRef = useRef(onData)
  const latestOnResizeRef = useRef(onResize)

  useEffect(() => {
    latestRunningRef.current = running
    latestOnDataRef.current = onData
    latestOnResizeRef.current = onResize
  }, [onData, onResize, running])

  useEffect(() => {
    if (!enabled || !terminalId || !containerRef.current) {
      return
    }

    const terminal = new Terminal({
      ...DEFAULT_TERMINAL_OPTIONS,
      cursorBlink: latestRunningRef.current,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal
    renderedTranscriptRef.current = ''

    const resizeTerminal = () => {
      fitAddon.fit()
      if (!latestRunningRef.current) {
        return
      }

      latestOnResizeRef.current?.(terminal.cols, terminal.rows)
    }

    const dataSubscription = terminal.onData((data) => {
      if (!latestRunningRef.current) {
        return
      }

      latestOnDataRef.current?.(data)
    })

    resizeTerminal()

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        resizeTerminal()
      })
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      resizeObserver?.disconnect()
      dataSubscription.dispose()
      terminal.dispose()
      terminalRef.current = null
      renderedTranscriptRef.current = ''
    }
  }, [enabled, terminalId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !enabled) {
      return
    }

    terminal.options.cursorBlink = running

    const renderedTranscript = renderedTranscriptRef.current
    if (transcript === renderedTranscript) {
      return
    }

    if (transcript.startsWith(renderedTranscript)) {
      const delta = transcript.slice(renderedTranscript.length)
      if (delta.length > 0) {
        terminal.write(delta)
      }
    } else {
      terminal.reset()
      if (transcript.length > 0) {
        terminal.write(transcript)
      }
    }

    renderedTranscriptRef.current = transcript
  }, [enabled, running, transcript])

  return {
    containerRef,
    focus: () => {
      terminalRef.current?.focus()
    },
  }
}
