import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { loadEnv } from 'vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Require an explicit proxy target when running the dev server so both the
  // HTTP proxy and the WebSocket base point at the exact address uvicorn is
  // bound to. See the matching check in src/lib/agentStream.ts for why we
  // refuse to silently default to `http://localhost:8000`.
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim()
  if (command === 'serve' && !proxyTarget) {
    throw new Error(
      'VITE_API_PROXY_TARGET is not set. Create frontend/.env.local with ' +
        'VITE_API_PROXY_TARGET=http://127.0.0.1:8000 (or whatever address uvicorn ' +
        'is bound to). Do not use "localhost" on macOS: it can resolve to IPv6 ::1 ' +
        'and break WebSocket streaming.',
    )
  }
  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    plugins: [
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    server: proxyTarget
      ? {
          proxy: {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              ws: true,
            },
          },
        }
      : undefined,
  }
})
