// Nurse station: sign in, then Alerts / Patients / Activity log, all live from Supabase.
import './App.css'
import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { openGroups, type OpenGroup } from './lib/alerts'
import { elapsed } from './lib/format'
import { useAlertChime, useHashPage, useNow, usePrivacyScreen, useSession, useStoredFlag } from './lib/hooks'
import { STALE_MS, scoringStalledFor, wardDataAge } from './lib/freshness'
import { useWard, type Ward } from './lib/useWard'
import { Sidebar, SignIn, type Page } from './components/Shell'
import { PrivacyScreen } from './components/PrivacyScreen'
import { Toast, type ToastMessage } from './components/Toast'
import { AlertsPage } from './pages/AlertsPage'
import { PatientsPage } from './pages/PatientsPage'
import { ActivityPage } from './pages/ActivityPage'

/** Hide patient details after this long without input (bed status stays live). */
const HIDE_AFTER_MS = 5 * 60_000
/** After this long without input, showing details again needs the password. */
const LOCK_AFTER_MS = 30 * 60_000

const PAGES: readonly Page[] = ['alerts', 'patients', 'activity']

export default function App() {
  const session = useSession()
  if (session === undefined) return <div className="boot" aria-busy="true" />
  if (!session) return <SignIn />
  return <Station session={session} />
}

function Station({ session }: { session: Session }) {
  const ward = useWard()
  const now = useNow()
  const [page, go] = useHashPage(PAGES, 'alerts')
  // Selected patient lives in memory only: no patient id in the URL or browser history.
  const [selected, setSelected] = useState<string>()
  const privacy = usePrivacyScreen(HIDE_AFTER_MS, LOCK_AFTER_MS)
  const [toast, setToast] = useState<ToastMessage>()
  const closeToast = useCallback(() => setToast(undefined), [])
  const say = (t: Omit<ToastMessage, 'id'>) => setToast({ ...t, id: Date.now() })

  const openPatient = (id: string) => {
    setSelected(id)
    go('patients')
  }

  /** "I'm on it" for every open alert of a bed, with a visible confirmation and Undo. */
  const take = async (g: OpenGroup) => {
    const bed = ward.bedFor(g.patientId)?.label
    const name = bed ? `Bed ${bed}` : 'This bed'
    try {
      const taken = await ward.take(g.alerts.map((a) => a.id))
      if (taken.length === 0) {
        say({ text: `${name} was already taken by another nurse.` })
        return
      }
      say({
        text: `${name}: you’re on it.`,
        undo: async () => {
          try {
            const reopened = await ward.undo(taken)
            say({ text: reopened ? `${name} is back in the queue.` : `${name} was taken again by someone else, so nothing changed.` })
          } catch {
            say({ text: `Couldn’t undo for ${name.toLowerCase()}. Check the connection and try again.`, error: true })
          }
        },
      })
    } catch {
      say({ text: `Couldn’t update ${name.toLowerCase()}. Check the connection and try again.`, error: true })
    }
  }

  const groups = openGroups(ward.alerts)
  const urgentOpen = groups.filter((g) => g.top.tier !== 'watch').length
  useEffect(() => {
    document.title = urgentOpen ? `(${urgentOpen}) Sappy nurse station` : 'Sappy nurse station'
  }, [urgentOpen])

  // A short chime when a new "go now" arrives (each new top alert counts, so re-alerts chime too).
  const [sound, setSound] = useStoredFlag('sappy.sound', true)
  const goNowSignature = groups
    .filter((g) => g.top.tier === 'go now')
    .map((g) => String(g.top.id))
    .sort()
    .join('|')
  useAlertChime(goNowSignature, sound && ward.status === 'ready')

  // While hidden, patient details aren't rendered at all (not just covered), so they can't be read
  // by removing the overlay in DevTools. Ward state stays alive here, so alerts keep updating.
  if (privacy.hidden) {
    return <PrivacyScreen ward={ward} now={now} locked={privacy.locked} email={session.user.email} onShow={privacy.show} />
  }

  return (
    <>
      <div className="app">
        <Sidebar
          page={page}
          go={go}
          openCount={urgentOpen}
          live={ward.live}
          ward={ward.beds[0]?.label.split('-')[0]}
          email={session.user.email}
          onHide={privacy.hide}
          sound={sound}
          onToggleSound={() => setSound(!sound)}
        />
        <main className="main" id="main">
          <StaleBanner ward={ward} now={now} />
          {ward.status === 'loading' && <p className="loading">Loading the ward…</p>}
          {ward.status === 'error' && (
            <section className="calm calm--error" role="alert">
              <h2>Couldn’t load the ward</h2>
              <p>Check the connection, then reload. If it keeps happening, the database may not be set up for this account.</p>
              {import.meta.env.DEV && <p className="footnote">{ward.error}</p>}
            </section>
          )}
          {ward.status === 'ready' && page === 'alerts' && (
            <AlertsPage ward={ward} now={now} openPatient={openPatient} take={take} />
          )}
          {ward.status === 'ready' && page === 'patients' && (
            <PatientsPage ward={ward} now={now} selectedId={selected} select={setSelected} take={take} />
          )}
          {ward.status === 'ready' && page === 'activity' && <ActivityPage ward={ward} now={now} openPatient={openPatient} />}
        </main>
      </div>
      <Toast toast={toast} onClose={closeToast} />
    </>
  )
}

/**
 * The "Live" dot only says the connection is up. This says whether data is actually arriving:
 * frozen vitals next to a green dot would be worse than no dashboard at all.
 */
function StaleBanner({ ward, now }: { ward: Ward; now: number }) {
  if (ward.status !== 'ready' || ward.beds.length === 0) return null
  const ids = ward.beds.map((b) => b.patient.id)
  const age = wardDataAge(ward, ids, now) ?? 0
  const vitalsProblem = ward.live === 'offline' || age > STALE_MS
  const stalled = scoringStalledFor(ward, ids, now)
  // role="alert" text stays fixed so screen readers announce it once; the ticking counter is hidden from them.
  return (
    <>
      {vitalsProblem && (
        <p className="stale" role="alert">
          {ward.live === 'live' ? 'No new vitals from any bed.' : 'Not receiving live updates.'} Everything on screen
          may be out of date. <span aria-hidden>({elapsed(age)})</span>
        </p>
      )}
      {stalled !== undefined && (
        <p className="stale" role="alert">
          Scoring has stopped: vitals are arriving but no NEWS2 scores, so new alerts may not appear. Check the
          beds directly. <span aria-hidden>({elapsed(stalled)})</span>
        </p>
      )}
    </>
  )
}
