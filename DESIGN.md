# DESIGN.md — dashboard UX conventions

The living record of the dashboard's design choices, so screens stay consistent
as we add flows. When you introduce a new pattern, add it here; when you touch a
screen, make it match what's below. Login and registration deliberately share
one visual vocabulary (`.field`, `.lead-icon`, `.hint`, `.error`, `.spin`,
`.shake`) split across `src/login.css` and `src/register.css` — keep it shared.

## Visual foundation

- **Flat, sharp, white on the wave.** Controls are solid white boxes with
  **no border-radius** and **no border**, sitting directly on the dithered wave
  background (`WaveBackground`). Don't add shadows, rounded corners, or card
  chrome — the flatness is the look.
- **Type:** `Nunito Sans`, system-ui fallback. Body/control text 16–17px, weight
  600 for interactive labels.
- **Control height:** `3.5rem` for inputs and primary buttons — they line up as
  a stack of equal bars.
- **Color:** black text on white controls. **Blue (`#2563eb`) is the single
  accent** (e.g. the "Optional" tag) — one accent keeps the flat surface calm.
  Other color is semantic only (see Errors, Destructive actions).

## Buttons & async actions

- **Primary action** = full-width white bar, **label left, arrow right**
  (`.reg-btn` with `<span>Label</span>` + `<Arrow/>`).
- **Loading is a spinner swap, never a fade.** On submit, the trailing arrow is
  replaced by a spinning `Loader2` (`className="spin"`); the button stays at
  **full opacity** so it reads as *working*. This is the single most important
  rule here — a loading button must not look greyed out.
  ```tsx
  <button className={`reg-btn${busy ? ' is-busy' : ''}`} disabled={busy}>
    <span>Continue</span>
    {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
  </button>
  ```
- **`disabled` during an in-flight request** (plus an early `if (busy) return`)
  prevents double-submit. Because the button is disabled while busy, we add the
  `is-busy` class and scope the fade to `:disabled:not(.is-busy)` — so busy stays
  full-opacity and only a *genuinely unavailable* button fades.
- **Alawys opacity = 1.0"** — e.g. the
  application submit while submitting. It is never
  slightly transparent, just shows a loading state.

## Required vs optional

- **Optionality is a property of each field, never the page.** Don't put a
  blanket "everything here is optional/required" line — it's almost always a lie
  (a page usually mixes required, optional, and answer-if-applicable fields).
  Label each field instead.
- **Three states, marked in place:**
  - *Required* — mark it (e.g. a muted `.field-tag` reading "Required" on a
    connect row) and enforce on submit.
  - *Optional* — mark it "Optional" (blue `.field-tag`, sized to the field
    label) so the absence of a "Required" tag is never ambiguous. A short
    left-aligned helper line under the control can add reassurance.
  - *Answer-if-applicable* (e.g. dietary restrictions) — a placeholder that says
    so ("Leave blank if you have none"). Not framed as required or optional.
- **Enforce required fields on the server, mirror on the client.** The submit
  endpoint is the source of truth (returns a friendly `{ error }`); the client
  repeats the same checks for instant feedback before the round-trip. Keep the
  two messages consistent. Current hard requirements to submit: a name, a
  connected GitHub, and the "what have you been building" box.

## Validation & errors

- **Missing required input → shake, no color.** An empty required field nudges
  the button with `.shake` (macOS-style) and shows no error text. Honors
  `prefers-reduced-motion`.
- **Failed request → inline message** below the action, `<p class="hint error">`,
  human and recoverable ("Couldn't save that. Try again?"). Re-enable the button
  (`setBusy(false)`) so the user can retry.
- **Live limits turn red in place.** The freeform counter (`.reg-counter`) goes
  red as it crosses the max; the button disables (and fades) rather than throwing
  an error on click.

## Icons

- **Library:** `lucide-react`. Sizes: 18 in-row / affordances, 20 leading
  service icons, 22 in primary buttons.
- **Align icons with flex, not baseline.** Icon wrappers (`.lead-icon`) are
  `display: flex; align-items: center` so the SVG centers against the text —
  an inline SVG in a span carries baseline whitespace and rides high.
- **Let the icon carry the identity.** In connect rows the service icon does the
  labeling; the text is `Connected <username> (<stat>)`, not "GitHub · …". Don't
  repeat in words what the icon already says.

## Destructive actions

- **Trash, reddening on hover.** Remove/disconnect uses a `Trash2` icon, neutral
  grey at rest, red (`#b91c1c`) on hover — the color change signals destructive.
  Prefer trash over a ban/no-entry glyph (ban reads as "blocked", not "remove")
  and over lucide's `Unlink` (muddy).
- **No confirm dialog for easily-reversible links.** Disconnecting a provider is
  one click; reconnecting is one click. Don't gate it behind a modal.

## Connections & formatted stats

- Each linked provider shows a stat captured at connect time next to the
  username. Formats:
  - **Counts:** `73 repositories` (singular `1 repository`).
  - **Durations:** `43hr 48min` (no space before the unit; `48min` under an
    hour). See `formatDuration` in `worker/index.ts`.
- We store the provider's **stable id** (`external_id`) and an **encrypted**
  access token, so a username change never orphans a link.

## Drafts & autosave

- **In-progress forms autosave to `localStorage`** so an accidental reload
  doesn't wipe them. It's a browser-only convenience — the server draft is the
  real store — so **clear the local copy the moment the step saves to the
  server** (don't let form data linger in `localStorage`). Keys are namespaced
  `hacksv:register:<step>`. All writes are best-effort (wrapped in try/catch).

## Layout

- **Left-align by default.** We don't center body text. Centering is reserved
  only for short single-line status (an inline error or connect notice). Helper
  lines, legal footers, and multi-line copy are left-aligned.

## Copy

- Sentence case. Terse. Secondary navigation is a lowercase text link ("back").
- No exclamatory filler ("All done!", "Success!") — the UI state is the
  feedback. A connected row is its own confirmation; don't also print a banner.
