import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dashboard is served by the backend from /app/ when frontend/dist exists.
// In dev, Vite runs on :5173 and proxies every backend route to :8000.
const BACKEND = process.env.AIPROXY_BACKEND || 'http://127.0.0.1:8000'

const toBackend = {
  target: BACKEND,
  changeOrigin: true,
  ws: false,
}

function appRedirect() {
  return {
    name: 'aiproxy-app-redirect',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '/'
        if (url === '/' || url === '') {
          res.statusCode = 302
          res.setHeader('Location', '/app/')
          res.end()
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  // Served from /app/ by the backend.
  base: '/app/',
  plugins: [react(), appRedirect()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      '/admin': toBackend,
      '/v1': toBackend,
      '/health': toBackend,
      '/ready': toBackend,
      '/metrics': toBackend,
      '/openapi.json': toBackend,
      // Catch-all: any other path (e.g. /) reaches the backend too, while
      // Vite keeps serving its own /app/* module graph in dev.
      '/': {
        ...toBackend,
        // Vite installs the proxy before its own asset/transform middlewares,
        // so hand /app/* back to the dev server instead of the backend.
        // Returning a string rewrites the URL and falls through to Vite.
        bypass: (req) => (req.url && req.url.startsWith('/app') ? req.url : undefined),
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
})