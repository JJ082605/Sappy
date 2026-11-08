// Everything the dashboard shows, kept live from Supabase.
//
// `vitals` holds only each patient's latest reading, so the trend history used for charts is
// collected here from Realtime updates (it starts empty on page load and is never stored).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AlertRow, Encounter, HeldReadingRow, News2LatestRow, Patient, VitalsReading } from '@repo/shared'
import {
  fetchAlerts,
  fetchHeld,
  fetchLatestVitals,
  fetchScores,
  fetchWard,
  subscribeToHeld,
  subscribeToScores,
  subscribeToWard,
  takeAlerts,
  undoTake,
  type LiveStatus,
  type Taken,
  type WardEncounter,
} from './supabase'
import { mergeAlerts } from './alerts'

/** How far back the alert log and shift numbers go. */
export const SHIFT_HOURS = 12
/** Readings kept per patient for trend charts (2 s per tick in the live demo). */
const HISTORY_LIMIT = 120

export interface Bed {
  patient: Patient
  encounter: Encounter
  /** Display label only, e.g. "4W-02". Never use it as a key. */
  label: string
}

export interface Ward {
  status: 'loading' | 'ready' | 'error'
  error?: string
  live: LiveStatus
  beds: Bed[]
  bedFor: (patientId: string) => Bed | undefined
  latest: Record<string, VitalsReading>
  history: Record<string, VitalsReading[]>
  alerts: AlertRow[] // newest first
  /** Readings held back as likely false alarms, newest first (empty if the table isn't deployed). */
  held: HeldReadingRow[]
  /**
   * When each patient's vitals last ARRIVED live (browser clock). Readings carry the simulator's
   * clock, so freshness is judged by arrival, and the initial fetch doesn't count as fresh.
   */
  seen: Record<string, number>
  /** When the ward finished loading (browser clock). */
  readyAt?: number
  /** Latest NEWS2 per patient from the worker (live score, SpO2 scale). Empty if not deployed. */
  scores: Record<string, News2LatestRow>
  /** Whether the news2_latest feed exists (its migration is applied). */
  scoresAvailable: boolean
  /** When a score update last ARRIVED live (browser clock): the scoring worker's heartbeat. */
  scoresSeen?: number
  /** "I'm on it" for these alerts. Resolves to the rows this nurse took (others may have been taken already). */
  take: (ids: number[]) => Promise<Taken[]>
  /** Undo a take: reopens only rows still taken by that action. Resolves to how many reopened. */
  undo: (rows: Taken[]) => Promise<number>
}



function pushReading(history: Record<string, VitalsReading[]>, r: VitalsReading) {
  const list = history[r.patientId] ?? []
  const last = list[list.length - 1]
  if (last && last.recordedAt === r.recordedAt) return history
  // The simulator's clock goes back when it restarts: start that patient's trend over.
  const next = last && r.recordedAt < last.recordedAt ? [r] : [...list, r].slice(-HISTORY_LIMIT)
  return { ...history, [r.patientId]: next }
}

function upsertAlert(alerts: AlertRow[], a: AlertRow): AlertRow[] {
  const i = alerts.findIndex((x) => x.id === a.id)
  if (i === -1) return [a, ...alerts].sort((x, y) => y.created_at.localeCompare(x.created_at))
  const copy = alerts.slice()
  copy[i] = a
  return copy
}

export function useWard(): Ward {
  const [status, setStatus] = useState<Ward['status']>('loading')
  const [error, setError] = useState<string>()
  const [live, setLive] = useState<LiveStatus>('connecting')
  const [patients, setPatients] = useState<Patient[]>([])
  const [encounters, setEncounters] = useState<WardEncounter[]>([])
  const [latest, setLatest] = useState<Record<string, VitalsReading>>({})
  const [history, setHistory] = useState<Record<string, VitalsReading[]>>({})
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [held, setHeld] = useState<HeldReadingRow[]>([])
  const [seen, setSeen] = useState<Record<string, number>>({})
  const [readyAt, setReadyAt] = useState<number>()
  const [scores, setScores] = useState<Record<string, News2LatestRow>>({})
  const [scoresAvailable, setScoresAvailable] = useState(false)
  const [scoresSeen, setScoresSeen] = useState<number>()
  const knownPatients = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    const onVitals = (r: VitalsReading) => {
      setLatest((prev) => ({ ...prev, [r.patientId]: r }))
      setHistory((prev) => pushReading(prev, r))
    }
    const addHeld = (rows: HeldReadingRow[]) =>
      setHeld((prev) => {
        const ids = new Set(prev.map((h) => h.id))
        return [...prev, ...rows.filter((h) => !ids.has(h.id))].sort((a, b) => b.created_at.localeCompare(a.created_at))
      })
    const addScores = (rows: News2LatestRow[]) =>
      setScores((prev) => {
        const next = { ...prev }
        for (const r of rows) if (!next[r.patient_id] || next[r.patient_id].updated_at <= r.updated_at) next[r.patient_id] = r
        return next
      })

    // Load everything from the database. Runs on start and again on EVERY Realtime (re)join,
    // because Realtime doesn't replay events missed before joining or while disconnected: a "go now"
    // inserted during a Wi-Fi drop, or between the first read and the join, must still appear.
    let initialDone = false
    const load = (initial: boolean) => {
      const since = new Date(Date.now() - SHIFT_HOURS * 3600_000)
      // Optional feeds: a project without these migrations just shows none.
      fetchHeld(since).then((rows) => !cancelled && addHeld(rows), () => {})
      fetchScores().then(
        (rows) => {
          if (cancelled) return
          setScoresAvailable(true)
          addScores(rows)
        },
        () => {},
      )
      Promise.all([fetchWard(), fetchLatestVitals(), fetchAlerts(since)])
        .then(([ward, vitals, recent]) => {
          if (cancelled) return
          setPatients(ward.patients)
          setEncounters(ward.encounters)
          vitals.forEach(onVitals)
          setAlerts((prev) => mergeAlerts(prev, recent))
          knownPatients.current = new Set(ward.patients.map((p) => p.id))
          if (initial) {
            initialDone = true
            setReadyAt(Date.now())
          }
          setStatus('ready')
        })
        .catch((e: unknown) => {
          if (cancelled || !initial) return // a failed resync keeps the screen; the banner shows staleness
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
        })
    }

    // A reading for a patient we don't know means the ward changed (simulator admitted patients
    // after this page loaded): reload the bed list, at most every 10 s.
    let lastWardReload = 0
    const subscribeVitals = (r: VitalsReading) => {
      onVitals(r)
      setSeen((prev) => ({ ...prev, [r.patientId]: Date.now() }))
      if (initialDone && !knownPatients.current.has(r.patientId) && Date.now() - lastWardReload > 10_000) {
        lastWardReload = Date.now()
        load(false)
      }
    }

    const unsubscribe = subscribeToWard({
      onVitals: subscribeVitals,
      onAlert: (a) => setAlerts((prev) => upsertAlert(prev, a)),
      onAlertDeleted: (id) => setAlerts((prev) => prev.filter((a) => a.id !== id)),
      onStatus: (s) => {
        setLive(s)
        if (s === 'live') load(false) // joined or rejoined: catch up on anything missed
      },
    })
    const unsubscribeHeld = subscribeToHeld((h) => addHeld([h]))
    const unsubscribeScores = subscribeToScores((r) => {
      addScores([r])
      setScoresAvailable(true)
      setScoresSeen(Date.now())
    })
    load(true)
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeHeld()
      unsubscribeScores()
    }
  }, [])

  const beds = useMemo(() => {
    const byPatient = new Map(patients.map((p) => [p.id, p]))
    return encounters
      .flatMap((e) => {
        const patient = byPatient.get(e.patientId)
        return patient ? [{ patient, encounter: e, label: e.location.display }] : []
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [patients, encounters])

  const bedFor = useCallback(
    (patientId: string) => beds.find((b) => b.patient.id === patientId),
    [beds],
  )

  // Optimistic: open alerts are marked taken at once; the database's answer then replaces the
  // guess (rows someone else took first arrive via Realtime), and a failed write puts them back.
  const take = useCallback(async (ids: number[]) => {
    const guessed = new Set<number>()
    const guess = new Date().toISOString()
    setAlerts((prev) =>
      prev.map((a) => {
        if (!ids.includes(a.id) || a.status === 'completed') return a
        guessed.add(a.id)
        return { ...a, status: 'completed' as const, completed_at: guess }
      }),
    )
    try {
      const taken = await takeAlerts(ids)
      const stored = new Map(taken.map((t) => [t.id, t.completed_at]))
      setAlerts((prev) =>
        prev.map((a) => (stored.has(a.id) ? { ...a, status: 'completed' as const, completed_at: stored.get(a.id)! } : a)),
      )
      return taken
    } catch (e) {
      setAlerts((prev) =>
        prev.map((a) =>
          guessed.has(a.id) && a.completed_at === guess ? { ...a, status: 'incomplete' as const, completed_at: null } : a,
        ),
      )
      throw e
    }
  }, [])

  const undo = useCallback(async (rows: Taken[]) => {
    const reopened = await undoTake(rows)
    const mine = new Map(rows.map((r) => [r.id, r.completed_at]))
    setAlerts((prev) =>
      prev.map((a) =>
        mine.has(a.id) && a.completed_at === mine.get(a.id) ? { ...a, status: 'incomplete' as const, completed_at: null } : a,
      ),
    )
    return reopened
  }, [])

  return {
    status, error, live, beds, bedFor, latest, history, alerts, held, seen, readyAt,
    scores, scoresAvailable, scoresSeen, take, undo,
  }
}
