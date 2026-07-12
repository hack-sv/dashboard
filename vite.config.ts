import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // In production the app is served under /dashboard/* on the hack.sv zone, so
  // built assets must be based there. Dev stays at the root for a normal
  // localhost experience.
  base: command === 'build' ? '/dashboard/' : '/',
  plugins: [react(), cloudflare()],
  // Dev-only: also serve the 2026 marketing site under /2026 on THIS origin by
  // proxying to its Astro dev server (base '/2026', default port 4321). In
  // production Cloudflare zone-routes /2026 and /dashboard onto the same
  // hack.sv origin; this mirrors that locally so the /2026 -> /auth flower
  // handoff can be tested on one origin (shared localStorage). Requires the
  // 2026 dev server to be running: `cd ../2026 && npm run dev`.
  server:
    command === 'serve'
      ? {
          proxy: {
            '/2026': {
              target: 'http://localhost:4321',
              changeOrigin: true,
              ws: true,
            },
          },
        }
      : undefined,
}))
