-- Add a human-readable per-connection stat captured at connect time, shown next
-- to the username in the registration UI (e.g. "73 repositories", "43 hr 48 min").
-- Additive and nullable; existing rows keep NULL until the user reconnects.
--
-- Apply against remote D1:
--   wrangler d1 execute <database> --remote --file migrations/0002_connection_detail.sql

ALTER TABLE connections ADD COLUMN detail TEXT;
