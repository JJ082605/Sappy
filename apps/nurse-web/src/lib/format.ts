// Small display helpers. Nothing here identifies a patient: beds are labels, ids are pseudonymous.
import type { Patient } from '@repo/shared'

/** "4W-02" -> { ward: "4W", num: "02" }. A bed is a display label only, never a key. */
export function bedParts(label: string | undefined): { ward: string; num: string } {
  if (!label) return { ward: '', num: '?' }
  const i = label.lastIndexOf('-')
  return i > 0 ? { ward: label.slice(0, i), num: label.slice(i + 1) } : { ward: '', num: label }
}

/** Local 24 h clock, e.g. "14:05". */
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** Hour bucket label in the same 24 h style as `clock`, e.g. "14:00". */
export const hourLabel = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:00`

/** Elapsed time that can't be mistaken for a time of day: "45 s", "22 min", "1 h 05 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s} s` : minutes(ms)
}

/** Live waiting timer: "0:42", "12:05", "1:04:10". */
export function timer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Coarse duration: "<1 min", "4 min", "1 h 05 min". */
export function minutes(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const GENDER: Record<string, string> = { male: 'male', female: 'female', other: 'other', unknown: '' }

/** "80-89, female" */
export function patientMeta(p: Patient): string {
  return [p.ageBand, p.gender ? GENDER[p.gender] : ''].filter(Boolean).join(', ')
}

/** Short pseudonymous handle so two patients in the same age band can be told apart. */
export const shortId = (id: string) => id.slice(0, 8)

// Synthea's social findings, matched as WHOLE names only. The transform step already drops these
// (server/Synthea_Gen/transform.py); this is a backstop. Never use loose keywords here: "stress"
// as a substring would also hide "Post-traumatic stress disorder" or "Acute respiratory distress".
const NOT_CLINICAL =
  /^(full-time employment|part-time employment|not in labor force|unemployed|received higher education|received certificate of high school equivalency|educated to high school level|only received primary school education|has a criminal record|housing unsatisfactory|homeless|stress|social isolation|social migrant|limited social contact|reports of violence in the environment|victim of intimate partner abuse|refugee|medication review due|lack of access to transportation|transport problem|risk activity involvement|serving in military service|served in armed forces)$/i
// Kept on purpose (they change care): "Unhealthy alcohol drinking behavior", "Misuses drugs".

/** Clinically useful conditions, plain names. */
export function clinicalConditions(p: Patient): string[] {
  return (p.conditions ?? [])
    .map((c) => c.replace(/\s*\((disorder|finding|situation|person|morphologic abnormality)\)\s*$/i, '').trim())
    .filter((c) => c && !NOT_CLINICAL.test(c))
}

/**
 * "24 HR metoprolol succinate 100 MG Extended Release Oral Tablet" -> "Metoprolol succinate 100 mg".
 * Combination products keep every ingredient ("Acetaminophen 325 mg + oxycodone hydrochloride 5 mg"):
 * dropping one would hide an opioid from the nurse.
 */
export function shortMed(display: string): string {
  const cleaned = display
    .replace(/^NDA\d+\s+/i, '') // package codes, e.g. "NDA020800 0.3 ML Epinephrine ..."
    .replace(/^\d+(\.\d+)?\s*(HR|ML|ACTUAT)\s+/i, '')
    .replace(/\s+(Oral|Extended|Delayed|Injection|Prefilled|Dry Powder|Topical|Inhal|Transdermal|Nasal|Chewable|Disintegrating|Injectable|Auto-Injector|Metered).*$/i, '')
    .replace(/\bMG\b/g, 'mg')
    .replace(/\bML\b/g, 'mL')
    .split(' / ')
    .join(' + ')
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

export const ACVPU: Record<string, string> = {
  A: 'Alert',
  C: 'New confusion',
  V: 'Responds to voice',
  P: 'Responds to pain',
  U: 'Unresponsive',
}
