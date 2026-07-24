import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// Studio web client. Dev server proxies /api to the running studio server (:8700) so the old vanilla UI
// keeps working while this one is iterated live. `build` emits static files into ../public for the server.
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8700', changeOrigin: true },
    },
  },
  build: { outDir: '../public', emptyOutDir: true },
});
