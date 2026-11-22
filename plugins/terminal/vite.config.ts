import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Bundle-format plugin build: CommonJS single file whose host-provided
// dependencies (solid-js, workspace packages, the `liteide` host API) stay
// external and are injected by the plugin loader's require table. xterm and
// the fit addon travel inside the bundle (they are plugin-private, not host
// shared modules).
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // Bundle 插件的依赖会引用 process.env.NODE_ENV 做调试开关；lib 模式不做
  // 自动替换，须显式 define 成生产值。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: { main: 'src/index.ts' },
      formats: ['cjs'],
      fileName: () => 'plugin.js',
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
