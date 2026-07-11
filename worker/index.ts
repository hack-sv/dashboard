import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { WorkOS, AuthenticationException } from '@workos-inc/node'

type Bindings = {
  WORKOS_API_KEY: string
  WORKOS_CLIENT_ID: string
  WORKOS_COOKIE_PASSWORD: string
  DB: D1Database
}

const SESSION_COOKIE = 'wos-session'
// Short-lived cookies for the email-verification linking step (e.g. a magic-auth
// signup adding Google): the pending_authentication_token to complete auth, and
// the user id so we can resend the verification code.
const PENDING_COOKIE = 'wos-pending'
const PENDING_USER_COOKIE = 'wos-pending-user'

const app = new Hono<{ Bindings: Bindings }>()

function client(env: Bindings) {
  // clientId is required for the sealed-session helpers.
  return new WorkOS(env.WORKOS_API_KEY, { clientId: env.WORKOS_CLIENT_ID })
}

/**
 * Look up the D1 profile for a WorkOS user by email.
 * Returns null when there's no matching row, so the UI can say "no info".
 */
async function getProfile(env: Bindings, email: string) {
  if (!env.DB) return null
  try {
    const row = await env.DB.prepare(
      `SELECT id, email, legal_name, preferred_name, pronouns, dob, discord_id, events
       FROM users WHERE lower(email) = lower(?1) LIMIT 1`,
    )
      .bind(email)
      .first<Record<string, unknown>>()
    if (!row) return null
    // `events` is stored as a JSON string — hand back a real array.
    if (typeof row.events === 'string') {
      try {
        row.events = JSON.parse(row.events)
      } catch {
        // leave the raw string if it isn't valid JSON
      }
    }
    return row
  } catch (err) {
    console.error('[getProfile]', err)
    return null
  }
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
 * Who-am-I. Unseals the session cookie (no network call), and transparently
 * refreshes an expired access token, re-setting the cookie. Returns
 * `{ user: null }` when there's no valid session — never a hard 401, so the
 * SPA can just render the login screen.
 */
app.get('/auth/session', async (c) => {
  const sealed = getCookie(c, SESSION_COOKIE)
  if (!sealed) return c.json({ user: null })

  const workos = client(c.env)
  const cookiePassword = c.env.WORKOS_COOKIE_PASSWORD
  const url = new URL(c.req.url)

  const session = workos.userManagement.loadSealedSession({
    sessionData: sealed,
    cookiePassword,
  })

  const result = await session.authenticate()
  if (result.authenticated) {
    const profile = await getProfile(c.env, result.user.email)
    return c.json({ user: result.user, profile })
  }

  // Access token expired — try to refresh using the refresh token.
  const refreshed = await session.refresh()
  if (refreshed.authenticated && refreshed.sealedSession) {
    setCookie(c, SESSION_COOKIE, refreshed.sealedSession, cookieOptions(url))
    // Re-authenticate the freshly sealed session to reliably get the user.
    const reloaded = workos.userManagement.loadSealedSession({
      sessionData: refreshed.sealedSession,
      cookiePassword,
    })
    const after = await reloaded.authenticate()
    if (after.authenticated) {
      const profile = await getProfile(c.env, after.user.email)
      return c.json({ user: after.user, profile })
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ user: null, profile: null })
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
    return c.redirect('/auth?error=' + encodeURIComponent('Sign-in was interrupted. Please try again.'))
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
