import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { appVersion } from '../../scripts/app-version.ts'

// In development Vite serves the app and Fastify serves the data, so the browser sees one
// origin and the session cookie works exactly as it does in production behind one port.
export default defineConfig({
  plugins: [react()],
  // Baked in at build time from the root package.json. The bundle a person is running is the
  // thing that should answer "what version is this", and it cannot ask the filesystem from a
  // browser. The root vitest.config.ts defines the same constant from the same helper, because
  // the suite does not load this file.
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
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
