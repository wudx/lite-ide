import { defineConfig } from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    conditions: ['development', 'browser'],
    dedupe: ['solid-js', 'solid-js/web'],
  },
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'plugins/*/tests/**/*.test.ts',
    ],
    environment: 'jsdom',
    server: {
      deps: {
        inline: [/solid-js/],
      },
    },
  },
})
