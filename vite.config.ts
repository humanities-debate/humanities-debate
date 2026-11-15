import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep the AudioWorklet on the bundled origin; data: scripts are forbidden by desktop CSP.
  build: { assetsInlineLimit: file => file.endsWith('pcmWorklet.js') ? false : undefined },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
  preview: { host: '127.0.0.1' },
})
