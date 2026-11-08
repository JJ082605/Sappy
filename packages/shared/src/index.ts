// Types and helpers shared by the nurse dashboard and the patient app.
//
// Privacy (CLAUDE.md): no names, birthdates, addresses or identifiers past the transform step.
// Key everything on pseudonymous ids; a bed is a display label only, never a key.

export interface Patient {
  id: string // pseudonymous (Synthea Patient.id)
  ageBand: string // e.g. "70-79", "90+"
  gender?: 'male' | 'female' | 'other' | 'unknown'
  conditions?: string[]
  medications?: string[]
}

/** In-progress inpatient stay. `location.display` is the bed label - show it, never key on it. */
export interface Encounter {
  id: string
  status: 'in-progress'
  class: 'IMP'
  location: { id: string; display: string }
}

export interface VitalsReading {
  patientId: string
  encounterId?: string
  recordedAt: string // ISO 8601
  heartRateBpm?: number
  systolicMmHg?: number
  diastolicMmHg?: number
  spo2Percent?: number
  temperatureC?: number
  respiratoryRate?: number // breaths/min
  onOxygen?: boolean // supplemental oxygen (false = room air)
  consciousness?: Consciousness
}

/** ACVPU: Alert, new Confusion, responds to Voice, responds to Pain, Unresponsive. */
export type Consciousness = 'A' | 'C' | 'V' | 'P' | 'U'

// ---------------------------------------------------------------------------------------------
// Supabase rows (snake_case, see server/supabase/migrations/). Keep in sync with the SQL, or replace with
// `supabase gen types typescript` output.
// ---------------------------------------------------------------------------------------------

/** One row per patient holding their LATEST reading (upserted every tick, no history). */
export interface VitalsRow {
  patient_id: string // primary key
  encounter_id: string
  recorded_at: string
  heart_rate_bpm: number | null
  systolic_mmhg: number | null
  diastolic_mmhg: number | null
  spo2_percent: number | null
  temperature_c: number | string | null // Postgres numeric may arrive as a string
  respiratory_rate: number | null
  on_oxygen: boolean | null
  consciousness: Consciousness | null
}

export type AlertTier = 'watch' | 'check soon' | 'go now'

/** 'incomplete' = waiting for a nurse; 'completed' = a nurse handled it ("I'm on it"). */
export type AlertStatus = 'incomplete' | 'completed'

export interface AlertRow {
  id: number
  patient_id: string
  encounter_id: string
  created_at: string
  tier: AlertTier
  news2_score: number | null
  reason: string
  status: AlertStatus
  /** Set (database time) when status becomes 'completed'; null while incomplete. */
  completed_at: string | null
}

/**
 * Columns a writer supplies when inserting an alert (`id`, `created_at`, `status` and
 * `completed_at` are filled by the database / the nurse). Used by the NEWS2 worker's alerts and by the patient
 * app's assistant (item requests, nurse calls, emergencies; `news2_score` is null for those).
 * `reason` must never contain patient free text.
 */
export type NewAlertRow = Pick<AlertRow, 'patient_id' | 'encounter_id' | 'tier' | 'news2_score' | 'reason'>

/**
 * A reading the NEWS2 persistence rule held back and the next reading did not confirm (e.g. a loose
 * SpO2 probe), written by the alert worker. Not an alert: nobody is paged, nothing to acknowledge.
 */
export interface HeldReadingRow {
  id: number
  patient_id: string
  encounter_id: string
  created_at: string // when the worker wrote it (after the next reading)
  recorded_at: string // the held reading's own (simulated) time
  held_tier: AlertTier // the tier that reading alone would have raised
  news2_score: number
  reason: string // NEWS2 reasons joined with "; ", same format as AlertRow.reason
}

export interface EncounterRow {
  id: string
  patient_id: string
  status: 'in-progress' | 'finished'
  class: 'IMP'
  location_id: string
  bed_label: string
}

export interface PatientRow {
  id: string
  age_band: string
  gender: Patient['gender'] | null
  conditions: string[]
  medications: string[]
}

const orUndefined = <T>(v: T | null): T | undefined => (v === null ? undefined : v)

export function vitalsFromRow(r: VitalsRow): VitalsReading {
  return {
    patientId: r.patient_id,
    encounterId: r.encounter_id,
    recordedAt: r.recorded_at,
    heartRateBpm: orUndefined(r.heart_rate_bpm),
    systolicMmHg: orUndefined(r.systolic_mmhg),
    diastolicMmHg: orUndefined(r.diastolic_mmhg),
    spo2Percent: orUndefined(r.spo2_percent),
    temperatureC: r.temperature_c === null ? undefined : Number(r.temperature_c),
    respiratoryRate: orUndefined(r.respiratory_rate),
    onOxygen: orUndefined(r.on_oxygen),
    consciousness: orUndefined(r.consciousness),
  }
}

export function patientFromRow(r: PatientRow): Patient {
  return {
    id: r.id,
    ageBand: r.age_band,
    gender: orUndefined(r.gender),
    conditions: r.conditions,
    medications: r.medications,
  }
}

export function encounterFromRow(r: EncounterRow): Encounter {
  return { id: r.id, status: 'in-progress', class: r.class, location: { id: r.location_id, display: r.bed_label } }
}

/** Short non-identifying label, e.g. "4W-02 · 70-79 · 1e7c27a4". */
export function patientLabel(p: Pick<Patient, 'id' | 'ageBand'>, encounter?: Pick<Encounter, 'location'>): string {
  return [encounter?.location.display, p.ageBand, p.id.slice(0, 8)].filter(Boolean).join(' · ')
}
