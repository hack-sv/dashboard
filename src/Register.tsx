import { useMemo, useState } from 'react'
import { Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { Clock, Loader2, Check, X } from 'lucide-react'
import { API_BASE } from './api'
import { useSession, type Connection } from './session'
import { DateField } from './DateField'
import { PronounsField } from './PronounsField'
import './register.css'

const FREEFORM_MAX = 2000

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

  const [legalName, setLegalName] = useState(profile?.legal_name ?? '')
  const [preferredName, setPreferredName] = useState(profile?.preferred_name ?? '')
  const [pronouns, setPronouns] = useState(expandPronouns(profile?.pronouns))
  const [dob, setDob] = useState(profile?.dob ?? '')
  const [busy, setBusy] = useState(false)
  const [shaking, setShaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        className={`reg-btn${shaking ? ' shake' : ''}`}
        type="submit"
        disabled={busy}
        onAnimationEnd={() => setShaking(false)}
      >
        <span>Continue</span>
        {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
      </button>
      {error && <p className="hint error">{error}</p>}
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
  const { registration, connections, currentEvent, refresh } = useSession()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [dietary, setDietary] = useState(registration?.dietary_restrictions ?? '')
  const [freeform, setFreeform] = useState(registration?.freeform ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const github = findConn(connections, 'github')
  const hackatime = findConn(connections, 'hackatime')

  // Feedback from a connect round-trip (?connected=github / ?error=github_failed).
  const notice = useMemo(() => {
    const connected = searchParams.get('connected')
    if (connected) return { kind: 'ok' as const, text: `${label(connected)} connected!` }
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
    setBusy(true)
    setError(null)
    try {
      await saveDraft()
      const res = await fetch(`${API_BASE}/registration/submit`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error)
      }
      await refresh()
      navigate('/dashboard', { replace: true })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't submit. Try again?")
      setBusy(false)
    }
  }

  const over = freeform.length > FREEFORM_MAX

  return (
    <div className="reg-card">
      <h1 className="reg-title">Your application</h1>
      <p className="hint">
        A few last things for {currentEvent?.name ?? 'the event'}. Everything here is optional.
      </p>

      {notice && <p className={`hint${notice.kind === 'err' ? ' error' : ''}`}>{notice.text}</p>}

      <ConnectRow
        icon={<GithubMark size={20} />}
        label="GitHub"
        conn={github}
        onConnect={() => connect('github')}
        onDisconnect={() => disconnect('github')}
      />
      <ConnectRow
        icon={<Clock size={20} />}
        label="Hackatime"
        conn={hackatime}
        onConnect={() => connect('hackatime')}
        onDisconnect={() => disconnect('hackatime')}
      />

      <div>
        <TextField label="Dietary Restrictions" id="dietary" value={dietary} onChange={setDietary} />
        <p className="hint reg-sub">Leave blank if you have none.</p>
      </div>

      <FieldGroup label="Anything Else?" htmlFor="freeform">
        <div className="field field-area">
          <textarea
            id="freeform"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder="Optional — tell us anything you'd like."
            rows={5}
          />
        </div>
        <p className={`hint reg-sub reg-counter${over ? ' error' : ''}`}>
          {freeform.length}/{FREEFORM_MAX}
        </p>
      </FieldGroup>

      <button className="reg-btn" onClick={submit} disabled={busy || over}>
        <span>Submit application</span>
        {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
      </button>
      {error && <p className="hint error">{error}</p>}
      <p className="hint">
        <button type="button" className="hint-link" onClick={() => navigate('/register')}>
          back
        </button>
      </p>
    </div>
  )
}

function ConnectRow({
  icon,
  label,
  conn,
  onConnect,
  onDisconnect,
}: {
  icon: React.ReactNode
  label: string
  conn: Connection | null
  onConnect: () => void
  onDisconnect: () => void
}) {
  if (conn) {
    return (
      <div className="field field-connected">
        <span className="lead-icon">{icon}</span>
        <span className="field-btn-label">
          {label}
          {conn.username ? ` · ${conn.username}` : ''}
        </span>
        <Check size={18} className="reg-check" />
        <button
          type="button"
          className="reg-x"
          onClick={onDisconnect}
          aria-label={`Disconnect ${label}`}
        >
          <X size={18} />
        </button>
      </div>
    )
  }
  return (
    <button type="button" className="field field-btn" onClick={onConnect}>
      <span className="lead-icon">{icon}</span>
      <span className="field-btn-label">Connect {label}</span>
    </button>
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
}: {
  label: string
  id: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
}) {
  return (
    <FieldGroup label={label} htmlFor={id}>
      <div className="field">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
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
