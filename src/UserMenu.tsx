import { useEffect, useRef, useState } from 'react'
import { LogOut, Settings, User } from 'lucide-react'
import { useSession } from './session'
import './usermenu.css'

/**
 * Top-right account control: a plain white lucide user glyph (no background, no
 * circle). Clicking it opens a minimal square white panel — profile picture from
 * WorkOS if there is one, then Settings and Sign out. Everything inside is black
 * Nunito Sans on white; no gray, no dividers, no rounded corners.
 */
export default function UserMenu() {
  const { user, profile, logout } = useSession()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // We greet by preferred name, not legal name. Until the first registration
  // step is saved there's no preferred name yet, so fall back to a friendly nudge.
  const name = profile?.preferred_name?.trim() || 'Hello there ;)'
  const initial = (profile?.preferred_name?.trim() || user?.email || '?')
    .charAt(0)
    .toUpperCase()

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-label="Account"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <User size={24} strokeWidth={2} />
      </button>

      {open && (
        <div className="user-menu-pop" role="menu">
          <div className="user-menu-profile">
            {user?.profilePictureUrl ? (
              <img className="user-menu-avatar" src={user.profilePictureUrl} alt="" />
            ) : (
              <div className="user-menu-avatar user-menu-avatar-empty">{initial}</div>
            )}
            <div className="user-menu-identity">
              <p className="user-menu-name">{name}</p>
              {user?.email && <p className="user-menu-email">{user.email}</p>}
            </div>
          </div>

          <button type="button" className="user-menu-item" role="menuitem">
            <Settings size={20} strokeWidth={2} />
            <span>Settings</span>
          </button>
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            onClick={() => void logout()}
          >
            <LogOut size={20} strokeWidth={2} />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  )
}
