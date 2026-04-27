import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

function local(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url))
}

export default defineConfig({
  resolve: {
    alias: {
      '@': local('./src/renderer/src'),
      '@shared': local('./src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
