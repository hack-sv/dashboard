// D1 access for identity (users), per-event applications (registrations), and
// account-level OAuth links (connections). Kept free of Hono/request concerns so
// the route handlers stay thin.

export type Profile = {
  id: string
  email: string
  legal_name: string | null
  preferred_name: string | null
  pronouns: string | null
  dob: string | null
  discord_id: string | null
  events: string[] | string | null
}

export type Registration = {
  id: string
  user_id: string
  event_slug: string
  dietary_restrictions: string | null
  freeform: string | null
  status: string
  created_at: number
  updated_at: number
  submitted_at: number | null
  reviewed_at: number | null
  reviewed_by: string | null
  review_notes: string | null
}

// Never carries access_token — connections are surfaced to the client without secrets.
export type ConnectionSummary = {
  provider: string
  external_id: string | null
  username: string | null
  scopes: string | null
  connected_at: number
}

/** The D1 profile row for a WorkOS user, matched by email. */
export async function getProfile(db: D1Database, email: string): Promise<Profile | null> {
  const row = await db
    .prepare(
      `SELECT id, email, legal_name, preferred_name, pronouns, dob, discord_id, events
       FROM users WHERE lower(email) = lower(?1) LIMIT 1`,
    )
    .bind(email)
    .first<Record<string, unknown>>()
  if (!row) return null
  if (typeof row.events === 'string') {
    try {
      row.events = JSON.parse(row.events)
    } catch {
      // leave the raw string if it isn't valid JSON
    }
  }
  return row as unknown as Profile
}

/**
 * Resolve the stable D1 users.id for an email, creating a minimal row the first
 * time a brand-new WorkOS account touches anything that needs a user_id (profile
 * save, registration draft, connection). Returns the id.
 */
export async function ensureUserId(db: D1Database, email: string): Promise<string> {
  const existing = await db
    .prepare(`SELECT id FROM users WHERE lower(email) = lower(?1) LIMIT 1`)
    .bind(email)
    .first<{ id: string }>()
  if (existing?.id) return existing.id

  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO users (id, email) VALUES (?1, ?2)`).bind(id, email).run()
  return id
}

/** Upsert the reusable personal-info fields on the users row (step 1). */
export async function updateProfile(
  db: D1Database,
  userId: string,
  fields: { legal_name?: string; preferred_name?: string; pronouns?: string; dob?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
         SET legal_name = ?2, preferred_name = ?3, pronouns = ?4, dob = ?5
       WHERE id = ?1`,
    )
    .bind(
      userId,
      fields.legal_name ?? null,
      fields.preferred_name ?? null,
      fields.pronouns ?? null,
      fields.dob ?? null,
    )
    .run()
}

export async function getRegistration(
  db: D1Database,
  userId: string,
  eventSlug: string,
): Promise<Registration | null> {
  const row = await db
    .prepare(`SELECT * FROM registrations WHERE user_id = ?1 AND event_slug = ?2 LIMIT 1`)
    .bind(userId, eventSlug)
    .first<Registration>()
  return row ?? null
}

/**
 * Create-or-update the draft registration for (user, event). Only touches the
 * hacker-editable fields; never advances status past its current value.
 */
export async function upsertRegistrationDraft(
  db: D1Database,
  userId: string,
  eventSlug: string,
  fields: { dietary_restrictions?: string | null; freeform?: string | null },
): Promise<Registration> {
  const now = Date.now()
  const existing = await getRegistration(db, userId, eventSlug)
  if (existing) {
    await db
      .prepare(
        `UPDATE registrations
           SET dietary_restrictions = ?3, freeform = ?4, updated_at = ?5
         WHERE user_id = ?1 AND event_slug = ?2`,
      )
      .bind(userId, eventSlug, fields.dietary_restrictions ?? null, fields.freeform ?? null, now)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO registrations
           (id, user_id, event_slug, dietary_restrictions, freeform, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?6)`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        eventSlug,
        fields.dietary_restrictions ?? null,
        fields.freeform ?? null,
        now,
      )
      .run()
  }
  return (await getRegistration(db, userId, eventSlug))!
}

/** Move a draft to `submitted` (idempotent for already-submitted rows). */
export async function submitRegistration(
  db: D1Database,
  userId: string,
  eventSlug: string,
): Promise<Registration | null> {
  const now = Date.now()
  await db
    .prepare(
      `UPDATE registrations
         SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?3), updated_at = ?3
       WHERE user_id = ?1 AND event_slug = ?2 AND status = 'draft'`,
    )
    .bind(userId, eventSlug, now)
    .run()
  return getRegistration(db, userId, eventSlug)
}

export async function getConnections(db: D1Database, userId: string): Promise<ConnectionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT provider, external_id, username, scopes, connected_at
         FROM connections WHERE user_id = ?1`,
    )
    .bind(userId)
    .all<ConnectionSummary>()
  return results ?? []
}

export async function upsertConnection(
  db: D1Database,
  row: {
    user_id: string
    provider: string
    external_id: string | null
    username: string | null
    access_token: string | null
    scopes: string | null
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections (user_id, provider, external_id, username, access_token, scopes, connected_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         external_id = excluded.external_id,
         username = excluded.username,
         access_token = excluded.access_token,
         scopes = excluded.scopes,
         connected_at = excluded.connected_at`,
    )
    .bind(
      row.user_id,
      row.provider,
      row.external_id,
      row.username,
      row.access_token,
      row.scopes,
      Date.now(),
    )
    .run()
}

export async function deleteConnection(
  db: D1Database,
  userId: string,
  provider: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM connections WHERE user_id = ?1 AND provider = ?2`)
    .bind(userId, provider)
    .run()
}
