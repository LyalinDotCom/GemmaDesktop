import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGemmaDesktop } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { createLmStudioNativeAdapter } from "@gemma-desktop/sdk-runtime-lmstudio";
import { createOllamaNativeAdapter } from "@gemma-desktop/sdk-runtime-ollama";
import { createMockServer } from "../helpers/mock-server.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k0uoAAAAASUVORK5CYII=";
const execFileAsync = promisify(execFile);
const itIfDarwin = process.platform === "darwin" ? it : it.skip;

async function createImageFixture(cleanup: Array<() => Promise<void>>): Promise<{ directory: string; imagePath: string }> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-image-"));
  cleanup.push(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await mkdir(tempDirectory, { recursive: true });
  const imagePath = path.join(tempDirectory, "capture.png");
  await writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  return { directory: tempDirectory, imagePath };
}

async function createLargeImageFixture(
  cleanup: Array<() => Promise<void>>,
): Promise<{ directory: string; imagePath: string; largeImagePath: string }> {
  const fixture = await createImageFixture(cleanup);
  const largeImagePath = path.join(fixture.directory, "capture-large.png");
  await execFileAsync("sips", ["-z", "3200", "2800", fixture.imagePath, "--out", largeImagePath]);
  return {
    ...fixture,
    largeImagePath,
  };
}

function extractBase64Payload(dataUrl: string): string {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error(`Expected an image data URL, received: ${dataUrl.slice(0, 32)}`);
  }
  return match[1];
}

async function imageLongEdge(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath]);
  const width = Number(/pixelWidth:\s+(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s+(\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Unable to read image dimensions for ${filePath}`);
  }
  return Math.max(width, height);
}

describe("image inputs", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("converts local image paths into data URLs for openai-compatible requests", async () => {
    const { imagePath } = await createImageFixture(cleanup);

    const requests: Array<Record<string, unknown>> = [];
    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "img_1",
              choices: [{ index: 0, delta: { content: "Looks like an image." } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "img_1",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "minimal",
    });

    const result = await session.run([
      { type: "text", text: "What do you see?" },
      { type: "image_url", url: imagePath },
    ]);

    expect(result.text).toContain("image");
    const sentMessages = (requests[0]?.messages as Array<Record<string, unknown>>) ?? [];
    const userMessage = sentMessages.find((message) => message.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const imagePart = (userMessage?.content as Array<Record<string, unknown>>).find(
      (part) => part.type === "image_url",
    );
    expect(
      (imagePart?.image_url as Record<string, unknown> | undefined)?.url,
    ).toMatch(/^data:image\/png;base64,/);
  });

  it("sends multiple local images to Ollama native chat using message.images", async () => {
    const { imagePath } = await createImageFixture(cleanup);
    let capturedBody: Record<string, unknown> | undefined;

    const server = await createMockServer((request) => {
      if (request.path === "/api/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            model: "llama3.2-vision",
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
      model: "llama3.2-vision",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [
          { type: "text", text: "Compare these two images." },
          { type: "image_url", url: imagePath },
          { type: "image_url", url: imagePath },
        ],
        createdAt: new Date().toISOString(),
      }],
    });

    const nativeMessages = (capturedBody?.messages as Array<Record<string, unknown>>) ?? [];
    expect(nativeMessages).toHaveLength(1);
    expect(nativeMessages[0]?.content).toBe("Compare these two images.");
    expect(nativeMessages[0]?.images).toEqual([
      ONE_BY_ONE_PNG_BASE64,
      ONE_BY_ONE_PNG_BASE64,
    ]);
  });

  it("serializes multiple local images for LM Studio native chat as multimodal blocks", async () => {
    const { imagePath } = await createImageFixture(cleanup);
    let capturedBody: Record<string, unknown> | undefined;

    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          json: {
            response_id: "resp_1",
            output: [{ type: "message", content: "Done." }],
          },
        };
      }
      if (request.path === "/api/v1/models") {
        return { json: { models: [] } };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const adapter = createLmStudioNativeAdapter({ baseUrl: server.url });
    await adapter.generate({
      model: "mock-model",
      messages: [{
        id: "msg_1",
        role: "user",
        content: [
          { type: "text", text: "Compare these two images." },
          { type: "image_url", url: imagePath },
          { type: "image_url", url: imagePath },
        ],
        createdAt: new Date().toISOString(),
      }],
    });

    const input = (capturedBody?.input as Array<Record<string, unknown>>) ?? [];
    expect(input).toEqual([
      { type: "message", content: "user: Compare these two images." },
      { type: "image", data_url: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}` },
      { type: "image", data_url: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}` },
    ]);
  });

  it("injects vision-aware bootstrap instructions for Ollama native image turns", async () => {
    const { imagePath } = await createImageFixture(cleanup);
    let capturedBody: Record<string, unknown> | undefined;

    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return { json: { version: "0.6.0" } };
        case "/api/tags":
          return {
            json: {
              models: [
                {
                  name: "llama3.2-vision",
                  details: {
                    family: "llama",
                  },
                },
              ],
            },
          };
        case "/api/ps":
          return { json: { models: [] } };
        case "/api/show":
          return {
            json: {
              capabilities: ["completion", "vision"],
            },
          };
        case "/api/chat":
          capturedBody = request.bodyJson as Record<string, unknown>;
          return {
            json: {
              model: "llama3.2-vision",
              message: {
                role: "assistant",
                content: "I can see the image.",
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
      model: "llama3.2-vision",
      mode: "cowork",
    });

    await session.run([
      { type: "text", text: "Describe this image." },
      { type: "image_url", url: imagePath },
    ]);

    const messages = (capturedBody?.messages as Array<Record<string, unknown>>) ?? [];
    const systemMessage = messages.find((message) => message.role === "system");
    const systemText = String(systemMessage?.content ?? "");
    expect(systemText).toContain("supports image input");
    expect(systemText).toContain("Do not say you need a separate tool just to look at an attached image.");

    const debug = gemmaDesktop.describeSession(session.snapshot());
    expect(debug.systemPromptSections.some((section) => section.source === "capabilities")).toBe(true);
  });

  it("injects vision-aware bootstrap instructions for LM Studio native image turns", async () => {
    const { imagePath } = await createImageFixture(cleanup);
    let capturedBody: Record<string, unknown> | undefined;

    const server = await createMockServer((request) => {
      if (request.path === "/api/v1/models") {
        return {
          json: {
            models: [
              {
                key: "vision-model",
                type: "llm",
                capabilities: {
                  vision: true,
                  trained_for_tool_use: true,
                },
                loaded_instances: [],
              },
            ],
          },
        };
      }
      if (request.path === "/api/v1/chat") {
        capturedBody = request.bodyJson as Record<string, unknown>;
        return {
          sse: [
            'event: message.delta\ndata: {"type":"message.delta","content":"I can see the image."}\n\n',
            'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_vision","output":[{"type":"message","content":"I can see the image."}]}}\n\n',
          ],
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLmStudioNativeAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "lmstudio-native",
      model: "vision-model",
      mode: "cowork",
    });

    await session.run([
      { type: "text", text: "Describe this image." },
      { type: "image_url", url: imagePath },
    ]);

    const input = (capturedBody?.input as Array<Record<string, unknown>>) ?? [];
    const systemEntry = input.find(
      (entry) =>
        entry.type === "message"
        && typeof entry.content === "string"
        && entry.content.startsWith("system: "),
    );
    const systemText = String(systemEntry?.content ?? "");
    expect(systemText).toContain("supports image input");
    expect(systemText).toContain("Do not say you need a separate tool just to look at an attached image.");
  });

  it("fails fast when a known non-vision model receives an image turn", async () => {
    const { imagePath } = await createImageFixture(cleanup);
    let chatCallCount = 0;

    const server = await createMockServer((request) => {
      switch (request.path) {
        case "/api/version":
          return { json: { version: "0.6.0" } };
        case "/api/tags":
          return {
            json: {
              models: [
                {
                  name: "llama3.2-text",
                  details: {
                    family: "llama",
                  },
                },
              ],
            },
          };
        case "/api/ps":
          return { json: { models: [] } };
        case "/api/show":
          return {
            json: {
              capabilities: ["completion"],
            },
          };
        case "/api/chat":
          chatCallCount += 1;
          return {
            json: {
              model: "llama3.2-text",
              message: {
                role: "assistant",
                content: "Unexpected.",
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
      model: "llama3.2-text",
      mode: "cowork",
    });

    await expect(session.run([
      { type: "text", text: "Describe this image." },
      { type: "image_url", url: imagePath },
    ])).rejects.toMatchObject({
      kind: "capability_unsupported",
    });
    expect(chatCallCount).toBe(0);
  });

  itIfDarwin("downscales oversized local images before openai-compatible transport", async () => {
    const { directory, largeImagePath } = await createLargeImageFixture(cleanup);
    const requests: Array<Record<string, unknown>> = [];

    const server = await createMockServer((request) => {
      if (request.path === "/health") {
        return { status: 200, text: "ok" };
      }
      if (request.path === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }
      if (request.path === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        return {
          sse: [
            `data: ${JSON.stringify({
              id: "img_2",
              choices: [{ index: 0, delta: { content: "Looks resized." } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "img_2",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const gemmaDesktop = await createGemmaDesktop({
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });

    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "minimal",
    });

    await session.run([
      { type: "text", text: "What do you see?" },
      { type: "image_url", url: largeImagePath },
    ]);

    const sentMessages = (requests[0]?.messages as Array<Record<string, unknown>>) ?? [];
    const userMessage = sentMessages.find((message) => message.role === "user");
    const imagePart = (userMessage?.content as Array<Record<string, unknown>>).find(
      (part) => part.type === "image_url",
    ) as Record<string, unknown> | undefined;
    const preparedDataUrl = (imagePart?.image_url as Record<string, unknown> | undefined)?.url;
    expect(typeof preparedDataUrl).toBe("string");

    const preparedPath = path.join(directory, "prepared.png");
    await writeFile(preparedPath, Buffer.from(extractBase64Payload(String(preparedDataUrl)), "base64"));
    expect(await imageLongEdge(preparedPath)).toBeLessThanOrEqual(2048);
  });
});
