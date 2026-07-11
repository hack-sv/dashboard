import { useRef, useState } from 'react'
import { Mail, KeyRound, Loader2 } from 'lucide-react'
import { API_BASE } from './api'

// The 2026 submit arrow — plain long arrow, no box, stroke follows currentColor.
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

// Pragmatic RFC-ish check, ported from 2026: something@something.tld, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Step = 'prefilled' | 'email' | 'code' | 'verify'

/**
 * Minimal bring-your-own-UI login for WorkOS AuthKit:
 *  - "Continue with Google" (redirects through WorkOS → Google)
 *  - Magic Auth: enter email → receive a 6-digit code → enter it
 *
 * When arriving from the 2026 signup form (?email=…) we skip straight to a
 * "Send a code to <email>" button — no re-typing.
 *
 * The email box is ripped from hack.sv 2026: flat white field, long-arrow
 * submit, and dependency-free validation that just nudges the field on an
 * invalid address (macOS-password style — no message, no color change).
 */
export default function Login({
  initialEmail = '',
  initialError = '',
  verifyEmail = null,
  onAuthed,
}: {
  initialEmail?: string
  initialError?: string
  verifyEmail?: string | null
  onAuthed: () => void
}) {
  const prefill = initialEmail.trim()
  // ?verify present → jump straight to the email-verification (identity-linking) step.
  const [step, setStep] = useState<Step>(
    verifyEmail !== null ? 'verify' : EMAIL_RE.test(prefill) ? 'prefilled' : 'email',
  )
  const [email, setEmail] = useState(verifyEmail || prefill)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [shaking, setShaking] = useState(false)
  // Seed from ?error=… so a failed auth callback surfaces on the error line.
  const [error, setError] = useState<string | null>(initialError || null)
  const [notice, setNotice] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const value = email.trim()

    // Invalid input just nudges the field. Ignore repeat triggers mid-shake.
    if (!EMAIL_RE.test(value)) {
      emailRef.current?.focus()
      if (!shaking) setShaking(true)
      return
    }
    void sendCode(value)
  }

  async function sendCode(value: string, isResend = false) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`${API_BASE}/magic/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      })
      if (!res.ok) throw new Error()
      if (isResend) setNotice('sent you a new code!')
      else setStep('code')
    } catch {
      setError(isResend ? "Couldn't resend. Try again?" : "Couldn't send a code to that email. Try again?")
    } finally {
      setBusy(false)
    }
  }

  // Switch to the editable email input (from the prefilled or code step).
  function changeEmail() {
    setStep('email')
    setCode('')
    setError(null)
    setNotice(null)
  }

  // Clicking anywhere in the field (icon, padding) focuses the input — except
  // the submit button. preventDefault keeps the current selection from clearing.
  function focusFieldInput(e: React.MouseEvent<HTMLFormElement>) {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.closest('.submit')) return
    e.preventDefault()
    e.currentTarget.querySelector('input')?.focus()
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/magic/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      if (!res.ok) throw new Error()
      onAuthed()
    } catch {
      setError('That code was invalid or expired.')
    } finally {
      setBusy(false)
    }
  }

  // Complete WorkOS email-verification to link a new identity (e.g. Google) to
  // an existing account. The code was already emailed by the failed callback.
  async function submitVerification(e: React.FormEvent) {
    e.preventDefault()
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (!res.ok) throw new Error()
      onAuthed()
    } catch {
      setError('That code was invalid or expired.')
    } finally {
      setBusy(false)
    }
  }

  async function resendVerification() {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`${API_BASE}/verify-resend`, { method: 'POST' })
      if (!res.ok) throw new Error()
      setNotice('sent you a new code!')
    } catch {
      setError("Couldn't resend. Try again?")
    } finally {
      setBusy(false)
    }
  }

  const googleButton = (
    <button className="google-btn" onClick={() => (window.location.href = `${API_BASE}/google`)}>
      <span className="google-icon" aria-hidden="true" />
      Continue with Google
    </button>
  )

  // Email-verification linking — confirm ownership to connect Google
  if (step === 'verify') {
    return (
      <div className="auth-card">
        <form className="field" onSubmit={submitVerification} onMouseDown={focusFieldInput}>
          <KeyRound className="lead-icon" size={20} />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
          <button className="submit" type="submit" disabled={busy} aria-label="Confirm code">
            {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
          </button>
        </form>
        <p className="hint">
          One last step to connect Google: enter the code we emailed
          {email ? (
            <>
              {' '}
              to <strong>{email}</strong>
            </>
          ) : null}{' '}
          to confirm it's your hack.sv account.
        </p>
        <p className="hint">
          didn't get it?{' '}
          <button type="button" className="hint-link" onClick={resendVerification} disabled={busy}>
            resend it
          </button>
        </p>
        {notice && <p className="hint">{notice}</p>}
        {error && <p className="hint error">{error}</p>}
      </div>
    )
  }

  // Code entry
  if (step === 'code') {
    return (
      <div className="auth-card">
        <form className="field" onSubmit={verifyCode} onMouseDown={focusFieldInput}>
          <KeyRound className="lead-icon" size={20} />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
          <button className="submit" type="submit" disabled={busy} aria-label="Verify code">
            {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
          </button>
        </form>
        <p className="hint">
          we sent a one time code to <strong>{email}</strong>
        </p>
        <p className="hint">
          <button
            type="button"
            className="hint-link"
            onClick={() => void sendCode(email, true)}
            disabled={busy}
          >
            resend it
          </button>{' '}
          or{' '}
          <button type="button" className="hint-link" onClick={changeEmail} disabled={busy}>
            change email
          </button>
          ?
        </p>
        {notice && <p className="hint">{notice}</p>}
        {error && <p className="hint error">{error}</p>}
      </div>
    )
  }

  // Prefilled — came from the 2026 form, one tap to send the code
  if (step === 'prefilled') {
    return (
      <div className="auth-card">
        {googleButton}
        <button
          className="field field-btn"
          onClick={() => void sendCode(email)}
          disabled={busy}
        >
          <Mail className="lead-icon" size={20} />
          <span className="field-btn-label">
            {busy ? 'Sending…' : `Send a code to ${email}`}
          </span>
        </button>
        <p className="hint">
          <button type="button" className="hint-link" onClick={changeEmail} disabled={busy}>
            change email
          </button>
          ?
        </p>
        {error && <p className="hint error">{error}</p>}
      </div>
    )
  }

  // Default — type your email
  return (
    <div className="auth-card">
      {googleButton}

      <form
        className={`field${shaking ? ' shake' : ''}`}
        onSubmit={onEmailSubmit}
        onMouseDown={focusFieldInput}
        onAnimationEnd={() => setShaking(false)}
        noValidate
      >
        <Mail className="lead-icon" size={20} />
        <input
          ref={emailRef}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your.email@hack.sv"
          autoComplete="email"
          inputMode="email"
          aria-label="Email address"
          autoFocus={!!prefill}
        />
        <button className="submit" type="submit" disabled={busy} aria-label="Send code">
          {busy ? <Loader2 size={22} className="spin" /> : <Arrow />}
        </button>
      </form>

      <p className="hint">or enter your email and we'll send you a one time code!</p>
      {error && <p className="hint error">{error}</p>}
    </div>
  )
}
