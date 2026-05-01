import { describe, expect, it } from "vitest";
import {
  DESKTOP_PARITY_DEFAULT_ENDPOINTS,
  DESKTOP_PARITY_RUNTIME_ADAPTER_IDS,
  createDesktopParityRuntimeAdapters,
  describeDesktopParityRuntimeConfig,
  resolveDefaultPrimaryModelIdForMemory,
} from "../../src/desktopParity.js";

describe("desktop parity runtime setup", () => {
  it("creates runtime adapters in the same order as the desktop app", () => {
    const adapters = createDesktopParityRuntimeAdapters();

    expect(adapters.map((adapter) => adapter.identity.id)).toEqual(
      [...DESKTOP_PARITY_RUNTIME_ADAPTER_IDS],
    );
  });

  it("uses desktop default runtime endpoints unless the CLI overrides them", () => {
    expect(describeDesktopParityRuntimeConfig()).toEqual({
      endpoints: DESKTOP_PARITY_DEFAULT_ENDPOINTS,
      adapterIds: [...DESKTOP_PARITY_RUNTIME_ADAPTER_IDS],
    });

    expect(describeDesktopParityRuntimeConfig({
      ollama: "http://localhost:11435",
      lmstudio: "http://localhost:1235",
      llamacpp: "http://localhost:8081",
      omlx: "http://localhost:8001",
    }).endpoints).toEqual({
      ollama: "http://localhost:11435",
      lmstudio: "http://localhost:1235",
      llamacpp: "http://localhost:8081",
      omlx: "http://localhost:8001",
    });
  });

  it("mirrors the desktop default primary model memory split", () => {
    expect(resolveDefaultPrimaryModelIdForMemory(16 * 1024 ** 3)).toBe("gemma4:26b");
    expect(resolveDefaultPrimaryModelIdForMemory(64 * 1024 ** 3)).toBe("gemma4:31b");
  });
});
