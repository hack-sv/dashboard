-- Local-dev seed for the Miniflare D1 used by `vite dev` / `wrangler dev`.
-- The Vite plugin ignores `experimental_remote`, so local dev uses an empty
-- local database, not the remote one. This creates the schema and clones a
-- single real user (contact@adamxu.net) so the "returning user" reuse/edit
-- path has something to show — without touching the remote 198-user table.
--
-- Apply:  npx wrangler d1 execute hack-sv-dashboard --local --file scripts/seed-local.sql

-- users: mirrors the remote schema exactly (no extra constraints).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  legal_name TEXT,
  preferred_name TEXT,
  pronouns TEXT,
  dob TEXT,
  discord_id TEXT,
  events TEXT
);

CREATE TABLE IF NOT EXISTS registrations (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  event_slug           TEXT NOT NULL,
  dietary_restrictions TEXT,
  freeform             TEXT,
  status               TEXT NOT NULL DEFAULT 'draft',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  submitted_at         INTEGER,
  reviewed_at          INTEGER,
  reviewed_by          TEXT,
  review_notes         TEXT,
  UNIQUE(user_id, event_slug)
);

CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_slug, status);

CREATE TABLE IF NOT EXISTS connections (
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT,
  username     TEXT,
  access_token TEXT,
  scopes       TEXT,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Cloned from remote. INSERT OR REPLACE keeps re-seeding idempotent.
INSERT OR REPLACE INTO users (id, email, legal_name, preferred_name, pronouns, dob, discord_id, events)
VALUES (
  '9f1466f6-2c23-498a-a991-408ee7917844',
  'contact@adamxu.net',
  'Adam Xu',
  'Adam',
  'he/him',
  '2010-01-22',
  '773996537414942763',
  '["counterspell","hacksv_2025","scrapyard"]'
);
