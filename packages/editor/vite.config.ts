import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.RANGOLI_SERVER ?? 'http://127.0.0.1:4400';

export default defineConfig({
  base: '/editor/',
  plugins: [react()],
  resolve: {
    // use engine sources directly: one codebase, tree-shaken into the editor bundle
    alias: { '@rangoli/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) },
  },
  server: {
    proxy: { '/api': server, '/events': server, '/select': server },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
});
