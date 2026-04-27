import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function local(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@gemma-desktop/sdk-core": local("./packages/sdk-core/src/index.ts"),
      "@gemma-desktop/sdk-tools": local("./packages/sdk-tools/src/index.ts"),
      "@gemma-desktop/sdk-harness": local("./packages/sdk-harness/src/index.ts"),
      "@gemma-desktop/sdk-runtime-ollama": local("./packages/sdk-runtime-ollama/src/index.ts"),
      "@gemma-desktop/sdk-runtime-lmstudio": local("./packages/sdk-runtime-lmstudio/src/index.ts"),
      "@gemma-desktop/sdk-runtime-llamacpp": local("./packages/sdk-runtime-llamacpp/src/index.ts"),
      "@gemma-desktop/sdk-node": local("./packages/sdk-node/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
