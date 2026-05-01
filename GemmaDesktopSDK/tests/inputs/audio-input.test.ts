import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "../helpers/mock-server.js";

function createTinyWavBuffer(): Buffer {
  const sampleRate = 16000;
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

describe("audio inputs", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("sends local wav audio to Ollama native chat using message.images for Gemma audio inputs", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-audio-"));
    cleanup.push(async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    });

    const audioPath = path.join(tempDirectory, "sample.wav");
    const wavBytes = createTinyWavBuffer();
    await writeFile(audioPath, wavBytes);

    let capturedBody: Record<string, unknown> | undefined;
    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
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
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createOllamaNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "gemma4:e2b",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [
          { type: "text", text: "Transcribe this clip." },
          { type: "audio_url", url: audioPath, mediaType: "audio/wav" },
        ],
        createdAt: new Date().toISOString(),
      }],
    });

    const nativeMessages = (capturedBody?.messages as Array<Record<string, unknown>>) ?? [];
    expect(nativeMessages).toHaveLength(1);
    expect(nativeMessages[0]?.content).toBe("Transcribe this clip.");
    expect(nativeMessages[0]?.images).toEqual([
      wavBytes.toString("base64"),
    ]);
  });
});

