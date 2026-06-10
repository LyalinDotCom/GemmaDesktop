// Live validation of the Gemini Live API contract voice mode depends on:
// connect to the pinned live model, get a send_chat_message tool call for a
// spoken goal, send the tool response plus a [chat_response] update, and
// receive a narrated summary back. The model only supports AUDIO response
// modality, so the narration is asserted through output audio transcription —
// the exact config the renderer session uses.
//
// Run with: npm --workspace gemma-desktop run test:voice-live
// Requires a Gemini API key in GEMMA_DESKTOP_GEMINI_API_KEY or in the app
// settings file (never printed).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai'
import { GEMINI_LIVE_VOICE_MODEL } from '../../src/shared/geminiModels'
import {
  VOICE_LIVE_SEND_TOOL_NAME,
  buildChatAcceptedResult,
  buildChatResponseUpdate,
  buildVoiceLiveSystemInstruction,
  buildVoiceLiveToolDeclarations,
} from '../../src/renderer/src/lib/voiceLivePrompt'

const runVoiceLive = process.env.GEMMA_DESKTOP_RUN_VOICE_LIVE === '1'
const describeLive = runVoiceLive ? describe : describe.skip

function resolveGeminiApiKey(): string {
  const fromEnv = process.env.GEMMA_DESKTOP_GEMINI_API_KEY?.trim()
  if (fromEnv) {
    return fromEnv
  }

  const settingsPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Gemma Desktop',
    'settings.json',
  )
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      integrations?: { geminiApi?: { apiKey?: string } }
    }
    const fromSettings = settings.integrations?.geminiApi?.apiKey?.trim()
    if (fromSettings) {
      return fromSettings
    }
  } catch {
    // fall through to the error below
  }

  throw new Error(
    'Voice live test needs a Gemini API key in GEMMA_DESKTOP_GEMINI_API_KEY or app settings.',
  )
}

interface MessageInbox {
  next: (predicate: (message: LiveServerMessage) => boolean, timeoutMs?: number) => Promise<LiveServerMessage>
  push: (message: LiveServerMessage) => void
  fail: (error: Error) => void
}

function createMessageInbox(): MessageInbox {
  const buffered: LiveServerMessage[] = []
  let waiter: {
    predicate: (message: LiveServerMessage) => boolean
    resolve: (message: LiveServerMessage) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null
  let failure: Error | null = null

  return {
    push(message) {
      if (waiter?.predicate(message)) {
        clearTimeout(waiter.timer)
        const { resolve } = waiter
        waiter = null
        resolve(message)
        return
      }
      buffered.push(message)
    },
    fail(error) {
      failure = error
      if (waiter) {
        clearTimeout(waiter.timer)
        const { reject } = waiter
        waiter = null
        reject(error)
      }
    },
    next(predicate, timeoutMs = 30_000) {
      const bufferedIndex = buffered.findIndex(predicate)
      if (bufferedIndex >= 0) {
        return Promise.resolve(buffered.splice(bufferedIndex, 1)[0]!)
      }
      if (failure) {
        return Promise.reject(failure)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null
          reject(new Error('Timed out waiting for a live server message.'))
        }, timeoutMs)
        waiter = { predicate, resolve, reject, timer }
      })
    },
  }
}

function collectTranscription(message: LiveServerMessage): string {
  return message.serverContent?.outputTranscription?.text ?? ''
}

function hasAudioPart(message: LiveServerMessage): boolean {
  return (message.serverContent?.modelTurn?.parts ?? []).some(
    (part) => Boolean(part.inlineData?.data),
  )
}

describeLive('gemini live voice contract (live)', () => {
  it(
    'delegates a spoken goal to send_chat_message and narrates the chat response',
    { timeout: 120_000 },
    async () => {
      const client = new GoogleGenAI({ apiKey: resolveGeminiApiKey() })
      const inbox = createMessageInbox()

      const session = await client.live.connect({
        model: GEMINI_LIVE_VOICE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildVoiceLiveSystemInstruction({
            surfaceLabel: 'the Assistant Chat conversation',
            modelLabel: 'gemma4:26b',
          }),
          tools: [{ functionDeclarations: buildVoiceLiveToolDeclarations() }],
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => inbox.push(message),
          onerror: (event) => inbox.fail(new Error(String(event?.message ?? 'live error'))),
          onclose: (event) => inbox.fail(new Error(`closed: ${event?.reason ?? 'no reason'}`)),
        },
      })

      try {
        // 1. The user states a goal; the live model must delegate via tool.
        session.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{
              text: 'Please ask the chat model to write a one-line haiku about the sea.',
            }],
          }],
          turnComplete: true,
        })

        const toolCallMessage = await inbox.next(
          (message) => (message.toolCall?.functionCalls?.length ?? 0) > 0,
        )
        const call = toolCallMessage.toolCall!.functionCalls![0]!
        expect(call.name).toBe(VOICE_LIVE_SEND_TOOL_NAME)
        const prompt = String((call.args as { prompt?: unknown } | undefined)?.prompt ?? '')
        expect(prompt.toLowerCase()).toContain('haiku')

        // 2. Acknowledge the tool call the same way the app does.
        session.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name ?? VOICE_LIVE_SEND_TOOL_NAME,
            response: buildChatAcceptedResult() as unknown as Record<string, unknown>,
          }],
        })

        // 3. Deliver the finished chat response; expect narrated audio with a
        // transcription. The model may or may not speak a separate
        // acknowledgement turn first, so accumulate across turn boundaries
        // until narration shows up.
        session.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{
              text: buildChatResponseUpdate(
                'Sea wind hums at dusk —\nsalt light folds over the waves,\nthe tide keeps its word.',
              ),
            }],
          }],
          turnComplete: true,
        })

        let narrated = ''
        let receivedAudio = false
        let completedTurns = 0
        await inbox.next((message) => {
          narrated += collectTranscription(message)
          receivedAudio = receivedAudio || hasAudioPart(message)
          if (!message.serverContent?.turnComplete) {
            return false
          }
          completedTurns += 1
          return narrated.trim().length > 0 || completedTurns >= 2
        }, 90_000)

        expect(receivedAudio).toBe(true)
        expect(narrated.trim().length).toBeGreaterThan(0)
      } finally {
        session.close()
      }
    },
  )
})
