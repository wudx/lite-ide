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
      '@lite-ide/plugin-explorer > @tanstack/solid-virtual',
      '@lite-ide/plugin-preview-markdown > markdown-it',
      '@lite-ide/plugin-preview-markdown > dompurify',
      '@lite-ide/plugin-preview-code > @codemirror/commands',
      '@lite-ide/plugin-preview-code > @codemirror/language',
      '@lite-ide/plugin-preview-code > @codemirror/language-data',
      '@lite-ide/plugin-preview-code > @codemirror/search',
      '@lite-ide/plugin-preview-code > @codemirror/state',
      '@lite-ide/plugin-preview-code > @codemirror/theme-one-dark',
      '@lite-ide/plugin-preview-code > @codemirror/view',
      '@lite-ide/plugin-preview-code > @lezer/highlight',
    ],
    exclude: [
      '@lite-ide/kernel',
      '@lite-ide/protocol',
      '@lite-ide/workbench',
      '@lite-ide/plugin-explorer',
      '@lite-ide/plugin-preview-code',
      '@lite-ide/plugin-preview-markdown',
      '@lite-ide/plugin-preview-image',
      '@lite-ide/plugin-preview-fallback',
    ],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
