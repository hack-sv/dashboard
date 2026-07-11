import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import WaveBackground from './WaveBackground'
import Login from './Login'
import { SessionProvider, useSession, type Profile, type User } from './session'
import './login.css'

function App() {
  return (
    <SessionProvider>
      <WaveBackground />
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </SessionProvider>
  )
}

function AuthPage() {
  const { status, refresh } = useSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // Capture ?email=... (from the 2026 signup form) and ?error=... (from a failed
  // auth callback) once, before we strip them from the URL.
  const [initialEmail] = useState(() => searchParams.get('email') ?? '')
  const [initialError] = useState(() => searchParams.get('error') ?? '')
  // ?verify=<email> means WorkOS wants an email-verification code to link a new
  // identity (e.g. Google) to an existing account.
  const [verifyEmail] = useState(() => searchParams.get('verify'))

  // Immediately strip these params from the URL so they don't linger.
  useEffect(() => {
    if (['email', 'error', 'verify'].some((k) => searchParams.has(k))) {
      const next = new URLSearchParams(searchParams)
      next.delete('email')
      next.delete('error')
      next.delete('verify')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (status === 'authed') return <Navigate to="/dashboard" replace />

  async function onAuthed() {
    await refresh()
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className="screen auth-screen">
      <header className="site-header">
        <a className="wordmark" href="/2026">
          hack.sv
        </a>
      </header>
      <div className="screen-center">
        <Login
          initialEmail={initialEmail}
          initialError={initialError}
          verifyEmail={verifyEmail}
          onAuthed={onAuthed}
        />
      </div>
    </div>
  )
}

function DashboardPage() {
  const { status, user, profile, logout } = useSession()
  if (status === 'loading') return null
  if (status === 'anon' || !user) return <Navigate to="/auth" replace />

  return (
    <div className="screen screen-center">
      <UserCard user={user} profile={profile} onLogout={logout} />
    </div>
  )
}

function UserCard({
  user,
  profile,
  onLogout,
}: {
  user: User
  profile: Profile
  onLogout: () => void
}) {
  const name = profile?.preferred_name || profile?.legal_name || user.email
  const events = Array.isArray(profile?.events) ? profile.events : []

  return (
    <div className="user-card">
      <h2>Signed in as {name}</h2>

      <h3>D1 profile</h3>
      {profile ? (
        <dl className="profile">
          <Row label="Email" value={profile.email} />
          <Row label="Legal name" value={profile.legal_name} />
          <Row label="Preferred name" value={profile.preferred_name} />
          <Row label="Pronouns" value={profile.pronouns} />
          <Row label="Date of birth" value={profile.dob} />
          <Row label="Discord ID" value={profile.discord_id} />
          <Row label="Events" value={events.length ? events.join(', ') : null} />
        </dl>
      ) : (
        <p className="no-info">No info available for {user.email}.</p>
      )}

      <h3>WorkOS account</h3>
      <pre>{JSON.stringify(user, null, 2)}</pre>

      <button className="logout-btn" onClick={onLogout}>
        Sign out
      </button>
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || <span className="muted">—</span>}</dd>
    </>
  )
}

export default App
