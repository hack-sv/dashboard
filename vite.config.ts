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
}))
