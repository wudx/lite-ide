import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Bundle-format plugin build: CommonJS files whose host-provided dependencies
// (solid-js, workspace packages, the `liteide` host API) stay external and are
// injected by the plugin loader's require table at evaluation time.
// Two deliberately disjoint entries — main (plugin.js) and the lazily-loaded
// xlsx parser (xlsx.js, evaluated via liteide.loadChunk on first decode).
// Entries must not share internal modules, or rollup emits shared chunks the
// host cannot resolve.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // Bundle 插件的依赖（如 @tanstack/solid-virtual）会引用 process.env.NODE_ENV`
  // 做调试开关；lib 模式不做自动替换，须显式 define 成生产值。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: {
        main: 'src/index.ts',
        xlsx: 'src/xlsx-entry.ts',
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => (entryName === 'main' ? 'plugin.js' : 'xlsx.js'),
      cssFileName: 'plugin',
    },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      external: [/^solid-js/, /^@lite-ide\//, /^liteide$/],
      output: { exports: 'named' },
    },
  },
})
