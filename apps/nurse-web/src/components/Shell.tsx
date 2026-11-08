import { useState, type FormEvent, type ReactNode } from 'react'
import type { LiveStatus } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { BedIcon, BellIcon, EyeOffIcon, LogIcon, SignOutIcon, SoundIcon } from './Icons'

export type Page = 'alerts' | 'patients' | 'activity'

const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'alerts', label: 'Alerts', icon: <BellIcon /> },
  { id: 'patients', label: 'Patients', icon: <BedIcon /> },
  { id: 'activity', label: 'Activity log', icon: <LogIcon /> },
]

const LIVE_TEXT: Record<LiveStatus, string> = { live: 'Live', connecting: 'Reconnecting…', offline: 'Offline' }

/** "dana.nurse@example.org" -> "DN". The full email isn't shown on a shared screen. */
const initials = (email?: string) =>
  (email ?? '')
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'

export function Sidebar({ page, go, openCount, live, ward, email, onHide, sound, onToggleSound }: {
  page: Page
  go: (p: Page) => void
  openCount: number
  live: LiveStatus
  ward?: string
  email?: string
  onHide: () => void
  sound: boolean
  onToggleSound: () => void
}) {
  return (
    <aside className="side">
      <div className="side__brand">
        <span className="wordmark">Sappy</span>
        <span className="side__for">Nurse station</span>
      </div>
      <nav aria-label="Main">
        <ul className="nav">
          {NAV.map((n) => (
            <li key={n.id}>
              <a
                href={`#/${n.id}`}
                className={`nav__link ${page === n.id ? 'is-active' : ''}`}
                aria-current={page === n.id ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  go(n.id)
                }}
              >
                {n.icon}
                <span>{n.label}</span>
                {n.id === 'alerts' && openCount > 0 && <span className="nav__count" aria-label={`${openCount} open`}>{openCount}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="side__foot">
        <p className={`livedot livedot--${live}`}>
          <span aria-hidden className="livedot__dot" />
          {LIVE_TEXT[live]}{ward && <span className="side__ward">Ward {ward}</span>}
        </p>
        <p className="side__user">
          <span className="avatar" aria-hidden>{initials(email)}</span> Signed in
        </p>
        <button className="side__out" onClick={onToggleSound} aria-pressed={sound}>
          <SoundIcon muted={!sound} /> {sound ? 'Sound on' : 'Sound off'}
        </button>
        <button className="side__out" onClick={onHide}>
          <EyeOffIcon /> Hide screen
        </button>
        <button className="side__out side__out--sep" onClick={() => void supabase.auth.signOut({ scope: 'local' })}>
          <SignOutIcon /> Sign out
        </button>
      </div>
    </aside>
  )
}

export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error.message === 'Invalid login credentials' ? 'That email and password don’t match a staff account.' : error.message)
  }

  return (
    <main className="signin">
      <form className="signin__card" onSubmit={submit}>
        <span className="wordmark wordmark--dark">Sappy</span>
        <h1>Sign in to the nurse station</h1>
        <p className="signin__note">Staff accounts only. Patients are shown by bed and age band, never by name.</p>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="signin__error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--wide" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
