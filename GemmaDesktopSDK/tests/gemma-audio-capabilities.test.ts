import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLmStudioOpenAICompatibleAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "./helpers/mock-server.js";

function createTinyWavBuffer(): Buffer {
  const sampleRate = 16_000;
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = bytesPerSample;
  const byteRate = sampleRate * channelCount * bytesPerSample;
  const blockAlign = channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  buffer.writeInt16LE(0, 44);

  return buffer;
}

function collectSystemText(messages: Array<Record<string, unknown>>): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .map((part) => String((part as Record<string, unknown>).text ?? ""))
          .join("\n");
      }
      return "";
    })
    .join("\n");
}

describe("gemma audio capability inference", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("infers Gemma audio support for Ollama when /api/show omits capability flags", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-gemma-audio-"));
    cleanup.push(async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    });

    const audioPath = path.join(tempDirectory, "sample.wav");
    const wavBytes = createTinyWavBuffer();
    await writeFile(audioPath, wavBytes);

    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return { json: { version: "0.6.0" } };
        case "/api/tags":
          return {
            json: {
              models: [{
                name: "gemma4:e2b",
                details: {
                  family: "gemma",
                },
              }],
            },
          };
        case "/api/ps":
          return { json: { models: [] } };
        case "/api/show":
          return { json: {} };
        case "/api/chat":
          capturedBody = request.bodyJson as Record<string, unknown>;
          return {
            json: {
              model: "gemma4:e2b",
              message: {
                role: "assistant",
                content: "Done.",
              },
              done: true,
            },
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createOllamaNativeAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "ollama-native",
      model: "gemma4:e2b",
      mode: "cowork",
    });

    await session.run([
      { type: "text", text: "Transcribe this clip." },
      { type: "audio_url", url: audioPath, mediaType: "audio/wav" },
    ]);

    const messages = (capturedBody?.messages as Array<Record<string, unknown>>) ?? [];
    const systemText = collectSystemText(messages);
    expect(systemText).toContain("supports audio input");
    expect(systemText).toContain("Do not say you need a separate tool just to listen to an attached audio file.");

    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.images).toEqual([wavBytes.toString("base64")]);
  });

  it("infers Gemma audio support for LM Studio OpenAI-compatible models and sends input_audio parts", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-gemma-lmstudio-audio-"));
    cleanup.push(async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    });

    const audioPath = path.join(tempDirectory, "sample.wav");
    const wavBytes = createTinyWavBuffer();
    await writeFile(audioPath, wavBytes);

    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/v1/models":
          return {
            json: {
              data: [{
                id: "google/gemma-4-e2b-it",
                owned_by: "lmstudio",
              }],
            },
          };
        case "/api/v1/models":
          return {
            json: {
              models: [{
                key: "google/gemma-4-e2b-it",
                display_name: "Gemma 4 E2B",
                loaded_instances: [],
                capabilities: {},
              }],
            },
          };
        case "/v1/chat/completions":
          capturedBody = request.bodyJson as Record<string, unknown>;
          return {
            sse: [
              `data: ${JSON.stringify({
                id: "chatcmpl_1",
                choices: [{ index: 0, delta: { content: "Done." } }],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "chatcmpl_1",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
              "data: [DONE]\n\n",
            ],
          };
        default:
          throw new Error(`Unhandled route: ${request.path}`);
      }
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLmStudioOpenAICompatibleAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "lmstudio-openai",
      model: "google/gemma-4-e2b-it",
      mode: "cowork",
    });

    await session.run([
      { type: "text", text: "Transcribe this clip." },
      { type: "audio_url", url: audioPath, mediaType: "audio/wav" },
    ]);

    const messages = (capturedBody?.messages as Array<Record<string, unknown>>) ?? [];
    const systemText = collectSystemText(messages);
    expect(systemText).toContain("supports audio input");
    expect(systemText).toContain("Transcribe, translate, summarize, or analyze attached audio directly when it is present.");

    const userMessage = messages.find((message) => message.role === "user");
    const userParts = Array.isArray(userMessage?.content)
      ? (userMessage.content as Array<Record<string, unknown>>)
      : [];
    expect(userParts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "input_audio",
        input_audio: {
          data: wavBytes.toString("base64"),
          format: "wav",
        },
      }),
    ]));
  });
});
