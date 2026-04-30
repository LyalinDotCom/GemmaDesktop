import os from 'node:os'
import path from 'node:path'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createGemmaDesktop,
  type ResearchRunStatus,
  type ResearchSourceFamily,
} from '@gemma-desktop/sdk-node'
import {
  buildResearchAssistantMessage,
  buildResearchLiveActivity,
  buildResearchProgressContent,
} from '../src/main/researchPresentation'
import {
  createLiveRuntimeAdapters,
  withLiveRuntimeModel,
} from './helpers/ollama-live.js'

const itIfLive = process.env.GEMMA_DESKTOP_RUN_APP_LIVE_RESEARCH === '1' ? it : it.skip
const suspiciousOutputPattern = /<channel\|>|```|(?:^|\W)jsonset(?:\W|$)|\bthought:\s/i

interface Scenario {
  id: string
  prompt: string
  minTopics: number
  minSources: number
  minDistinctDomains?: number
  minPasses?: number
  requiredSourceFamilies?: ResearchSourceFamily[]
  maxDurationMs: number
  requiredPlanPatterns: RegExp[]
  requiredReportPatterns: RegExp[]
  requiredSourceGroups: RegExp[][]
}

const SCENARIOS: Scenario[] = [
  {
    id: 'iran-news-mainstream',
    prompt:
      'Please go look at the top news websites like Fox, CNN, BBC, AP, Reuters, and a few others. See what news on there is about Iran, read the latest stories and what is on the front page, and give me a report with concrete dates plus where the outlets agree or differ.',
    minTopics: 3,
    minSources: 8,
    minDistinctDomains: 5,
    minPasses: 2,
    requiredSourceFamilies: ['mainstream_front_page', 'mainstream_article'],
    maxDurationMs: 240_000,
    requiredPlanPatterns: [/front page|headlines/i, /mainstream article|coverage/i, /wire|official|community/i],
    requiredReportPatterns: [/Iran/i, /front page|headline|latest story/i, /agree|disagree|consensus|divergence/i, /\b(?:April|March|2026|2025)\b/i],
    requiredSourceGroups: [
      [/(?:foxnews\.com|cnn\.com|bbc\.com|apnews\.com|reuters\.com|abcnews(?:\.go)?\.com|cbsnews\.com|npr\.org)/i],
    ],
  },
  {
    id: 'artemis-news',
    prompt:
      'Go research news on Artemis mission and give me a full update. Check NASA sites, mainstream news sites, Reddit, and call out the latest concrete dates.',
    minTopics: 3,
    minSources: 5,
    minDistinctDomains: 4,
    minPasses: 2,
    requiredSourceFamilies: ['official', 'mainstream_article', 'community'],
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official|nasa/i, /news|coverage/i, /community|reddit|sentiment/i],
    requiredReportPatterns: [/Artemis/i, /NASA/i, /\b(?:April|March|2026|2025)\b/i],
    requiredSourceGroups: [
      [/nasa\.gov/i],
      [/(?:space\.com|reuters\.com|apnews\.com|bbc\.com|cnn\.com|nytimes\.com|theverge\.com|arstechnica\.com|abcnews\.com|cbc\.ca|independent\.co\.uk)/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com|forum|discuss)/i],
    ],
  },
  {
    id: 'gemma-catalog',
    prompt:
      'Research all the currently relevant Gemma model versions and types across official Google sources, Hugging Face, Ollama, and LM Studio. I want a clear catalog of versions, sources, and packaging surfaces.',
    minTopics: 4,
    minSources: 5,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official/i, /Hugging Face/i, /Ollama/i, /LM Studio/i],
    requiredReportPatterns: [/Gemma/i, /version|variant|type|source|package/i],
    requiredSourceGroups: [
      [/(?:deepmind\.google|github\.com\/google-deepmind|ai\.google\.dev)/i],
      [/huggingface\.co/i],
      [/ollama\.com/i],
      [/lmstudio\.ai/i],
    ],
  },
  {
    id: 'local-inference-macos',
    prompt:
      'Research Ollama vs LM Studio vs llama.cpp on macOS today. Use official docs, release notes, GitHub issues, and Reddit or HN discussion. Focus on what matters for developers shipping local AI apps.',
    minTopics: 3,
    minSources: 5,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/Ollama/i, /LM Studio/i, /llama\.cpp/i],
    requiredReportPatterns: [/Ollama/i, /LM Studio/i, /llama\.cpp/i, /macOS|Apple Silicon|developer/i],
    requiredSourceGroups: [
      [/ollama\.com/i],
      [/lmstudio\.ai/i],
      [/(?:github\.com\/ggerganov\/llama\.cpp|llama\.cpp)/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com|github\.com)/i],
    ],
  },
  {
    id: 'react-19-adoption',
    prompt:
      'Research current React 19 adoption and ecosystem updates. Check official React docs, major framework or tooling posts, GitHub or release notes, and Reddit or HN community reaction.',
    minTopics: 3,
    minSources: 4,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official|react/i, /framework|tooling|adoption/i, /community|reddit|hn/i],
    requiredReportPatterns: [/React 19/i, /ecosystem|framework|community|adoption/i],
    requiredSourceGroups: [
      [/(?:react\.dev|reactjs\.org)/i],
      [/(?:github\.com|nextjs\.org|vercel\.com|vite\.dev|remix\.run)/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com)/i],
    ],
  },
  {
    id: 'rust-2024-adoption',
    prompt:
      'Research Rust 2024 edition adoption and the most important current tooling updates. Include official Rust sources, ecosystem blog posts or release notes, and community discussion.',
    minTopics: 3,
    minSources: 4,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official|rust/i, /tooling|adoption|ecosystem/i, /community/i],
    requiredReportPatterns: [/Rust 2024/i, /tooling|edition|community|ecosystem/i],
    requiredSourceGroups: [
      [/(?:rust-lang\.org|blog\.rust-lang\.org)/i],
      [/(?:github\.com|docs\.rs|crates\.io|tokio\.rs)/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com)/i],
    ],
  },
  {
    id: 'mcp-adoption',
    prompt:
      'Research current Model Context Protocol adoption. Check the official MCP spec or docs, major vendor announcements or implementations, GitHub activity, and community discussion.',
    minTopics: 3,
    minSources: 4,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official|spec|protocol/i, /vendor|implementation|github/i, /community/i],
    requiredReportPatterns: [/Model Context Protocol|MCP/i, /spec|implementation|community|adoption/i],
    requiredSourceGroups: [
      [/(?:modelcontextprotocol\.io|docs\.anthropic\.com|anthropic\.com)/i],
      [/github\.com/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com)/i],
    ],
  },
  {
    id: 'apple-m5-reviews',
    prompt:
      'Research Apple M5 Pro and M5 Max MacBook Pro coverage. Check Apple official pages, major review sites, and Reddit owner impressions. Focus on performance, battery, and developer relevance.',
    minTopics: 3,
    minSources: 4,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/Apple|official/i, /review|coverage|performance/i, /community|reddit/i],
    requiredReportPatterns: [/M5/i, /battery|performance|developer|review/i],
    requiredSourceGroups: [
      [/apple\.com/i],
      [/(?:theverge\.com|arstechnica\.com|anandtech\.com|tomshardware\.com|engadget\.com|wired\.com|cnet\.com|macworld\.com|appleinsider\.com|macrumors\.com|macobserver\.com|pcmag\.com)/i],
      [/(?:reddit\.com|hn\.algolia\.com)/i],
    ],
  },
  {
    id: 'pytorch-mps-macos',
    prompt:
      'Research the current state of PyTorch MPS and Apple Silicon local inference on macOS. Include official PyTorch docs, Apple developer docs, GitHub issues, and community discussion.',
    minTopics: 3,
    minSources: 4,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/PyTorch|Apple/i, /docs|official/i, /github|community/i],
    requiredReportPatterns: [/PyTorch/i, /MPS|Apple Silicon|macOS/i],
    requiredSourceGroups: [
      [/pytorch\.org/i],
      [/developer\.apple\.com/i],
      [/github\.com/i],
      [/(?:reddit\.com|news\.ycombinator\.com|hn\.algolia\.com)/i],
    ],
  },
  {
    id: 'qwen-catalog',
    prompt:
      'Research the current Qwen model family across official sources, Hugging Face, Ollama, and LM Studio. I want versions, types, source surfaces, and packaging notes.',
    minTopics: 4,
    minSources: 5,
    maxDurationMs: 180_000,
    requiredPlanPatterns: [/official/i, /Hugging Face/i, /Ollama/i, /LM Studio/i],
    requiredReportPatterns: [/Qwen/i, /version|type|source|package/i],
    requiredSourceGroups: [
      [/(?:qwenlm\.github\.io|github\.com\/QwenLM|alibaba)/i],
      [/huggingface\.co/i],
      [/ollama\.com/i],
      [/lmstudio\.ai/i],
    ],
  },
]

function configuredEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function resolveConfiguredRuntime(): string {
  return configuredEnvValue(
    'GEMMA_DESKTOP_RESEARCH_RUNTIME_ID',
    'GEMMA_DESKTOP_LIVE_RUNTIME_ID',
  ) ?? 'ollama-native'
}

function resolveConfiguredModel(): string {
  return configuredEnvValue(
    'GEMMA_DESKTOP_RESEARCH_MODEL_ID',
    'GEMMA_DESKTOP_LIVE_MODEL_ID',
  ) ?? 'gemma4:26b'
}

function shouldRunScenario(id: string): boolean {
  const raw = process.env.GEMMA_DESKTOP_APP_RESEARCH_SCENARIOS?.trim()
  if (!raw) {
    return true
  }
  const allowed = new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  return allowed.has(id)
}

function createAppSessionMetadata(runtimeId: string): Record<string, unknown> {
  return {
    gemmaDesktopApp: {
      conversationKind: 'research',
      baseMode: 'explore',
      preferredRuntimeId: runtimeId,
      selectedSkillIds: [],
      selectedSkillNames: [],
      selectedToolIds: [],
      selectedToolNames: [],
    },
    requestPreferences: {
      reasoningMode: 'auto',
    },
  }
}

function firstTextBlockText(blocks: Array<Record<string, unknown>>): string {
  const panelBlock = blocks.find((block) => block.type === 'research_panel')
  const panel =
    panelBlock && typeof panelBlock === 'object' && 'panel' in panelBlock
      ? (panelBlock as { panel: Record<string, unknown> }).panel
      : undefined
  if (panel) {
    const stage = typeof panel.stage === 'string' ? panel.stage : ''
    const sourcesLabel =
      panel.sources && typeof panel.sources === 'object' && 'label' in panel.sources
        ? String((panel.sources as { label: string }).label)
        : ''
    const liveHint = typeof panel.liveHint === 'string' ? panel.liveHint : ''
    return [stage, sourcesLabel, liveHint].filter((entry) => entry.length > 0).join(' | ')
  }
  const textBlock = blocks.find((block) => block.type === 'text')
  return typeof textBlock?.text === 'string' ? textBlock.text : ''
}

function summarizeSourceUrls(urls: string[]): string[] {
  return urls.map((url) => {
    try {
      const parsed = new URL(url)
      return `${parsed.hostname}${parsed.pathname}`
    } catch {
      return url
    }
  })
}

function distinctDomains(urls: string[]): string[] {
  return [...new Set(urls.map((url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }))]
}

describe.sequential('app live deep research harness', () => {
  itIfLive(
    'runs app-style research scenarios sequentially and writes scenario diagnostics',
    async () => {
      const runtimeId = resolveConfiguredRuntime()
      const modelId = resolveConfiguredModel()
      const scenarios = SCENARIOS.filter((scenario) => shouldRunScenario(scenario.id))
      const adapters = createLiveRuntimeAdapters()

      expect(scenarios.length).toBeGreaterThan(0)

      await withLiveRuntimeModel({ runtimeId, modelId, adapters }, async () => {
        const harnessRoot = await mkdtemp(
          path.join(os.tmpdir(), 'gemma-desktop-app-live-research-'),
        )
        const resultsDirectory = path.join(harnessRoot, 'results')
        await mkdir(resultsDirectory, { recursive: true })

        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory: harnessRoot,
          adapters,
        })
        const environment = await gemmaDesktop.inspectEnvironment()
        const runtime = environment.runtimes.find((entry) => entry.runtime.id === runtimeId)
        const model = runtime?.models.find((entry) => entry.id === modelId)

        expect(
          runtime,
          `Runtime "${runtimeId}" was not available. Found: ${environment.runtimes.map((entry) => entry.runtime.id).join(', ')}`,
        ).toBeDefined()
        expect(
          model,
          `Model "${modelId}" was not available on runtime "${runtimeId}". Found: ${runtime?.models.map((entry) => entry.id).join(', ') ?? 'none'}`,
        ).toBeDefined()

        const diagnostics: Array<Record<string, unknown>> = []

        for (const scenario of scenarios) {
          const workingDirectory = path.join(harnessRoot, scenario.id)
          await mkdir(workingDirectory, { recursive: true })

          const session = await gemmaDesktop.sessions.create({
            runtime: runtimeId,
            model: modelId,
            mode: 'cowork',
            workingDirectory,
            metadata: createAppSessionMetadata(runtimeId),
          })

          let latestStatus: ResearchRunStatus | undefined
          let lastProgressLine = ''
          const statusHistory: ResearchRunStatus[] = []
          const startedAt = Date.now()

          console.log(`[app-live-research] starting ${scenario.id}`)

          let result
          try {
            result = await session.runResearch(scenario.prompt, {
              profile: 'deep',
              onStatus: async (status) => {
                latestStatus = status
                statusHistory.push(status)
                const blocks = buildResearchProgressContent(status)
                const liveActivity = buildResearchLiveActivity(status)
                const progressLine = firstTextBlockText(blocks)
                if (progressLine && progressLine !== lastProgressLine) {
                  lastProgressLine = progressLine
                  console.log(
                    `[app-live-research] ${scenario.id} progress: ${progressLine.replace(/\n/g, ' | ')}`,
                  )
                }
                expect(blocks.length).toBeGreaterThanOrEqual(1)
                expect(blocks[0]?.type).toBe('research_panel')
                expect(
                  liveActivity == null || liveActivity.source === 'research',
                ).toBe(true)
              },
            })
          } catch (error) {
            try {
              const researchRunsDirectory = path.join(
                workingDirectory,
                '.gemma',
                'research',
              )
              const runIds = await readdir(researchRunsDirectory)
              const latestRunId = runIds.sort().at(-1)
              if (latestRunId) {
                const latestStatusText = await readFile(
                  path.join(researchRunsDirectory, latestRunId, 'status.json'),
                  'utf8',
                )
                console.log(`[app-live-research] ${scenario.id} latestStatus: ${latestStatusText}`)
              }
            } catch {
              // Best-effort diagnostics only.
            }
            throw error
          }

          const durationMs = Math.max(Date.now() - startedAt, 1)
          const assistantMessage = buildResearchAssistantMessage(result, durationMs)
          const finalReportText = await readFile(
            path.join(result.artifactDirectory, 'final', 'report.md'),
            'utf8',
          )
          const planText = await readFile(
            path.join(result.artifactDirectory, 'plan.json'),
            'utf8',
          )
          const sourceIndexText = await readFile(
            path.join(result.artifactDirectory, 'sources', 'index.json'),
            'utf8',
          )
          const sourceUrls = result.sources.map((source) => source.resolvedUrl || source.requestedUrl)
          const summarizedUrls = summarizeSourceUrls(sourceUrls)
          const domains = distinctDomains(sourceUrls)
          const gatheredFamilies = [...new Set(
            result.sources
              .map((source) => source.sourceFamily)
              .filter((family): family is ResearchSourceFamily => typeof family === 'string' && family.length > 0),
          )]

          const failures: string[] = []
          if (durationMs > scenario.maxDurationMs) {
            failures.push(
              `Run exceeded ${scenario.maxDurationMs}ms budget: actual ${durationMs}ms.`,
            )
          }
          if (result.plan.topics.length < scenario.minTopics) {
            failures.push(
              `Expected at least ${scenario.minTopics} topics, got ${result.plan.topics.length}.`,
            )
          }
          if (result.sources.length < scenario.minSources) {
            failures.push(
              `Expected at least ${scenario.minSources} sources, got ${result.sources.length}.`,
            )
          }
          if ((scenario.minDistinctDomains ?? 0) > domains.length) {
            failures.push(
              `Expected at least ${scenario.minDistinctDomains} distinct domains, got ${domains.length}.`,
            )
          }
          if ((scenario.minPasses ?? 0) > (result.passCount ?? 0)) {
            failures.push(
              `Expected at least ${scenario.minPasses} gather passes, got ${result.passCount ?? 0}.`,
            )
          }
          for (const family of scenario.requiredSourceFamilies ?? []) {
            if (!gatheredFamilies.includes(family)) {
              failures.push(`Missing required gathered source family ${family}.`)
            }
          }
          if (statusHistory.length === 0) {
            failures.push('Expected at least one onStatus update from the app-style run.')
          }
          if (assistantMessage.content.length < 2) {
            failures.push('Expected the app assistant message to contain report text and artifacts link.')
          }
          if (suspiciousOutputPattern.test(result.summary) || suspiciousOutputPattern.test(result.finalReport)) {
            failures.push('Report contained suspicious structured-output leakage.')
          }
          for (const pattern of scenario.requiredPlanPatterns) {
            if (!pattern.test(planText)) {
              failures.push(`Plan did not match required pattern ${pattern}.`)
            }
          }
          for (const pattern of scenario.requiredReportPatterns) {
            if (!pattern.test(finalReportText)) {
              failures.push(`Final report did not match required pattern ${pattern}.`)
            }
          }
          for (const group of scenario.requiredSourceGroups) {
            if (!sourceUrls.some((url) => group.some((pattern) => pattern.test(url)))) {
              failures.push(
                `Sources did not satisfy required source group: ${group.map((pattern) => pattern.toString()).join(' or ')}.`,
              )
            }
          }
          if (suspiciousOutputPattern.test(finalReportText)) {
            failures.push('Persisted final report contained suspicious structured-output leakage.')
          }
          if (suspiciousOutputPattern.test(sourceIndexText)) {
            failures.push('Source index contained suspicious structured-output leakage.')
          }

          const scenarioDiagnostic = {
            id: scenario.id,
            prompt: scenario.prompt,
            runtimeId,
            modelId,
            durationMs,
            topicCount: result.plan.topics.length,
            sourceCount: result.sources.length,
            passCount: result.passCount ?? null,
            distinctDomainCount: domains.length,
            sourceFamilies: gatheredFamilies,
            summary: result.summary,
            artifactDirectory: result.artifactDirectory,
            sourceUrls: summarizedUrls,
            lastStage: latestStatus?.stage ?? null,
            statusUpdateCount: statusHistory.length,
            failures,
          }
          diagnostics.push(scenarioDiagnostic)

          await writeFile(
            path.join(resultsDirectory, `${scenario.id}.json`),
            `${JSON.stringify(scenarioDiagnostic, null, 2)}\n`,
            'utf8',
          )

          console.log(
            `[app-live-research] completed ${scenario.id} in ${durationMs}ms with ${result.plan.topics.length} topics and ${result.sources.length} sources`,
          )

          expect(failures).toEqual([])
        }

        await writeFile(
          path.join(resultsDirectory, 'summary.json'),
          `${JSON.stringify({
            runtimeId,
            modelId,
            harnessRoot,
            scenarioCount: diagnostics.length,
            diagnostics,
          }, null, 2)}\n`,
          'utf8',
        )

        console.log('[app-live-research] harnessRoot:', harnessRoot)
      })
    },
    45 * 60_000,
  )
})
