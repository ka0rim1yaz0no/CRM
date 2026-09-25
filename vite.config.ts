import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(),tailwindcss()],
  // Open CRM tabs may still request hashed chunks from the previous release.
  build: {
    emptyOutDir: false,
  },
  preview: {
    allowedHosts: ["crm.assistly123.com"],
  },
})
