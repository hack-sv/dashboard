// Post-build: nest the client bundle under a `dashboard/` folder.
//
// The app is served under /dashboard/* on the hack.sv zone (see vite base in
// vite.config.ts). Vite's `base` rewrites asset URLs to /dashboard/… but does
// NOT change the physical file layout, and Cloudflare Static Assets match URLs
// to files by exact physical path. So a request for /dashboard/assets/app.js
// would look for dist/client/dashboard/assets/app.js and 404 without this step.
//
// We move everything except the root index.html into dist/client/dashboard/ so
// the physical paths line up with the /dashboard/* URLs. The root index.html
// stays put to serve as the SPA not-found fallback: Cloudflare serves the root
// /index.html for any unmatched path — including /auth and /dashboard.
//
// We deliberately do NOT put an index.html inside dashboard/, so that a request
// for /dashboard falls through to the SPA fallback (200) instead of triggering
// Cloudflare's auto-trailing-slash redirect (/dashboard -> /dashboard/).
import { readdirSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const clientDir = 'dist/client'
const nestedDir = join(clientDir, 'dashboard')

// Keep these at the assets root:
//  - index.html      → the SPA not-found fallback
//  - .assetsignore   → Cloudflare's exclude list (must sit at the root)
const KEEP_AT_ROOT = new Set(['index.html', '.assetsignore', 'dashboard'])

mkdirSync(nestedDir, { recursive: true })

for (const name of readdirSync(clientDir)) {
  if (KEEP_AT_ROOT.has(name)) continue
  renameSync(join(clientDir, name), join(nestedDir, name))
}

console.log('[nest-assets] client bundle nested under dist/client/dashboard/')
