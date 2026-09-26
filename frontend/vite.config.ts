import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.YABBE_BACKEND ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // listen on all interfaces so other devices on the LAN can connect
    proxy: {
      '/api': { target: backend, changeOrigin: true },
    },
  },
})
