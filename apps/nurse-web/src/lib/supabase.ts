// Supabase browser client for the nurse dashboard.
//
// Uses the publishable key: data is only readable after sign-in (Row Level Security, see
// server/supabase/migrations/). Never put the secret key in this app.
//
// Env (apps/nurse-web/.env locally, Vercel project settings in production):
//   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY

import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import {
  encounterFromRow,
  patientFromRow,
  vitalsFromRow,
  type AlertRow,
  type Encounter,
  type EncounterRow,
  type HeldReadingRow,
  type News2LatestRow,
  type Patient,
  type PatientRow,
  type VitalsReading,
  type VitalsRow,
} from '@repo/shared'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !publishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy apps/nurse-web/.env.example to ' +
      'apps/nurse-web/.env (or set them in Vercel).',
  )
}

// Session lives in sessionStorage, not localStorage: it ends with the browser session on a shared
// ward workstation (unless the browser restores the tab). Idle hiding and the password lock, which
// survive a reload: lib/hooks.ts usePrivacyScreen + components/PrivacyScreen.tsx.
export const supabase = createClient(url, publishableKey, {
  auth: { storage: window.sessionStorage, persistSession: true },
})

// Explicit columns (never `*`) so a column added later doesn't silently reach the browser.
const PATIENT_COLS = 'id, age_band, gender, conditions, medications'
const ENCOUNTER_COLS = 'id, patient_id, status, class, location_id, bed_label'
const VITALS_COLS =
  'patient_id, encounter_id, recorded_at, heart_rate_bpm, systolic_mmhg, diastolic_mmhg, spo2_percent, temperature_c, respiratory_rate, on_oxygen, consciousness'
const ALERT_COLS = 'id, patient_id, encounter_id, created_at, tier, news2_score, reason, status, completed_at'
const HELD_COLS = 'id, patient_id, encounter_id, created_at, recorded_at, held_tier, news2_score, reason'
const SCORE_COLS = 'patient_id, encounter_id, recorded_at, score, tier, confirmed_tier, spo2_scale, reason, updated_at'

/** Patients and their current in-progress encounters (bed = `encounter.location.display`). */
export async function fetchWard(): Promise<{ patients: Patient[]; encounters: WardEncounter[] }> {
  const [patients, encounters] = await Promise.all([
    supabase.from('patients').select(PATIENT_COLS),
    supabase.from('encounters').select(ENCOUNTER_COLS).eq('status', 'in-progress'),
  ])
  if (patients.error) throw patients.error
  if (encounters.error) throw encounters.error
  return {
    patients: (patients.data as PatientRow[]).map(patientFromRow),
    encounters: (encounters.data as EncounterRow[]).map((r) => ({ ...encounterFromRow(r), patientId: r.patient_id })),
  }
}

/** An in-progress encounter plus the (pseudonymous) patient it belongs to. */
export type WardEncounter = Encounter & { patientId: string }

/** Each patient's latest reading (the `vitals` table holds one row per patient). */
export async function fetchLatestVitals(): Promise<VitalsReading[]> {
  const { data, error } = await supabase.from('vitals').select(VITALS_COLS)
  if (error) throw error
  return (data as VitalsRow[]).map(vitalsFromRow)
}

/**
 * Alerts created since `since`, plus every alert still waiting whatever its age (an open "go now"
 * must never fall out of a time window), newest first.
 */
export async function fetchAlerts(since: Date): Promise<AlertRow[]> {
  const { data, error } = await supabase
    .from('alerts')
    .select(ALERT_COLS)
    .or(`created_at.gte.${since.toISOString()},status.eq.incomplete`)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return data as AlertRow[]
}

/**
 * Readings the NEWS2 persistence rule held back and the next reading didn't confirm (likely false
 * alarms such as a loose SpO2 probe). Never alerts: shown only in the Activity log.
 */
export async function fetchHeld(since: Date): Promise<HeldReadingRow[]> {
  const { data, error } = await supabase
    .from('held_readings')
    .select(HELD_COLS)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return data as HeldReadingRow[]
}

/** Own channel, so a project without the held_readings migration only loses this feed. */
export function subscribeToHeld(onHeld: (row: HeldReadingRow) => void): () => void {
  const channel = supabase
    .channel('held')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'held_readings' }, (payload) =>
      onHeld(payload.new as HeldReadingRow),
    )
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

/**
 * Each patient's latest NEWS2 (one row per patient, upserted by the worker for every reading): the
 * live score, the SpO2 scale in use, and a heartbeat that shows whether scoring is still running.
 */
export async function fetchScores(): Promise<News2LatestRow[]> {
  const { data, error } = await supabase.from('news2_latest').select(SCORE_COLS)
  if (error) throw error
  return data as News2LatestRow[]
}

/** Own channel, so a project without the news2_latest migration only loses this feed. */
export function subscribeToScores(onScore: (row: News2LatestRow) => void): () => void {
  const channel = supabase
    .channel('scores')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'news2_latest' }, (payload) => {
      if (payload.eventType !== 'DELETE') onScore(payload.new as News2LatestRow)
    })
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

export type LiveStatus = 'connecting' | 'live' | 'offline'

/**
 * Live vitals + alerts. Returns an unsubscribe function (call it on unmount).
 * The simulator updates each patient's `vitals` row in place every tick, so this listens for
 * UPDATE (and the first INSERT). Keep any history you want to chart in component state.
 */
export function subscribeToWard(handlers: {
  onVitals?: (reading: VitalsReading) => void
  onAlert?: (alert: AlertRow) => void
  /** An alert row was deleted (e.g. the simulator's --reset). Only the id is known. */
  onAlertDeleted?: (id: number) => void
  onStatus?: (status: LiveStatus) => void
}): () => void {
  const channel: RealtimeChannel = supabase
    .channel('ward')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vitals' }, (payload) => {
      if (payload.eventType !== 'DELETE') handlers.onVitals?.(vitalsFromRow(payload.new as VitalsRow))
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        // With the default replica identity a DELETE carries only the primary key.
        const id = (payload.old as Partial<AlertRow>).id
        if (typeof id === 'number') handlers.onAlertDeleted?.(id)
      } else handlers.onAlert?.(payload.new as AlertRow)
    })
    .subscribe((status) => {
      handlers.onStatus?.(status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' ? 'offline' : 'connecting')
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}

export type Taken = Pick<AlertRow, 'id' | 'completed_at'>

/**
 * "I'm on it": status 'incomplete' -> 'completed'. Only alerts nobody has taken yet are updated, so
 * one nurse never overwrites another's. The database stamps completed_at (trigger in the
 * migrations), so response times don't depend on this computer's clock. Returns the rows THIS call
 * took (possibly none).
 */
export async function takeAlerts(ids: number[]): Promise<Taken[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('alerts')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'incomplete')
    .select('id, completed_at')
  if (error) throw error
  return (data ?? []) as Taken[]
}

/** Undo: reopen only the rows this nurse took, and only if nobody has re-taken them since. */
export async function undoTake(rows: Taken[]): Promise<number> {
  let reopened = 0
  for (const at of new Set(rows.map((r) => r.completed_at))) {
    if (at === null) continue
    const ids = rows.filter((r) => r.completed_at === at).map((r) => r.id)
    const { data, error } = await supabase
      .from('alerts')
      .update({ status: 'incomplete', completed_at: null })
      .in('id', ids)
      .eq('status', 'completed')
      .eq('completed_at', at)
      .select('id')
    if (error) throw error
    reopened += (data ?? []).length
  }
  return reopened
}
