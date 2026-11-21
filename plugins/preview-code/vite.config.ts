import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Bundle-format plugin build: single CommonJS file whose host-provided
// dependencies (solid-js, workspace packages) stay external and are injected
// by the plugin loader's require table at evaluation time.
// Single entry: rollup must not emit shared chunks — the host cannot resolve
// relative requires between plugin files. CodeMirror（含 language-data 的全部
// 语言包）随之打进单文件：不能拆 chunk，否则 EditorState 等核心模块会在主包
// 与 chunk 各持一份，破坏实例一致性。
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // Bundle 插件的依赖会引用 process.env.NODE_ENV 做调试开关；lib 模式不做
  // 自动替换，须显式 define 成生产值。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/index.ts',
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
      output: {
        exports: 'named',
        // language-data 的语言包走动态 import；CJS lib 不内联会产出宿主
        // require 表无法解析的分体 .cjs chunk，必须强制并入单文件。
        inlineDynamicImports: true,
      },
    },
  },
})
