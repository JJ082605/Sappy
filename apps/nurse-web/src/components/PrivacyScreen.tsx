// Hallway view for an unattended station. Patient details are hidden, but bed status stays live and
// leads the screen: an unattended station is exactly when an alert must still be seen from a distance.
// After a longer idle period, showing details again needs the password (the session stays alive so
// alerts keep arriving; it is never ended by inactivity).
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Ward } from '../lib/useWard'
import { bedState, displayTier, openGroups, tone } from '../lib/alerts'
import { STALE_MS, wardDataAge } from '../lib/freshness'
import { supabase } from '../lib/supabase'
import { BedStatus } from './Bits'

export function PrivacyScreen({ ward, now, locked, email, onShow }: {
  ward: Ward
  now: number
  locked: boolean
  email?: string
  onShow: () => void
}) {
  const groups = openGroups(ward.alerts)
  const beds = ward.beds.map((b) => {
    const state = bedState(ward.alerts, groups, b.patient.id)
    return { bed: b, state, tier: displayTier(state, ward.scores[b.patient.id]) }
  })
  const goNow = beds.filter((x) => x.state.kind === 'open' && x.state.tier === 'go now')
  const soon = beds.filter((x) => x.state.kind === 'open' && x.state.tier === 'check soon')
  // Never claim "all clear" from data that isn't loaded, live and fresh.
  const age = wardDataAge(ward, ward.beds.map((b) => b.patient.id), now)
  const fresh = ward.status === 'ready' && ward.live !== 'offline' && (age === undefined || age <= STALE_MS)
  const headline =
    ward.status === 'loading'
      ? 'Loading the ward…'
      : ward.status === 'error'
        ? 'Couldn’t load the ward'
        : goNow.length === 1
          ? `Bed ${goNow[0].bed.label} needs you now`
          : goNow.length > 1
            ? `${goNow.length} beds need you now`
            : soon.length === 1
              ? `Bed ${soon[0].bed.label} needs checking soon`
              : soon.length > 1
                ? `${soon.length} beds need checking soon`
                : fresh
                  ? 'No bed needs you right now'
                  : 'Bed status unknown'

  return (
    <div className={`veil ${goNow.length ? 'veil--urgent' : ''}`} role="dialog" aria-modal="true" aria-labelledby="veil-title">
      <div className="veil__inner">
        <span className="wordmark">Sappy</span>
        <h1 id="veil-title">{headline}</h1>
        <p className="sr-only" aria-live="assertive">{headline}</p>
        {fresh ? (
          <p className="veil__note">Patient details are hidden. Bed status stays live.</p>
        ) : (
          <p className="veil__note veil__note--warn" role="alert">
            Not receiving live updates. What you see may be out of date: check the beds directly.
          </p>
        )}
        <ul className="veil__beds">
          {beds.map(({ bed, state, tier }) => {
            const urgent = state.kind === 'open' && state.tier === 'go now'
            return (
              <li
                key={bed.patient.id}
                className={`veil__bed ${state.kind === 'taken' ? 'veil__bed--taken' : `veil__bed--${tone(tier)}`} ${urgent ? 'veil__bed--big' : ''}`}
              >
                <span className="veil__label">{bed.label}</span>
                <BedStatus state={state} now={now} />
              </li>
            )
          })}
        </ul>
        {locked ? <Unlock email={email} onShow={onShow} /> : <ShowButton onShow={onShow} />}
      </div>
    </div>
  )
}

function ShowButton({ onShow }: { onShow: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => button.current?.focus(), [])
  return (
    <button ref={button} className="btn btn--primary" onClick={onShow}>
      Show details
    </button>
  )
}

function Unlock({ email, onShow }: { email?: string; onShow: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email) return
    setBusy(true)
    setError(undefined)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError('That password doesn’t match the signed-in account.')
    else onShow()
  }

  return (
    <form className="veil__unlock" onSubmit={submit}>
      <label className="field field--dark">
        <span>Enter your password to show details</span>
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="veil__error" role="alert">{error}</p>}
      <div className="veil__actions">
        <button className="btn btn--primary" disabled={busy || !email}>{busy ? 'Checking…' : 'Show details'}</button>
        <button type="button" className="btn btn--onDark" onClick={() => void supabase.auth.signOut({ scope: 'local' })}>
          Sign out
        </button>
      </div>
    </form>
  )
}
