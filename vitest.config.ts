import { defineConfig } from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    conditions: ['development', 'browser'],
    dedupe: ['solid-js', 'solid-js/web'],
    // `liteide` 是插件求值期的宿主注入模块（见 plugin-host.ts），bundle 外
    // 不可解析；单测引用插件源码时指到测试桩（loadChunk 返回真实 xlsx）。
    alias: {
      liteide: fileURLToPath(new URL('./vitest.liteide-stub.ts', import.meta.url)),
    },
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
