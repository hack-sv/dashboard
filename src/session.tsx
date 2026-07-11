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

type Status = 'loading' | 'authed' | 'anon'

type Session = {
  status: Status
  user: User | null
  profile: Profile
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/session`)
      const data = (await res.json()) as { user: User | null; profile: Profile }
      setUser(data.user)
      setProfile(data.user ? data.profile : null)
      setStatus(data.user ? 'authed' : 'anon')
    } catch {
      setUser(null)
      setProfile(null)
      setStatus('anon')
    }
  }, [])

  const logout = useCallback(async () => {
    await fetch(`${API_BASE}/logout`, { method: 'POST' })
    setUser(null)
    setProfile(null)
    setStatus('anon')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <SessionContext.Provider value={{ status, user, profile, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
