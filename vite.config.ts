import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { assertLocalPortAvailable } from './scripts/local-review-ports.mjs'
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(),tailwindcss(), {
    name: 'single-localhost-preview',
    async configureServer(server) {
      if (server.config.server.port === 5173) await assertLocalPortAvailable(5173)
    },
  }],
  cacheDir: process.env.CRM_VITE_CACHE_DIR || 'node_modules/.vite',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.VITE_BACKEND_PORT || '4000'}`, changeOrigin: true },
      '/socket.io': { target: `http://127.0.0.1:${process.env.VITE_BACKEND_PORT || '4000'}`, ws: true, changeOrigin: true },
    },
  },
  // Open CRM tabs may still request hashed chunks from the previous release.
  build: {
    emptyOutDir: false,
  },
  preview: {
    allowedHosts: ["crm.assistly123.com"],
  },
})
