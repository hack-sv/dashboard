# Registration flow

After first login, hackers go through `/register` before they can reach the
dashboard:

1. **`/register`** — personal info. Returning users (a `users` row with a name)
   get a **reuse-or-edit** preview; new users get the empty form. Saved to the
   `users` table via `PUT /auth/profile`.
2. **`/register/application`** — the per-event application: connect GitHub /
   Hackatime (optional OAuth), dietary restrictions, and a free-form field
   (≤2000 chars, plain text). Draft-saved via `PUT /auth/registration`.
3. **Submit** (`POST /auth/registration/submit`) flips the row to `submitted`
   and drops the user on `/dashboard`. A missing/`draft` registration bounces
   back into the wizard.

Applications are **reviewed**: status goes `draft → submitted →
accepted | rejected | waitlisted`. There's no admin UI yet — review by hand:

```bash
cf d1 query fbb87c66-6036-42d3-9406-a27c9942f99f \
  --sql "UPDATE registrations SET status='accepted', reviewed_at=unixepoch()*1000 WHERE id='<id>'"
```

## Data model (`migrations/0001_registration.sql`)

- **`users`** — reusable personal identity. Unchanged.
- **`registrations`** — one row per `(user_id, event_slug)`. Per-event, keyed to
  `CURRENT_EVENT.slug`.
- **`connections`** — account-level OAuth links (`github`, `hackatime`, later
  `discord`). Reusable across events. `access_token` is AES-GCM encrypted at
  rest and never leaves the Worker.

Apply the migration:

```bash
cf d1 query fbb87c66-6036-42d3-9406-a27c9942f99f --sql "$(sed 's/--.*//' migrations/0001_registration.sql)"
```

(`cf d1 query` has no `--file`, and `--` SQL comments confuse its arg parser, so
strip them first.)

## The active event

`worker/config.ts` → `CURRENT_EVENT = { slug, name }`. Bump it (and redeploy)
each season. Everything per-event hangs off `slug`.

## Secrets / config

Local dev reads `.dev.vars`; production uses `wrangler secret put`.

| Name | What |
| ---- | ---- |
| `TOKEN_ENC_KEY` | base64 of 32 random bytes — encrypts stored OAuth tokens. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App |
| `HACKATIME_CLIENT_ID` / `HACKATIME_CLIENT_SECRET` | Hackatime OAuth App |

The connect buttons degrade gracefully: with a client id unset, the flow
redirects back with `?error=<provider>_not_configured` instead of erroring.

### GitHub OAuth App

<https://github.com/settings/developers> → New OAuth App.
- Authorization callback URL: `https://hack.sv/auth/connect/github/callback`
  (add `http://localhost:<port>/auth/connect/github/callback` for dev).
- Scope requested: `read:user`. Store `id` + `login`.

### Hackatime OAuth App

<https://hackatime.hackclub.com/oauth> (docs:
<https://hackatime.hackclub.com/docs/oauth/oauth-apps>).
- **Confidential** (server-side) app.
- Redirect URI: `https://hack.sv/auth/connect/hackatime/callback`.
- Scopes: `profile read`. `/api/v1/authenticated/me` returns `id` +
  `github_username`; tokens are ~16-yr-lived (no refresh).
- DM Mahad on Slack to get the app **verified** so users don't see the
  "unverified" consent warning.

## Cloudflare routing

New Worker endpoints are registered in `wrangler.jsonc` under `run_worker_first`
(`/auth/profile`, `/auth/registration`, `/auth/registration/*`,
`/auth/connect/*`) so they always hit the Worker instead of the SPA fallback.
