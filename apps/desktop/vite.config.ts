import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  resolve: {
    dedupe: ['solid-js', 'solid-js/web'],
  },
  optimizeDeps: {
    // Third-party deps owned by workspace-linked packages (excluded below) are
    // not resolvable from the Vite root (pnpm strict layout), so entries use the
    // "owner > dep" syntax. Pre-bundling them at server start avoids vite's
    // runtime dep-discovery, which force-reloads the page and wipes in-memory
    // UI state (first previewer open in a cold dev session / flaky e2e).
    include: [
      '@lite-ide/protocol > @tauri-apps/api/core',
      '@lite-ide/protocol > @tauri-apps/api/window',
      '@lite-ide/protocol > @tauri-apps/plugin-dialog',
    ],
    exclude: ['@lite-ide/kernel', '@lite-ide/protocol', '@lite-ide/workbench'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
