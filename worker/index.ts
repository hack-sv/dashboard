import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { WorkOS, AuthenticationException } from '@workos-inc/node'
import { CURRENT_EVENT, FREEFORM_MAX } from './config'
import { encryptToken } from './crypto'
import {
  getProfile,
  ensureUserId,
  updateProfile,
  getRegistration,
  upsertRegistrationDraft,
  submitRegistration,
  getConnections,
  upsertConnection,
  deleteConnection,
} from './db'

type Bindings = {
  WORKOS_API_KEY: string
  WORKOS_CLIENT_ID: string
  WORKOS_COOKIE_PASSWORD: string
  DB: D1Database
  // Token encryption (base64 of 32 bytes).
  TOKEN_ENC_KEY: string
  // OAuth apps for account-level connections.
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  HACKATIME_CLIENT_ID: string
  HACKATIME_CLIENT_SECRET: string
}

const SESSION_COOKIE = 'wos-session'
// Short-lived cookies for the email-verification linking step (e.g. a magic-auth
// signup adding Google): the pending_authentication_token to complete auth, and
// the user id so we can resend the verification code.
const PENDING_COOKIE = 'wos-pending'
const PENDING_USER_COOKIE = 'wos-pending-user'
// CSRF guard for OAuth "connect" round-trips. Holds `${provider}:${state}`.
const CONNECT_STATE_COOKIE = 'connect-state'

type SessionUser = { id: string; email: string; [k: string]: unknown }

const app = new Hono<{ Bindings: Bindings }>()

function client(env: Bindings) {
  // clientId is required for the sealed-session helpers.
  return new WorkOS(env.WORKOS_API_KEY, { clientId: env.WORKOS_CLIENT_ID })
}

function cookieOptions(url: URL) {
  return {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days; WorkOS enforces the real session policy
  }
}

/**
 * Unseal the session cookie and return the WorkOS user, transparently refreshing
 * an expired access token (and re-setting the cookie). Returns null when there's
 * no valid session — callers decide whether that's a 401 or a `{ user: null }`.
 */
async function getSessionUser(c: Context<{ Bindings: Bindings }>): Promise<SessionUser | null> {
  const sealed = getCookie(c, SESSION_COOKIE)
  if (!sealed) return null

  const workos = client(c.env)
  const cookiePassword = c.env.WORKOS_COOKIE_PASSWORD
  const url = new URL(c.req.url)

  const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword })
  const result = await session.authenticate()
  if (result.authenticated) return result.user as unknown as SessionUser

  // Access token expired — try to refresh using the refresh token.
  const refreshed = await session.refresh()
  if (refreshed.authenticated && refreshed.sealedSession) {
    setCookie(c, SESSION_COOKIE, refreshed.sealedSession, cookieOptions(url))
    const reloaded = workos.userManagement.loadSealedSession({
      sessionData: refreshed.sealedSession,
      cookiePassword,
    })
    const after = await reloaded.authenticate()
    if (after.authenticated) return after.user as unknown as SessionUser
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return null
}

/**
 * Who-am-I. Returns the WorkOS identity, the D1 profile,
 * the current event, this user's registration for it, and their account-level
 * connections. Never a hard 401 — the SPA renders login when `user` is null.
 */
app.get('/auth/session', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ user: null, profile: null })

  const profile = await getProfile(c.env.DB, user.email)
  // Only read per-user rows when a users row already exists — session load never
  // creates one (that happens lazily on the first profile/registration write).
  const registration = profile
    ? await getRegistration(c.env.DB, profile.id, CURRENT_EVENT.slug)
    : null
  const connections = profile ? await getConnections(c.env.DB, profile.id) : []

  return c.json({ user, profile, currentEvent: CURRENT_EVENT, registration, connections })
})

// ---------------------------------------------------------------------------
// Registration — personal info (users) + per-event application (registrations)
// ---------------------------------------------------------------------------

/** Save the reusable personal-info fields (step 1: the "edit" / new-user form). */
app.put('/auth/profile', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'not authenticated' }, 401)

  const body = await c.req.json<{
    legal_name?: string
    preferred_name?: string
    pronouns?: string
    dob?: string
  }>()

  const userId = await ensureUserId(c.env.DB, user.email)
  await updateProfile(c.env.DB, userId, {
    legal_name: body.legal_name?.trim() || undefined,
    preferred_name: body.preferred_name?.trim() || undefined,
    pronouns: body.pronouns?.trim() || undefined,
    dob: body.dob?.trim() || undefined,
  })
  const profile = await getProfile(c.env.DB, user.email)
  return c.json({ profile })
})

/** Fetch the current registration for CURRENT_EVENT (or null). */
app.get('/auth/registration', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'not authenticated' }, 401)
  const profile = await getProfile(c.env.DB, user.email)
  const registration = profile
    ? await getRegistration(c.env.DB, profile.id, CURRENT_EVENT.slug)
    : null
  return c.json({ registration })
})

/** Draft-save the per-event application fields (step 2). Creates the row if new. */
app.put('/auth/registration', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'not authenticated' }, 401)

  const body = await c.req.json<{ dietary_restrictions?: string; freeform?: string }>()
  const freeform = body.freeform ?? ''
  if (freeform.length > FREEFORM_MAX) {
    return c.json({ error: `freeform must be ${FREEFORM_MAX} characters or fewer` }, 400)
  }

  const userId = await ensureUserId(c.env.DB, user.email)
  const registration = await upsertRegistrationDraft(c.env.DB, userId, CURRENT_EVENT.slug, {
    dietary_restrictions: body.dietary_restrictions?.trim() || null,
    freeform: freeform.trim() || null,
  })
  return c.json({ registration })
})

/** Submit the application: draft -> submitted (awaiting review). */
app.post('/auth/registration/submit', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'not authenticated' }, 401)

  const profile = await getProfile(c.env.DB, user.email)
  // Hard requirements to submit: a name (step 1), a connected GitHub, and a
  // filled-in "what have you been building" box. Dietary is answer-if-applicable;
  // Hackatime is optional. Mirrors the client-side checks in Register.tsx.
  if (!profile || !(profile.legal_name || profile.preferred_name)) {
    return c.json({ error: 'please fill in your name before submitting' }, 400)
  }
  const existing = await getRegistration(c.env.DB, profile.id, CURRENT_EVENT.slug)
  if (!existing) return c.json({ error: 'no registration to submit' }, 400)
  if (!existing.freeform?.trim()) {
    return c.json({ error: 'tell us a bit about what you’ve been building' }, 400)
  }
  const connections = await getConnections(c.env.DB, profile.id)
  if (!connections.some((conn) => conn.provider === 'github')) {
    return c.json({ error: 'please connect GitHub before submitting' }, 400)
  }

  const registration = await submitRegistration(c.env.DB, profile.id, CURRENT_EVENT.slug)
  return c.json({ registration })
})

// ---------------------------------------------------------------------------
// Account-level OAuth connections (GitHub, Hackatime)
// ---------------------------------------------------------------------------

type ProviderCfg = {
  authorizeUrl: string
  tokenUrl: string
  scope: string
  clientId: (env: Bindings) => string
  clientSecret: (env: Bindings) => string
  // Exchange body for the token endpoint (form-encoded).
  tokenBody: (params: {
    code: string
    redirectUri: string
    clientId: string
    clientSecret: string
  }) => Record<string, string>
  tokenHeaders?: Record<string, string>
  // Fetch the connected identity with the access token. `detail` is a short,
  // human-readable stat shown next to the username (e.g. "73 repositories",
  // "43 hr 48 min") — captured at connect time; the icon conveys the service.
  fetchIdentity: (
    token: string,
  ) => Promise<{ external_id: string | null; username: string | null; detail: string | null }>
}

/** Seconds -> "43hr 48min" (or "48min" under an hour). */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}hr ${m}min` : `${m}min`
}

const PROVIDERS: Record<'github' | 'hackatime', ProviderCfg> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user',
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    tokenBody: ({ code, redirectUri, clientId, clientSecret }) => ({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    tokenHeaders: { Accept: 'application/json' },
    fetchIdentity: async (token) => {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'hack.sv-dashboard',
        },
      })
      if (!res.ok) throw new Error(`github /user ${res.status}`)
      const u = (await res.json()) as {
        id: number
        login: string
        public_repos?: number
        owned_private_repos?: number
      }
      const repos = (u.public_repos ?? 0) + (u.owned_private_repos ?? 0)
      const detail = `${repos} ${repos === 1 ? 'repository' : 'repositories'}`
      return { external_id: String(u.id), username: u.login, detail }
    },
  },
  hackatime: {
    authorizeUrl: 'https://hackatime.hackclub.com/oauth/authorize',
    tokenUrl: 'https://hackatime.hackclub.com/oauth/token',
    scope: 'profile read',
    clientId: (env) => env.HACKATIME_CLIENT_ID,
    clientSecret: (env) => env.HACKATIME_CLIENT_SECRET,
    tokenBody: ({ code, redirectUri, clientId, clientSecret }) => ({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    fetchIdentity: async (token) => {
      const headers = { Authorization: `Bearer ${token}` }
      const res = await fetch('https://hackatime.hackclub.com/api/v1/authenticated/me', {
        headers,
      })
      if (!res.ok) throw new Error(`hackatime /me ${res.status}`)
      const u = (await res.json()) as { id: number; github_username?: string | null }

      // All-time coding total (no date range) for the "43 hr 48 min" stat.
      // Non-fatal: a connection is still worth keeping without the number.
      let detail: string | null = null
      try {
        const hoursRes = await fetch('https://hackatime.hackclub.com/api/v1/authenticated/hours', {
          headers,
        })
        if (hoursRes.ok) {
          const { total_seconds } = (await hoursRes.json()) as { total_seconds?: number }
          if (typeof total_seconds === 'number') detail = formatDuration(total_seconds)
        }
      } catch (e) {
        console.error('[connect/hackatime] hours', e)
      }
      return { external_id: String(u.id), username: u.github_username ?? null, detail }
    },
  },
}

function isProvider(p: string): p is 'github' | 'hackatime' {
  return p === 'github' || p === 'hackatime'
}

/** Kick off connecting an account-level provider. Requires an active session. */
app.get('/auth/connect/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (!isProvider(provider)) return c.json({ error: 'unknown provider' }, 404)

  const user = await getSessionUser(c)
  if (!user) return c.redirect('/auth')

  const cfg = PROVIDERS[provider]
  const clientId = cfg.clientId(c.env)
  if (!clientId) {
    return c.redirect(`/register/application?error=${provider}_not_configured`)
  }

  const url = new URL(c.req.url)
  const state = crypto.randomUUID()
  setCookie(c, CONNECT_STATE_COOKIE, `${provider}:${state}`, {
    ...cookieOptions(url),
    maxAge: 60 * 15, // 15 min
  })

  const authorize = new URL(cfg.authorizeUrl)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/connect/${provider}/callback`)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', cfg.scope)
  authorize.searchParams.set('state', state)
  return c.redirect(authorize.toString())
})

/** OAuth redirect target: verify state, exchange code, store the connection. */
app.get('/auth/connect/:provider/callback', async (c) => {
  const provider = c.req.param('provider')
  if (!isProvider(provider)) return c.json({ error: 'unknown provider' }, 404)

  const dest = (q: string) => c.redirect(`/register/application?${q}`)

  const user = await getSessionUser(c)
  if (!user) return c.redirect('/auth')

  const err = c.req.query('error')
  if (err) return dest(`error=${provider}_denied`)

  const code = c.req.query('code')
  const state = c.req.query('state')
  const cookieState = getCookie(c, CONNECT_STATE_COOKIE)
  deleteCookie(c, CONNECT_STATE_COOKIE, { path: '/' })
  if (!code || !state || cookieState !== `${provider}:${state}`) {
    return dest(`error=${provider}_state`)
  }

  const cfg = PROVIDERS[provider]
  const url = new URL(c.req.url)
  try {
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cfg.tokenHeaders ?? {}) },
      body: new URLSearchParams(
        cfg.tokenBody({
          code,
          redirectUri: `${url.origin}/auth/connect/${provider}/callback`,
          clientId: cfg.clientId(c.env),
          clientSecret: cfg.clientSecret(c.env),
        }),
      ),
    })
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`)
    const tokenJson = (await tokenRes.json()) as { access_token?: string; scope?: string }
    if (!tokenJson.access_token) throw new Error('no access_token')

    const identity = await cfg.fetchIdentity(tokenJson.access_token)
    const userId = await ensureUserId(c.env.DB, user.email)
    await upsertConnection(c.env.DB, {
      user_id: userId,
      provider,
      external_id: identity.external_id,
      username: identity.username,
      detail: identity.detail,
      access_token: await encryptToken(c.env.TOKEN_ENC_KEY, tokenJson.access_token),
      scopes: tokenJson.scope ?? cfg.scope,
    })
    return dest(`connected=${provider}`)
  } catch (e) {
    console.error(`[connect/${provider}]`, e)
    return dest(`error=${provider}_failed`)
  }
})

/** Remove an account-level connection. */
app.post('/auth/connect/:provider/disconnect', async (c) => {
  const provider = c.req.param('provider')
  if (!isProvider(provider)) return c.json({ error: 'unknown provider' }, 404)

  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'not authenticated' }, 401)

  const userId = await ensureUserId(c.env.DB, user.email)
  await deleteConnection(c.env.DB, userId, provider)
  return c.json({ ok: true })
})

/** Kick off the "Continue with Google" flow. */
app.get('/auth/google', (c) => {
  const workos = client(c.env)
  const url = new URL(c.req.url)
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: 'GoogleOAuth',
    clientId: c.env.WORKOS_CLIENT_ID,
    redirectUri: `${url.origin}/auth/callback`,
  })
  return c.redirect(authorizationUrl)
})

/** OAuth redirect target — exchange the code for a sealed session. */
app.get('/auth/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    return c.redirect(
      '/auth?error=' + encodeURIComponent('Sign-in was interrupted. Please try again.'),
    )
  }

  const workos = client(c.env)
  const url = new URL(c.req.url)
  try {
    const { sealedSession } = await workos.userManagement.authenticateWithCode({
      code,
      clientId: c.env.WORKOS_CLIENT_ID,
      session: { sealSession: true, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD },
    })
    if (sealedSession) {
      setCookie(c, SESSION_COOKIE, sealedSession, cookieOptions(url))
    }
    return c.redirect('/dashboard')
  } catch (err) {
    // WorkOS needs the user to prove they own this email before it will link a
    // new identity (e.g. a magic-auth signup now adding Google). It has already
    // emailed a verification code; carry the pending token to the verify step.
    if (
      err instanceof AuthenticationException &&
      err.code === 'email_verification_required' &&
      err.pendingAuthenticationToken
    ) {
      const pendingOpts = { ...cookieOptions(url), maxAge: 60 * 15 } // 15 min
      setCookie(c, PENDING_COOKIE, err.pendingAuthenticationToken, pendingOpts)
      if (err.rawData.user?.id) {
        setCookie(c, PENDING_USER_COOKIE, err.rawData.user.id, pendingOpts)
      }
      const email = err.rawData.user?.email ?? ''
      return c.redirect('/auth?verify=' + encodeURIComponent(email))
    }

    console.error('[auth/callback]', err)
    // Surface the real reason on the login page's error line.
    const message = err instanceof Error ? err.message : 'Sign-in failed. Please try again.'
    return c.redirect('/auth?error=' + encodeURIComponent(message))
  }
})

/**
 * Complete an email-verification link (the second half of the OAuth callback
 * when WorkOS returned email_verification_required). Reads the pending token
 * from its short-lived cookie, exchanges the emailed code, and establishes the
 * session — attaching the new identity (e.g. Google) to the existing account.
 */
app.post('/auth/verify-email', async (c) => {
  const { code } = await c.req.json<{ code?: string }>()
  if (!code) return c.json({ error: 'code required' }, 400)

  const pendingToken = getCookie(c, PENDING_COOKIE)
  if (!pendingToken) return c.json({ error: 'verification expired — please sign in again' }, 400)

  const workos = client(c.env)
  const url = new URL(c.req.url)
  try {
    const { user, sealedSession } = await workos.userManagement.authenticateWithEmailVerification({
      code,
      pendingAuthenticationToken: pendingToken,
      clientId: c.env.WORKOS_CLIENT_ID,
      session: { sealSession: true, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD },
    })
    if (sealedSession) {
      setCookie(c, SESSION_COOKIE, sealedSession, cookieOptions(url))
    }
    deleteCookie(c, PENDING_COOKIE, { path: '/' })
    deleteCookie(c, PENDING_USER_COOKIE, { path: '/' })
    return c.json({ user })
  } catch (err) {
    console.error('[auth/verify-email]', err)
    return c.json({ error: 'invalid or expired code' }, 401)
  }
})

/** Resend the email-verification code for the pending link. */
app.post('/auth/verify-resend', async (c) => {
  const userId = getCookie(c, PENDING_USER_COOKIE)
  if (!userId) return c.json({ error: 'verification expired — please sign in again' }, 400)

  const workos = client(c.env)
  try {
    await workos.userManagement.sendVerificationEmail({ userId })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[auth/verify-resend]', err)
    return c.json({ error: 'could not resend' }, 400)
  }
})

/** Send a Magic Auth one-time code to the given email. */
app.post('/auth/magic/send', async (c) => {
  const { email } = await c.req.json<{ email?: string }>()
  if (!email) return c.json({ error: 'email required' }, 400)

  const workos = client(c.env)
  try {
    await workos.userManagement.createMagicAuth({ email })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[auth/magic/send]', err)
    return c.json({ error: 'could not send code' }, 400)
  }
})

/** Verify a Magic Auth code and establish a sealed session. */
app.post('/auth/magic/verify', async (c) => {
  const { email, code } = await c.req.json<{ email?: string; code?: string }>()
  if (!email || !code) return c.json({ error: 'email and code required' }, 400)

  const workos = client(c.env)
  const url = new URL(c.req.url)
  try {
    const { user, sealedSession } = await workos.userManagement.authenticateWithMagicAuth({
      code,
      email,
      clientId: c.env.WORKOS_CLIENT_ID,
      session: { sealSession: true, cookiePassword: c.env.WORKOS_COOKIE_PASSWORD },
    })
    if (sealedSession) {
      setCookie(c, SESSION_COOKIE, sealedSession, cookieOptions(url))
    }
    return c.json({ user })
  } catch (err) {
    console.error('[auth/magic/verify]', err)
    return c.json({ error: 'invalid or expired code' }, 401)
  }
})

/** Clear the local session. Best-effort WorkOS logout URL for the client. */
app.post('/auth/logout', async (c) => {
  const sealed = getCookie(c, SESSION_COOKIE)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })

  if (sealed) {
    try {
      const workos = client(c.env)
      const session = workos.userManagement.loadSealedSession({
        sessionData: sealed,
        cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
      })
      const logoutUrl = await session.getLogoutUrl()
      return c.json({ logoutUrl })
    } catch {
      // Session already invalid — nothing more to do.
    }
  }
  return c.json({ ok: true })
})

export default app
