import http from "node:http";

export interface MockRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  bodyJson?: unknown;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  sse?: string[];
}

function maybeParseJson(bodyText: string): unknown {
  if (bodyText.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

export async function createMockServer(
  handler: (request: MockRequest) => Promise<MockResponse> | MockResponse,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk, "utf8"));
          continue;
        }
        chunks.push(chunk as Buffer<ArrayBufferLike>);
      }
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const path = request.url ?? "/";
      const mockRequest: MockRequest = {
        method: request.method ?? "GET",
        path,
        headers: request.headers,
        bodyText,
        bodyJson: maybeParseJson(bodyText),
      };

      const mockResponse = await handler(mockRequest);
      response.statusCode = mockResponse.status ?? 200;
      for (const [key, value] of Object.entries(mockResponse.headers ?? {})) {
        response.setHeader(key, value);
      }

      if (mockResponse.sse) {
        response.setHeader("content-type", "text/event-stream");
        for (const frame of mockResponse.sse) {
          response.write(frame);
        }
        response.end();
        return;
      }

      if (mockResponse.json !== undefined) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(mockResponse.json));
        return;
      }

      response.end(mockResponse.text ?? "");
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "Mock server error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
