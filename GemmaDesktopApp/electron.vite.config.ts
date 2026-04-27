import { relative, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { PluginOption, ViteDevServer } from 'vite'

const MAIN_PROCESS_EXTERNALS = ['@lydell/node-pty']

function createDevWatchLogger(): PluginOption {
  return {
    name: 'gemma-desktop-dev-watch-logger',
    configureServer(server: ViteDevServer) {
      server.watcher.on('all', (event: string, file: string) => {
        if (file.includes('/node_modules/')) {
          return
        }

        console.log(
          `[vite-watch] ${event} ${relative(process.cwd(), file)}`,
        )
      })
    },
  }
}

export default defineConfig({
  main: {
    // `@lydell/node-pty` lives in optionalDependencies so Electron Vite does
    // not externalize it by default. Keep it as a runtime require so its own
    // platform-specific package loader can resolve the native binary.
    plugins: [externalizeDepsPlugin({ include: MAIN_PROCESS_EXTERNALS })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    server: {
      host: '127.0.0.1',
    },
    preview: {
      host: '127.0.0.1',
    },
    plugins: [
      react(),
      ...(process.env['GEMMA_DESKTOP_LOG_VITE_WATCH'] === '1'
        ? [createDevWatchLogger()]
        : []),
    ],
  },
})
