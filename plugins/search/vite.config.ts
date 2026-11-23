import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Bundle-format plugin build: single CommonJS file whose host-provided
// dependencies (solid-js, workspace packages) stay external and are injected
// by the plugin loader's require table at evaluation time.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
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
      output: { exports: 'named' },
    },
  },
})
