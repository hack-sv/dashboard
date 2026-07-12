import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { API_BASE } from './api'

export type User = {
  id: string
  email: string
  firstName?: string | null
  lastName?: string | null
  profilePictureUrl?: string | null
  [key: string]: unknown
}

// The D1 profile row, or null when the email isn't found.
export type Profile = {
  id: string
  email: string
  legal_name?: string | null
  preferred_name?: string | null
  pronouns?: string | null
  dob?: string | null
  discord_id?: string | null
  events?: string[] | string | null
} | null

// Per-event application row, or null before the user starts one.
export type Registration = {
  id: string
  user_id: string
  event_slug: string
  dietary_restrictions: string | null
  freeform: string | null
  status: 'draft' | 'submitted' | 'accepted' | 'rejected' | 'waitlisted' | string
  created_at: number
  updated_at: number
  submitted_at: number | null
} | null

// Account-level OAuth link (never carries the access token).
export type Connection = {
  provider: string
  external_id: string | null
  username: string | null
  detail: string | null
  scopes: string | null
  connected_at: number
}

export type CurrentEvent = { slug: string; name: string }

type Status = 'loading' | 'authed' | 'anon'

type SessionData = {
  user: User | null
  profile: Profile
  registration: Registration
  connections: Connection[]
  currentEvent: CurrentEvent | null
}

type Session = SessionData & {
  status: Status
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const EMPTY: SessionData = {
  user: null,
  profile: null,
  registration: null,
  connections: [],
  currentEvent: null,
}

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [data, setData] = useState<SessionData>(EMPTY)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/session`)
      const d = (await res.json()) as Partial<SessionData>
      if (d.user) {
        setData({
          user: d.user,
          profile: d.profile ?? null,
          registration: d.registration ?? null,
          connections: d.connections ?? [],
          currentEvent: d.currentEvent ?? null,
        })
        setStatus('authed')
      } else {
        setData(EMPTY)
        setStatus('anon')
      }
    } catch {
      setData(EMPTY)
      setStatus('anon')
    }
  }, [])

  const logout = useCallback(async () => {
    await fetch(`${API_BASE}/logout`, { method: 'POST' })
    setData(EMPTY)
    setStatus('anon')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <SessionContext.Provider value={{ status, ...data, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
