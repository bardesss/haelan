import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development Vite serves the app and Fastify serves the data, so the browser sees one
// origin and the session cookie works exactly as it does in production behind one port.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin stays false deliberately: the server compares Origin against Host, and
      // rewriting the host here would make every mutating request from the dev server look
      // cross origin and answer 403.
      '/api': { target: 'http://localhost:4235', changeOrigin: false },
      '/oauth': { target: 'http://localhost:4235', changeOrigin: false },
    },
  },
})
