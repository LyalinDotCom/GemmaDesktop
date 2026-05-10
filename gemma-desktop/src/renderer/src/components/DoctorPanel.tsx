import { useEffect, useState, type ReactNode } from 'react'
import {
  Camera,
  Cpu,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  Mic,
  Monitor,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Volume2,
  X,
} from 'lucide-react'
import type {
  DoctorCommandCheck,
  DoctorIntegrationCheck,
  DoctorIssue,
  DoctorPermissionCheck,
  DoctorReport,
  DoctorRuntimeCheck,
  ReadAloudTestInput,
} from '@/types'

interface DoctorPanelProps {
  open: boolean
  onClose: () => void
  onInstallSpeech: () => void | Promise<unknown>
  onRepairSpeech: () => void | Promise<unknown>
  onOpenSettings: () => void
  onOpenVoiceSettings: () => void
  onTestReadAloud: (input?: ReadAloudTestInput) => void | Promise<unknown>
}

export type DoctorTab =
  | 'overview'
  | 'runtimes'
  | 'commands'
  | 'integrations'
  | 'permissions'
  | 'speech'
  | 'readAloud'
  | 'system'

const DOCTOR_TAB_ENTRIES: ReadonlyArray<
  readonly [DoctorTab, string, typeof Gauge]
> = [
  ['overview', 'Overview', Gauge],
  ['runtimes', 'Runtimes', Cpu],
  ['commands', 'Commands', Terminal],
  ['integrations', 'Integrations', Puzzle],
  ['permissions', 'Permissions', KeyRound],
  ['speech', 'Speech', Mic],
  ['readAloud', 'Read Aloud', Volume2],
  ['system', 'System', HardDrive],
]

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

function toneBadge(tone: Tone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
    case 'warning':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
    case 'danger':
      return 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'
    case 'info':
      return 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400'
    case 'neutral':
      return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  }
}

function issueTone(severity: DoctorIssue['severity']): Tone {
  return severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'info'
}

function commandTone(status: DoctorCommandCheck['status']): Tone {
  return status === 'available' ? 'success' : status === 'error' ? 'warning' : 'danger'
}

function runtimeTone(status: DoctorRuntimeCheck['status']): Tone {
  return status === 'running' ? 'success' : status === 'stopped' ? 'warning' : 'neutral'
}

function permissionTone(p: DoctorPermissionCheck): Tone {
  if (p.severity === 'success') return 'success'
  if (p.severity === 'warning') {
    return p.status === 'denied' || p.status === 'restricted' ? 'danger' : 'warning'
  }
  return 'info'
}

function integrationTone(status: DoctorIntegrationCheck['status']): Tone {
  switch (status) {
    case 'ready':
      return 'success'
    case 'disabled':
      return 'neutral'
    case 'missing_dependency':
      return 'danger'
    case 'attention':
      return 'warning'
  }
}

function formatReadAloudState(state: string): string {
  switch (state) {
    case 'missing_assets':
      return 'Not installed'
    case 'installing':
      return 'Installing'
    case 'loading':
      return 'Preparing'
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Needs attention'
    case 'unsupported':
      return 'Unsupported'
    default:
      return state.replace(/_/g, ' ')
  }
}

function formatPermissionStatus(status: DoctorPermissionCheck['status']): string {
  const map: Record<string, string> = {
    granted: 'Granted',
    denied: 'Denied',
    restricted: 'Restricted',
    'not-determined': 'Not set',
    unknown: 'Unknown',
    unsupported: 'N/A',
  }
  return map[status] ?? status
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</h3>
      {subtitle && (
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      )}
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toneBadge(tone)}`}>
      {children}
    </span>
  )
}

function RuntimeBlock({ runtime }: { runtime: DoctorRuntimeCheck }) {
  const visibleModels = runtime.models.slice(0, 6)
  const hiddenCount = Math.max(0, runtime.models.length - visibleModels.length)

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              {runtime.label}
            </span>
            <Badge tone={runtimeTone(runtime.status)}>
              {runtime.status === 'not_installed' ? 'not detected' : runtime.status}
            </Badge>
            {runtime.version && (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                v{runtime.version}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{runtime.summary}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] text-zinc-400 dark:text-zinc-500">
          {runtime.loadedModelCount} loaded · {runtime.modelCount} visible
        </div>
      </div>

      {runtime.variants.length > 0 && (
        <div className="border-t border-zinc-100 dark:border-zinc-800/60">
          {runtime.variants.map((variant, i) => (
            <div
              key={variant.id}
              className={`flex items-center justify-between gap-2 px-3 py-2 text-xs ${
                i > 0 ? 'border-t border-zinc-100 dark:border-zinc-800/60' : ''
              }`}
            >
              <div className="min-w-0">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {variant.label}
                </span>
                <span className="ml-2 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                  {variant.endpoint}
                </span>
              </div>
              <Badge tone={runtimeTone(variant.status)}>
                {variant.status === 'not_installed' ? 'not detected' : variant.status}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {visibleModels.length > 0 && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800/60">
          <div className="space-y-2">
            {visibleModels.map((model) => (
              <div
                key={model.id}
                className="rounded-md bg-zinc-50 px-2 py-2 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
              >
                <div className="flex items-center gap-1">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {model.label}
                  </span>
                  {model.status === 'loaded' && (
                    <span className="text-emerald-600 dark:text-emerald-400">●</span>
                  )}
                </div>
                {model.runtimeConfig && (
                  <div className="mt-1 space-y-1 text-[10px] leading-4 text-zinc-500 dark:text-zinc-400">
                    <div>
                      Requested:{' '}
                      {model.runtimeConfig.requestedOptions
                        ? Object.entries(model.runtimeConfig.requestedOptions)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(' · ')
                        : 'none'}
                    </div>
                    <div>
                      Live:{' '}
                      {model.runtimeConfig.loadedContextLength
                        ? `${Math.round(model.runtimeConfig.loadedContextLength / 1024)}K ctx`
                        : 'not loaded'}
                      {typeof model.runtimeConfig.approxGpuResidencyPercent === 'number'
                        ? ` · ${model.runtimeConfig.approxGpuResidencyPercent}% GPU`
                        : ''}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {hiddenCount > 0 && (
              <span className="rounded-md bg-zinc-50 px-2 py-1 text-[11px] text-zinc-400 dark:bg-zinc-900">
                +{hiddenCount} more
              </span>
            )}
          </div>
        </div>
      )}

      {(runtime.diagnosis.length > 0 || runtime.warnings.length > 0) && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800/60">
          {runtime.diagnosis.map((entry) => (
            <p key={entry} className="text-xs text-sky-600 dark:text-sky-400">{entry}</p>
          ))}
          {runtime.warnings.map((entry) => (
            <p key={entry} className="text-xs text-amber-600 dark:text-amber-400">{entry}</p>
          ))}
        </div>
      )}
    </div>
  )
}

export function DoctorPanel({
  open,
  onClose,
  onInstallSpeech,
  onRepairSpeech,
  onOpenSettings,
  onOpenVoiceSettings,
  onTestReadAloud,
}: DoctorPanelProps) {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<DoctorTab>('overview')
  const [requestingCamera, setRequestingCamera] = useState(false)
  const [requestingMicrophone, setRequestingMicrophone] = useState(false)
  const [openingPrivacySettings, setOpeningPrivacySettings] = useState<
    'screen' | 'camera' | 'microphone' | null
  >(null)
  const [installingSpeech, setInstallingSpeech] = useState(false)
  const [testingReadAloud, setTestingReadAloud] = useState(false)

  const loadReport = async (initialLoad = false) => {
    if (initialLoad) setLoading(true)
    else setRefreshing(true)

    try {
      const nextReport = await window.gemmaDesktopBridge.doctor.inspect()
      setReport(nextReport)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Doctor could not inspect this machine.')
    } finally {
      if (initialLoad) setLoading(false)
      else setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!open) return

    setActiveTab('overview')

    let cancelled = false
    setLoading(true)
    void window.gemmaDesktopBridge.doctor.inspect()
      .then((r) => { if (!cancelled) { setReport(r); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Inspection failed.') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const handleRequestCameraAccess = async () => {
    setRequestingCamera(true)
    try {
      await window.gemmaDesktopBridge.media.requestCameraAccess()
      await loadReport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request camera access.')
    } finally {
      setRequestingCamera(false)
    }
  }

  const handleRequestMicrophoneAccess = async () => {
    setRequestingMicrophone(true)

    try {
      await window.gemmaDesktopBridge.media.requestMicrophoneAccess()
      await loadReport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request microphone access.')
    } finally {
      setRequestingMicrophone(false)
    }
  }

  const handleRunReadAloudTest = async () => {
    setTestingReadAloud(true)

    try {
      await Promise.resolve(onTestReadAloud())
      await loadReport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run read aloud test.')
    } finally {
      setTestingReadAloud(false)
    }
  }

  const handleOpenPrivacySettings = async (permissionId: 'screen' | 'camera' | 'microphone') => {
    setOpeningPrivacySettings(permissionId)

    try {
      const opened = await window.gemmaDesktopBridge.doctor.openPrivacySettings(permissionId)
      if (!opened) {
        setError('Could not open the relevant macOS privacy settings pane.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open privacy settings.')
    } finally {
      setOpeningPrivacySettings(null)
    }
  }

  const handleInstallSpeech = async () => {
    setInstallingSpeech(true)

    try {
      await Promise.resolve(onInstallSpeech())
      await loadReport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not install Managed whisper.cpp.')
    } finally {
      setInstallingSpeech(false)
    }
  }

  const handleRepairSpeech = async () => {
    setInstallingSpeech(true)

    try {
      await Promise.resolve(onRepairSpeech())
      await loadReport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not repair Managed whisper.cpp.')
    } finally {
      setInstallingSpeech(false)
    }
  }

  const tabBadgeCount = (tab: DoctorTab): number => {
    if (!report) return 0
    switch (tab) {
      case 'overview':
        return report.summary.errorCount + report.summary.warningCount
      case 'runtimes': {
        const r = report.runtimes
        const offline = r.filter((x) => x.status !== 'running').length
        return offline
      }
      case 'commands':
        return report.commands.filter((cmd) => cmd.status !== 'available').length
      case 'integrations':
        return report.integrations.filter(
          (i) => i.status === 'attention' || i.status === 'missing_dependency',
        ).length
      case 'permissions':
        return report.permissions.filter(
          (p) => p.severity === 'warning' && p.status !== 'granted',
        ).length
      case 'speech':
        return report.speech.healthy ? 0 : 1
      case 'readAloud':
        return report.readAloud.healthy ? 0 : 1
      case 'system':
        return 0
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-0 top-12 z-[55] flex items-center justify-center overflow-hidden bg-black/40 px-4 py-6 backdrop-blur-sm sm:px-6">
      <div className="no-drag flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">
            Doctor
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void loadReport(false) }}
              disabled={loading || refreshing}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Refresh"
            >
              <RefreshCw size={15} className={loading || refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body: tabs sidebar + content */}
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Doctor sections"
            className="scrollbar-thin w-44 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50/60 px-2 py-3 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            {DOCTOR_TAB_ENTRIES.map(([tab, label, Icon]) => {
              const isActive = activeTab === tab
              const badge = tabBadgeCount(tab)
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100'
                  }`}
                >
                  <Icon size={14} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {badge > 0 && (
                    <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
                      {badge}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          {/* Content */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-6 px-6 py-5">
              {loading && !report ? (
                <div className="flex min-h-[200px] items-center justify-center">
                  <div className="flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 size={14} className="animate-spin" />
                    Running checks...
                  </div>
                </div>
              ) : !report ? (
                <div className="flex min-h-[200px] items-center justify-center">
                  <p className="text-sm text-zinc-500">
                    {error ?? 'No diagnostics available.'}
                  </p>
                </div>
              ) : (
                <>
                  {error && (
                    <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>
                  )}

                  {activeTab === 'overview' && (
                    <>
                      <div className="flex items-center justify-between rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {report.summary.ready ? (
                            <ShieldCheck size={16} className="text-emerald-500" />
                          ) : (
                            <ShieldAlert size={16} className="text-amber-500" />
                          )}
                          {report.summary.headline}
                        </div>
                        <div className="flex items-center gap-3">
                          {report.summary.errorCount > 0 && (
                            <Badge tone="danger">{report.summary.errorCount} error{report.summary.errorCount !== 1 ? 's' : ''}</Badge>
                          )}
                          {report.summary.warningCount > 0 && (
                            <Badge tone="warning">{report.summary.warningCount} warning{report.summary.warningCount !== 1 ? 's' : ''}</Badge>
                          )}
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            {new Date(report.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>

                      {report.issues.length > 0 ? (
                        <Section title="Issues" subtitle="Problems that need attention.">
                          <div className="space-y-2">
                            {report.issues.map((issue, i) => (
                              <div key={`${issue.title}-${i}`} className="flex items-start gap-2 text-xs">
                                <Badge tone={issueTone(issue.severity)}>{issue.severity}</Badge>
                                <div>
                                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{issue.title}</span>
                                  <span className="ml-1 text-zinc-500 dark:text-zinc-400">— {issue.detail}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </Section>
                      ) : (
                        <Section title="Issues" subtitle="Problems that need attention.">
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            All clear. No diagnostic issues detected on this machine.
                          </p>
                        </Section>
                      )}
                    </>
                  )}

                  {activeTab === 'runtimes' && (
                    <Section title="Runtimes" subtitle="Engines and their visible models.">
                      {report.runtimes.length > 0 ? (
                        <div className="space-y-3">
                          {report.runtimes.map((runtime) => (
                            <RuntimeBlock key={runtime.id} runtime={runtime} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-500">No runtimes detected.</p>
                      )}
                    </Section>
                  )}

                  {activeTab === 'commands' && (
                    <Section title="Commands" subtitle="CLI prerequisites for local workflows.">
                      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800/60 dark:border-zinc-800">
                        {report.commands.map((cmd) => (
                          <div key={cmd.id} className="flex items-center justify-between px-3 py-2">
                            <div className="flex items-center gap-2">
                              <SquareTerminal size={13} className="text-zinc-400" />
                              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                {cmd.label}
                              </span>
                              {cmd.version && (
                                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{cmd.version}</span>
                              )}
                            </div>
                            <Badge tone={commandTone(cmd.status)}>{cmd.status}</Badge>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {activeTab === 'integrations' && (
                    <Section title="Integrations" subtitle="App-level tools and optional session capabilities.">
                      <div className="space-y-3">
                        {report.integrations.map((integration) => (
                          <div
                            key={integration.id}
                            className="rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Globe size={13} className="text-zinc-400" />
                                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                    {integration.label}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                                  {integration.summary}
                                </p>
                                {integration.detail && (
                                  <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                                    {integration.detail}
                                  </p>
                                )}
                                {integration.hint && (
                                  <p className="mt-2 text-[11px] text-sky-600 dark:text-sky-400">
                                    {integration.hint}
                                  </p>
                                )}
                              </div>
                              <Badge tone={integrationTone(integration.status)}>
                                {integration.status.replace('_', ' ')}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {activeTab === 'permissions' && (
                    <Section title="Permissions" subtitle="macOS access for media and capture.">
                      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800/60 dark:border-zinc-800">
                        {report.permissions.map((perm) => {
                          const Icon = perm.id === 'camera' ? Camera : perm.id === 'microphone' ? Mic : Monitor
                          const canRequest =
                            perm.requestableInApp
                            && perm.status === 'not-determined'
                            && (perm.id === 'camera' || perm.id === 'microphone')
                          const shouldOpenSettings =
                            perm.status !== 'granted'
                            && (
                              perm.id === 'screen'
                              || perm.status === 'denied'
                              || perm.status === 'restricted'
                              || perm.status === 'unknown'
                            )
                          const actionBusy =
                            perm.id === 'camera'
                              ? requestingCamera || openingPrivacySettings === perm.id
                              : perm.id === 'microphone'
                                ? requestingMicrophone || openingPrivacySettings === perm.id
                                : openingPrivacySettings === perm.id
                          return (
                            <div key={perm.id} className="flex items-center justify-between px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Icon size={13} className="text-zinc-400" />
                                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                  {perm.label}
                                </span>
                                {canRequest ? (
                                  <button
                                    onClick={() => {
                                      if (perm.id === 'camera') {
                                        void handleRequestCameraAccess()
                                        return
                                      }
                                      void handleRequestMicrophoneAccess()
                                    }}
                                    disabled={actionBusy}
                                    className="text-[11px] text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
                                  >
                                    {actionBusy ? 'Requesting...' : 'Request'}
                                  </button>
                                ) : shouldOpenSettings ? (
                                  <button
                                    onClick={() => { void handleOpenPrivacySettings(perm.id) }}
                                    disabled={actionBusy}
                                    className="text-[11px] text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
                                  >
                                    {actionBusy ? 'Opening…' : 'Open Settings'}
                                  </button>
                                ) : null}
                              </div>
                              <Badge tone={permissionTone(perm)}>{formatPermissionStatus(perm.status)}</Badge>
                            </div>
                          )
                        })}
                      </div>
                    </Section>
                  )}

                  {activeTab === 'speech' && (
                    <Section title="Speech" subtitle="Managed whisper.cpp dictation health.">
                      <div className="rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Mic size={13} className="text-zinc-400" />
                              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                {report.speech.providerLabel}
                              </span>
                              <Badge tone={report.speech.healthy ? 'success' : 'warning'}>
                                {report.speech.installState.replace('_', ' ')}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Model: {report.speech.modelLabel}
                            </p>
                            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                              {report.speech.detail}
                            </p>
                            {report.speech.lastError ? (
                              <p className="mt-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                                {report.speech.lastError}
                              </p>
                            ) : null}
                          </div>
                          <div className="shrink-0">
                            <Badge tone={report.speech.enabled ? 'info' : 'neutral'}>
                              {report.speech.enabled ? 'enabled' : 'disabled'}
                            </Badge>
                          </div>
                        </div>

                        {report.speech.recommendedAction && (
                          <div className="mt-3 flex items-center gap-2">
                            {report.speech.recommendedAction === 'request_microphone' ? (
                              <button
                                onClick={() => { void handleRequestMicrophoneAccess() }}
                                disabled={requestingMicrophone}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {requestingMicrophone ? 'Requesting…' : 'Request Microphone'}
                              </button>
                            ) : report.speech.recommendedAction === 'install' ? (
                              <button
                                onClick={() => { void handleInstallSpeech() }}
                                disabled={installingSpeech}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {installingSpeech ? 'Installing…' : 'Install Managed whisper.cpp'}
                              </button>
                            ) : report.speech.recommendedAction === 'repair' ? (
                              <button
                                onClick={() => { void handleRepairSpeech() }}
                                disabled={installingSpeech}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {installingSpeech ? 'Repairing…' : 'Repair Managed whisper.cpp'}
                              </button>
                            ) : (
                              <button
                                onClick={onOpenSettings}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
                              >
                                Open Speech Settings
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </Section>
                  )}

                  {activeTab === 'readAloud' && (
                    <Section title="Read Aloud" subtitle="Kokoro voice output health.">
                      <div className="rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Volume2 size={13} className="text-zinc-400" />
                              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                {report.readAloud.providerLabel}
                              </span>
                              <Badge tone={report.readAloud.healthy ? 'success' : 'warning'}>
                                {formatReadAloudState(report.readAloud.state)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {report.readAloud.modelLabel} · {report.readAloud.dtype} · {report.readAloud.backend}
                            </p>
                            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                              {report.readAloud.detail}
                            </p>
                            {report.readAloud.lastError ? (
                              <p className="mt-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                                {report.readAloud.lastError}
                              </p>
                            ) : null}
                          </div>
                          <div className="shrink-0">
                            <Badge tone={report.readAloud.enabled ? 'info' : 'neutral'}>
                              {report.readAloud.enabled ? 'enabled' : 'disabled'}
                            </Badge>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => { void handleRunReadAloudTest() }}
                            disabled={
                              testingReadAloud
                              || !report.readAloud.enabled
                              || report.readAloud.state === 'installing'
                              || report.readAloud.state === 'loading'
                            }
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {testingReadAloud ? 'Testing…' : 'Run Voice Test'}
                          </button>

                          {(report.readAloud.recommendedAction || !report.readAloud.enabled) && (
                            <button
                              onClick={onOpenVoiceSettings}
                              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                              Open Voice Settings
                            </button>
                          )}
                        </div>
                      </div>
                    </Section>
                  )}

                  {activeTab === 'system' && (
                    <Section title="System">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                          <Cpu size={11} />
                          {report.machine.cpuModel || 'Unknown'} · {report.machine.cpuCount} cores
                        </div>
                        <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                          <HardDrive size={11} />
                          {report.machine.totalMemoryGB} GB RAM
                        </div>
                        <div className="text-zinc-400 dark:text-zinc-500">
                          {report.machine.platform} {report.machine.release} · {report.machine.arch}
                        </div>
                        <div className="text-zinc-400 dark:text-zinc-500">
                          Gemma Desktop v{report.app.version} · Electron {report.app.electron || '?'}
                        </div>
                      </div>
                    </Section>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
