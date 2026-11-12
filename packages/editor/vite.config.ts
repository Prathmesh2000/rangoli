import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.RANGOLI_SERVER ?? 'http://127.0.0.1:4400';

export default defineConfig({
  base: '/editor/',
  plugins: [react()],
  resolve: {
    // use engine sources directly: one codebase, tree-shaken into the editor bundle
    alias: [
      { find: '@rangoli/engine', replacement: fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) },
      // paper's default build compiles PaperScript with new Function as it loads, which the hosted CSP refuses
      { find: /^paper$/, replacement: 'paper/dist/paper-core.js' },
    ],
  },
  server: {
    proxy: { '/api': server, '/events': server, '/select': server, '/d': server },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
});
