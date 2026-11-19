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
