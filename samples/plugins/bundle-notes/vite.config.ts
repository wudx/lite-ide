import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Bundle-format external plugin build: CommonJS files whose host-provided
// dependencies (solid-js, workspace packages, the `liteide` host API) stay
// external and are injected by the plugin loader's require table.
// Entries must not share internal modules, so each entry emits as its own
// self-contained file (main → plugin.js, logView → log-view.js).
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    lib: {
      entry: {
        main: 'src/index.tsx',
        logView: 'src/LogPreview.tsx',
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => (entryName === 'main' ? 'plugin.js' : 'log-view.js'),
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
