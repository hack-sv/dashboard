-- Registration + account-level connections.
--
-- `users` stays the reusable personal identity.
-- Everything a hacker fills out FOR A SPECIFIC EVENT lives in `registrations`.
-- OAuth links (GitHub, Hackatime, later Discord) are account-level and reusable
-- across events, so they live in `connections`, keyed by the users.id.
--
-- Apply against remote D1:
--   wrangler d1 execute <database> --remote --file migrations/0001_registration.sql

-- Per-event application. One row per (user_id, event_slug).
CREATE TABLE IF NOT EXISTS registrations (
  id                   TEXT PRIMARY KEY,          -- uuid
  user_id              TEXT NOT NULL,             -- -> users.id
  event_slug           TEXT NOT NULL,             -- e.g. the CURRENT_EVENT constant
  dietary_restrictions TEXT,                      -- blank/null = no restrictions
  freeform             TEXT,                      -- <= 2000 chars, plain text (no markdown)
  status               TEXT NOT NULL DEFAULT 'draft', -- draft -> submitted -> accepted|rejected|waitlisted
  created_at           INTEGER NOT NULL,          -- epoch ms
  updated_at           INTEGER NOT NULL,
  submitted_at         INTEGER,
  reviewed_at          INTEGER,
  reviewed_by          TEXT,
  review_notes         TEXT,
  UNIQUE(user_id, event_slug)
);

CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_slug, status);

-- Account-level OAuth connections (github | hackatime | discord). Reusable across
-- events. access_token is AES-GCM encrypted at rest and never leaves the Worker.
CREATE TABLE IF NOT EXISTS connections (
  user_id      TEXT NOT NULL,   -- -> users.id
  provider     TEXT NOT NULL,   -- 'github' | 'hackatime' | 'discord'
  external_id  TEXT,            -- provider's stable id (github id / hackatime id)
  username     TEXT,            -- github login / hackatime github_username
  access_token TEXT,            -- encrypted; NULL if we don't retain a token
  scopes       TEXT,            -- space-separated scopes granted
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
