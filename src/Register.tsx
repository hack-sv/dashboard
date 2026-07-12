import { useEffect, useMemo, useState } from 'react'
import { Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { Clock, Loader2, Trash2 } from 'lucide-react'
import { API_BASE } from './api'
import { useSession, type Connection } from './session'
import { DateField } from './DateField'
import { PronounsField } from './PronounsField'
import './register.css'

// Generous cap on the free-form field — high enough that no genuine answer hits
// it (the point), low enough to bound abuse. 32k chars is trivial storage.
// Keep in sync with FREEFORM_MAX in worker/config.ts.
const FREEFORM_MAX = 32000

// Browser-only autosave so an accidental reload doesn't wipe an in-progress
// form. Purely a client convenience — the server draft is the real store — so
// we clear the local copy the moment the step is saved to the server.
const PERSONAL_DRAFT_KEY = 'hacksv:register:personal'
const APPLICATION_DRAFT_KEY = 'hacksv:register:application'

function loadDraft(key: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}
function saveDraftLocal(key: string, data: Record<string, string>) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // best-effort: storage disabled or full — the server draft still covers us
  }
}
function clearDraftLocal(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// Provisional pronoun "standardization": expand the common short forms to their
// full set so returning users see something complete, and let them edit if it's
// wrong. A proper standardized picker comes later (reusing DateField's pattern).
const PRONOUN_EXPANSIONS: Record<string, string> = {
  'he/him': 'he/him/his',
  'she/her': 'she/her/hers',
  'they/them': 'they/them/theirs',
}
function expandPronouns(p?: string | null): string {
  if (!p) return ''
  return PRONOUN_EXPANSIONS[p.trim().toLowerCase()] ?? p
}

// GitHub mark — this lucide fork dropped brand icons, so inline the octocat.
function GithubMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  )
}

// Long-arrow submit, matching the login screen.
function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path
        d="M4 12h15M13 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** /register/* — a two-step wizard: personal info, then the per-event application. */
export default function Register() {
  return (
    <div className="screen register-screen">
      <header className="site-header">
        <a className="wordmark" href="/2026">
          hack.sv
        </a>
      </header>
      <div className="screen-center">
        <Routes>
          <Route index element={<PersonalStep />} />
          <Route path="application" element={<ApplicationStep />} />
        </Routes>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — personal info. Returning users land straight on the prefilled form
// (no separate confirmation screen): just Continue if it's right, edit if not.
// ---------------------------------------------------------------------------

function PersonalStep() {
  const { profile, refresh } = useSession()
  const navigate = useNavigate()
  const hasInfo = !!(profile?.legal_name || profile?.preferred_name)

  // Restore an accidental-reload draft if one exists, else the saved profile.
  const [draft] = useState(() => loadDraft(PERSONAL_DRAFT_KEY))
  const [legalName, setLegalName] = useState(draft?.legalName ?? profile?.legal_name ?? '')
  const [preferredName, setPreferredName] = useState(
    draft?.preferredName ?? profile?.preferred_name ?? '',
  )
  const [pronouns, setPronouns] = useState(draft?.pronouns ?? expandPronouns(profile?.pronouns))
  const [dob, setDob] = useState(draft?.dob ?? profile?.dob ?? '')
  const [busy, setBusy] = useState(false)
  const [shaking, setShaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    saveDraftLocal(PERSONAL_DRAFT_KEY, { legalName, preferredName, pronouns, dob })
  }, [legalName, preferredName, pronouns, dob])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!legalName.trim() && !preferredName.trim()) {
      if (!shaking) setShaking(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legal_name: legalName,
          preferred_name: preferredName,
          pronouns,
          dob,
        }),
      })
      if (!res.ok) throw new Error()
      clearDraftLocal(PERSONAL_DRAFT_KEY)
      await refresh()
      navigate('application')
    } catch {
      setError("Couldn't save that. Try again?")
      setBusy(false)
    }
  }

  return (
    <form className="reg-card" onSubmit={submit}>
      <h1 className="reg-title">{hasInfo ? 'Your info' : "Let's get you set up"}</h1>

      <TextField
        label="Legal Name"
        id="legal"
        value={legalName}
        onChange={setLegalName}
        autoFocus={!hasInfo}
      />
      <TextField
        label="Preferred Name"
        id="preferred"
        value={preferredName}
        onChange={setPreferredName}
      />
      <FieldGroup label="Pronouns" htmlFor="pronouns">
        <PronounsField id="pronouns" value={pronouns} onChange={setPronouns} />
      </FieldGroup>
      <FieldGroup label="Date of Birth" htmlFor="dob">
        <DateField id="dob" value={dob} onChange={setDob} />
      </FieldGroup>

      <button
        className={`reg-btn${shaking ? ' shake' : ''}${busy ? ' is-busy' : ''}`}
        type="submit"
        disabled={busy}
        onAnimationEnd={() => setShaking(false)}
      >
        <span>Continue</span>
        {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
      </button>
      {error && <p className="hint error">{error}</p>}
      <LegalNote />
    </form>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — the per-event application
// ---------------------------------------------------------------------------

function findConn(connections: Connection[], provider: string) {
  return connections.find((c) => c.provider === provider) ?? null
}

function ApplicationStep() {
  const { registration, connections, refresh } = useSession()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Restore an accidental-reload draft if one exists, else the saved registration.
  const [draft] = useState(() => loadDraft(APPLICATION_DRAFT_KEY))
  const [dietary, setDietary] = useState(draft?.dietary ?? registration?.dietary_restrictions ?? '')
  const [freeform, setFreeform] = useState(draft?.freeform ?? registration?.freeform ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    saveDraftLocal(APPLICATION_DRAFT_KEY, { dietary, freeform })
  }, [dietary, freeform])

  const github = findConn(connections, 'github')
  const hackatime = findConn(connections, 'hackatime')

  // Feedback from a failed connect round-trip (?error=github_failed). Success
  // needs no message — the connected row shows the linked account itself.
  const notice = useMemo(() => {
    const err = searchParams.get('error')
    if (err) {
      const provider = err.split('_')[0]
      if (err.endsWith('not_configured'))
        return { kind: 'err' as const, text: `${label(provider)} isn't set up yet.` }
      return { kind: 'err' as const, text: `Couldn't connect ${label(provider)}. Try again?` }
    }
    return null
  }, [searchParams])

  async function saveDraft() {
    await fetch(`${API_BASE}/registration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dietary_restrictions: dietary, freeform }),
    })
  }

  // Persist the in-progress fields before leaving the page to connect a provider.
  async function connect(provider: string) {
    await saveDraft()
    window.location.href = `${API_BASE}/connect/${provider}`
  }

  async function disconnect(provider: string) {
    await fetch(`${API_BASE}/connect/${provider}/disconnect`, { method: 'POST' })
    await refresh()
  }

  async function submit() {
    if (busy) return
    if (freeform.length > FREEFORM_MAX) return
    // The two hard requirements on this step (mirrored server-side).
    if (!github) {
      setError('Please connect GitHub to submit.')
      return
    }
    if (!freeform.trim()) {
      setError('Tell us a bit about what you’ve been building.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveDraft()
      const res = await fetch(`${API_BASE}/registration/submit`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error)
      }
      clearDraftLocal(APPLICATION_DRAFT_KEY)
      await refresh()
      navigate('/dashboard', { replace: true })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't submit. Try again?")
      setBusy(false)
    }
  }

  return (
    <div className="reg-card">
      <h1 className="reg-title">A few more things</h1>

      {notice && <p className={`hint${notice.kind === 'err' ? ' error' : ''}`}>{notice.text}</p>}

      <ConnectRow
        icon={<GithubMark size={20} />}
        label="GitHub"
        required
        conn={github}
        onConnect={() => connect('github')}
        onDisconnect={() => disconnect('github')}
      />
      <ConnectRow
        icon={<Clock size={20} />}
        label="Hackatime"
        conn={hackatime}
        note="Hackatime is optional. If you have it, feel free to connect it!"
        onConnect={() => connect('hackatime')}
        onDisconnect={() => disconnect('hackatime')}
      />

      <TextField
        label="Dietary Restrictions"
        id="dietary"
        value={dietary}
        onChange={setDietary}
        placeholder="Leave blank if you have none"
      />

      <FieldGroup label="What have you been building?" htmlFor="freeform">
        <div className="field field-area">
          <textarea
            id="freeform"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder="Drop links to cool projects you've built, or tell us what you've been working on lately."
            rows={5}
            maxLength={FREEFORM_MAX}
          />
        </div>
      </FieldGroup>

      <button className={`reg-btn${busy ? ' is-busy' : ''}`} onClick={submit} disabled={busy}>
        <span>Submit application</span>
        {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
      </button>
      {error && <p className="hint error">{error}</p>}
      <LegalNote />
    </div>
  )
}

// Legal footer shown at the bottom of each registration step. Links point at the
// standalone /privacy and /conduct pages (outside the SPA), so plain anchors.
function LegalNote() {
  return (
    <p className="reg-legal">
      All data submitted is processed accordingly to our{' '}
      <a href="/privacy">privacy policy</a>.
      <br />
      Please make sure your application follows our <a href="/conduct">code of conduct</a>.
    </p>
  )
}

function ConnectRow({
  icon,
  label,
  conn,
  required,
  note,
  onConnect,
  onDisconnect,
}: {
  icon: React.ReactNode
  label: string
  conn: Connection | null
  required?: boolean
  note?: string
  onConnect: () => void
  onDisconnect: () => void
}) {
  if (conn) {
    // Icon conveys the service; text is "Connected <username> (<detail>)".
    const who = conn.username ? ` ${conn.username}` : ''
    const detail = conn.detail ? ` (${conn.detail})` : ''
    return (
      <div className="field field-connected">
        <span className="lead-icon">{icon}</span>
        <span className="field-btn-label">
          Connected{who}
          {detail}
        </span>
        <button
          type="button"
          className="reg-x"
          onClick={onDisconnect}
          aria-label={`Disconnect ${label}`}
        >
          <Trash2 size={18} />
        </button>
      </div>
    )
  }
  return (
    <div className="connect-row">
      <button type="button" className="field field-btn" onClick={onConnect}>
        <span className="lead-icon">{icon}</span>
        <span className="field-btn-label">Connect {label}</span>
        {/* Required rows carry no tag; optional ones say so, in blue. */}
        {!required && <span className="field-tag">Optional</span>}
      </button>
      {note && <p className="reg-note">{note}</p>}
    </div>
  )
}

// A small white label sitting just above its input.
function FieldGroup({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="reg-field-group">
      <label className="reg-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

// Labeled single-line white input (no icon), matching the login screen's box.
function TextField({
  label,
  id,
  value,
  onChange,
  autoFocus,
  placeholder,
}: {
  label: string
  id: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  placeholder?: string
}) {
  return (
    <FieldGroup label={label} htmlFor={id}>
      <div className="field">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          placeholder={placeholder}
        />
      </div>
    </FieldGroup>
  )
}

function label(provider: string) {
  if (provider === 'github') return 'GitHub'
  if (provider === 'hackatime') return 'Hackatime'
  return provider
}
