// How an `alerts` row is shown. Two writers share the table (see packages/shared NewAlertRow):
//   - the NEWS2 worker: news2_score set, reason = "Pulse 118 bpm (+2); SpO2 93% (+1)"
//   - Sappy, the patient assistant: news2_score null, reason built from fixed categories
import type { AlertRow, AlertTier, News2LatestRow } from '@repo/shared'
// Explicit .ts extension: these pure modules also run under Node's test runner (test/*.test.ts).
import { ACVPU } from './format.ts'

export const TIER_RANK: Record<AlertTier, number> = { watch: 1, 'check soon': 2, 'go now': 3 }
export const TIER_LABEL: Record<AlertTier, string> = { watch: 'Watch', 'check soon': 'Check soon', 'go now': 'Go now' }

/** CSS modifier for a tier, or "clear" when there's nothing open. */
export type TierTone = 'go' | 'soon' | 'watch' | 'clear'
export const tone = (t: AlertTier | undefined): TierTone =>
  t === 'go now' ? 'go' : t === 'check soon' ? 'soon' : t === 'watch' ? 'watch' : 'clear'

/** Waiting for a nurse (status 'incomplete'). */
export const isOpen = (a: Pick<AlertRow, 'status'>) => a.status !== 'completed'

/** When a nurse took a completed alert (database time; falls back to created_at if never stamped). */
export const takenAt = (a: Pick<AlertRow, 'completed_at' | 'created_at'>) => a.completed_at ?? a.created_at

export interface Contributor {
  label: string
  points: number
}

export interface AlertView {
  source: 'vitals' | 'sappy'
  title: string
  detail: string
  /** NEWS2 inputs that scored, highest first. Empty for Sappy requests. */
  contributors: Contributor[]
  /** NEWS2 recommended clinical response. Vitals alerts only. */
  response?: string
  /** Raised by Sappy's keyword safety net rather than the AI. */
  safetyCheck: boolean
}

/**
 * NEWS2 clinical risk -> recommended response (RCP 2017, abbreviated). Mirrors RESPONSES in
 * server/news2/scoring.py, which is the source of truth: keep the wording identical.
 */
const RESPONSES = {
  low: 'Routine monitoring; ward nurse to assess.',
  'low-medium': 'Urgent ward-based review by a clinician (single parameter scored 3).',
  medium: 'Urgent review by a clinician skilled in acute illness; at least hourly observations.',
  high: 'Emergency assessment by a critical care team; continuous monitoring.',
}

/**
 * The response follows the alert's TIER (what the card says), not the raw score: a card must never
 * read "Check soon" and "Emergency assessment" at once. Within "check soon", a total under 5 means
 * the tier came from a single parameter scoring 3 (RCP low-medium).
 */
function news2Response(tier: AlertTier, score: number, contributors: Contributor[]): string {
  if (tier === 'go now') return RESPONSES.high
  if (tier === 'check soon')
    return score < 5 && contributors.some((c) => c.points === 3) ? RESPONSES['low-medium'] : RESPONSES.medium
  return RESPONSES.low
}

/**
 * Emergencies that shouldn't be spelled out in large type on a screen others may see.
 * The nurse still gets the urgency; the specifics are for the bedside.
 */
const DISCREET = new Map([['thoughts of self-harm', 'Urgent: mental health']])

// The only labels Sappy can put after its reason prefixes. Mirrors the label maps in
// apps/patient-desktop/electron/actions.ts (source of truth; test/alerts.test.ts fails on drift).
// Anything else after a known prefix is treated as unknown and never shown verbatim.
const ITEM_LABELS = new Set([
  'a drink', 'food', 'a comfort item', 'a hygiene item', 'an item',
  'ice chips', 'water', 'ice', 'juice', 'coffee', 'tea', 'milk', 'snack', 'meal', 'blanket', 'pillow',
  'tissues', 'towel', 'toothbrush', 'toothpaste', 'lip balm', 'socks', 'reading glasses', 'phone charger', 'tv remote',
])
const NURSE_LABELS = new Set([
  'help to the bathroom', 'pain or discomfort', 'help moving or getting up', 'equipment alarm or problem',
  'a medication question', 'comfort or repositioning', 'wants to talk to the nurse', 'needs the nurse',
])
const EMERGENCY_LABELS = new Set([
  'chest pain', 'trouble breathing', 'a fall', 'possible stroke signs', 'heavy bleeding', 'a seizure',
  'fainting or about to faint', 'sudden severe pain', 'thoughts of self-harm', 'other symptoms',
])

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function describeAlert(a: AlertRow): AlertView {
  if (a.news2_score !== null) {
    const contributors = a.reason
      .split('; ')
      .map((part) => {
        const m = /^(.*) \(\+(\d)\)$/.exec(part)
        if (!m) return null
        // "Consciousness V (not alert)" -> "Responds to voice (V)": spell the level out.
        const level = /^Consciousness ([CVPU]) \(not alert\)$/.exec(m[1])?.[1]
        return { label: level ? `${ACVPU[level]} (${level})` : m[1], points: Number(m[2]) }
      })
      .filter((c): c is Contributor => c !== null)
    return {
      source: 'vitals',
      title: `NEWS2 score ${a.news2_score}`,
      detail: contributors.length ? contributors.map((c) => c.label).join(', ') : 'Vitals deteriorating',
      contributors,
      response: news2Response(a.tier, a.news2_score, contributors),
      safetyCheck: false,
    }
  }

  // Sappy builds reasons only from fixed categories (apps/patient-desktop/electron/actions.ts).
  // Anything that doesn't match those is shown generically, never verbatim.
  const safetyCheck = a.reason.includes('(keyword safety check)')
  const reason = a.reason.replace(' (keyword safety check)', '')
  const after = (prefix: string) => (reason.startsWith(prefix) ? reason.slice(prefix.length) : null)
  const view = (title: string, detail: string): AlertView => ({ source: 'sappy', title, detail, contributors: [], safetyCheck })

  const item = after('Patient request: ')
  if (item !== null) return view(ITEM_LABELS.has(item) ? `Asked for ${item}` : 'Asked for an item', 'Request made to Sappy')
  const nurse = after('Patient asked for the nurse: ')
  if (nurse !== null) return view(NURSE_LABELS.has(nurse) ? cap(nurse) : 'Needs the nurse', 'Asked Sappy for the nurse')
  const emergency = after('Patient reported a possible emergency: ')
  if (emergency !== null) {
    const discreet = DISCREET.get(emergency)
    if (discreet) return view(discreet, 'Possible emergency reported to Sappy. Details at the bedside.')
    const how = safetyCheck ? 'Possible emergency, caught by Sappy’s keyword check' : 'Possible emergency reported to Sappy'
    return view(EMERGENCY_LABELS.has(emergency) ? cap(emergency) : 'Possible emergency', how)
  }
  return view('Patient request', 'Reported through Sappy')
}

/** The vitals alert before this one for the same patient, if any: shows which way the score is heading. */
export function previousScore(alerts: AlertRow[], a: AlertRow): AlertRow | undefined {
  return alerts.find((x) => x.patient_id === a.patient_id && x.news2_score !== null && x.created_at < a.created_at)
}

/**
 * What a bed shows everywhere (board, lists, patient header, privacy screen), most urgent first:
 *   open  - an urgent alert (check soon / go now) is waiting for a nurse
 *   taken - its latest urgent alert was taken ("I'm on it") and nothing newer has arrived. It stays
 *           visible with its tier: taking an alert doesn't mean the patient recovered, and the NEWS2
 *           worker doesn't re-alert while a patient stays at the same tier.
 *   watch - only watch-tier alerts are open
 *   quiet - nothing open, nothing taken
 */
export type BedState =
  | { kind: 'open'; tier: AlertTier; group: OpenGroup }
  | { kind: 'taken'; tier: AlertTier; alert: AlertRow }
  | { kind: 'watch'; tier: 'watch'; group: OpenGroup }
  | { kind: 'quiet' }

/** `alerts` newest first (as Ward keeps them). */
export function bedState(alerts: AlertRow[], groups: OpenGroup[], patientId: string): BedState {
  const g = groups.find((x) => x.patientId === patientId)
  if (g && g.top.tier !== 'watch') return { kind: 'open', tier: g.top.tier, group: g }
  // Taken: the HIGHEST tier a nurse took in this window (newest within it), so a later routine
  // request can't make a bed that was "go now" look like "check soon".
  const taken = alerts.filter((a) => a.patient_id === patientId && a.tier !== 'watch' && !isOpen(a))
  if (taken.length) {
    const top = taken.reduce((best, a) =>
      TIER_RANK[a.tier] > TIER_RANK[best.tier] || (a.tier === best.tier && a.created_at > best.created_at) ? a : best,
    )
    return { kind: 'taken', tier: top.tier, alert: top }
  }
  if (g) return { kind: 'watch', tier: 'watch', group: g }
  return { kind: 'quiet' }
}

/** Tier shown for a bed state (taken beds keep their tier, drawn outlined). */
export const stateTier = (s: BedState): AlertTier | undefined => (s.kind === 'quiet' ? undefined : s.tier)

/**
 * Tier a bed is DRAWN with: its alert state, raised to the live confirmed NEWS2 tier when that's
 * more urgent. So a taken "go now" patient who then asks Sappy for pain relief still looks "go now",
 * and a patient whose alert row failed to arrive still shows. Live "watch" is ignored (it's quiet).
 */
export function displayTier(state: BedState, score?: Pick<News2LatestRow, 'confirmed_tier'>): AlertTier | undefined {
  const fromState = stateTier(state)
  const live = score && (score.confirmed_tier === 'check soon' || score.confirmed_tier === 'go now') ? score.confirmed_tier : undefined
  if (!live) return fromState
  if (!fromState) return live
  return TIER_RANK[live] > TIER_RANK[fromState] ? live : fromState
}

/** Open alerts for one patient, shown as one item: a nurse who goes to the bed sees all of them. */
export interface OpenGroup {
  patientId: string
  top: AlertRow // highest tier; within it emergencies, then single 3s, then vitals, then requests; then newest
  alerts: AlertRow[]
  since: string // oldest open urgent alert (or oldest watch if only watch): how long this bed has waited
}

/** Open alerts grouped by patient: most urgent first, then longest waiting. */
/**
 * Within one tier, what goes first: a reported emergency (specific, can't be inferred from vitals),
 * then a vitals alert with a single parameter scoring 3 (RCP: urgent review), then other vitals
 * alerts, then routine requests.
 */
export function alertPriority(a: AlertRow): number {
  if (a.news2_score === null) return a.reason.startsWith('Patient reported a possible emergency: ') ? 3 : 0
  return /\(\+3\)(;|$)/.test(a.reason) ? 2 : 1
}

/** Positive when `a` should come before `b` (tier, then priority, then newer). */
export const outranks = (a: AlertRow, b: AlertRow) =>
  TIER_RANK[a.tier] - TIER_RANK[b.tier] || alertPriority(a) - alertPriority(b) || a.created_at.localeCompare(b.created_at)

export function openGroups(alerts: AlertRow[]): OpenGroup[] {
  const by = new Map<string, AlertRow[]>()
  for (const a of alerts) if (isOpen(a)) by.set(a.patient_id, [...(by.get(a.patient_id) ?? []), a])
  const groups = [...by.entries()].map(([patientId, list]) => {
    const top = list.reduce((best, a) => (outranks(a, best) > 0 ? a : best))
    // Waiting time counts from the oldest URGENT open alert: a quiet watch alert from earlier
    // mustn't make a fresh "go now" look like it has waited for an hour.
    const urgent = list.filter((a) => a.tier !== 'watch')
    const pool = urgent.length ? urgent : list
    const since = pool.reduce((min, a) => (a.created_at < min ? a.created_at : min), pool[0].created_at)
    return { patientId, top, alerts: list, since }
  })
  return groups.sort(
    (a, b) =>
      TIER_RANK[b.top.tier] - TIER_RANK[a.top.tier] ||
      alertPriority(b.top) - alertPriority(a.top) ||
      a.since.localeCompare(b.since),
  )
}

/**
 * Merge a fresh fetch into what's on screen. Fetched rows win. A row on screen but missing from
 * the fetch was deleted (e.g. --reset) if it is older than the newest fetched row; anything newer
 * arrived via Realtime after the query ran, so it stays.
 */
export function mergeAlerts(current: AlertRow[], fetched: AlertRow[]): AlertRow[] {
  const ids = new Set(fetched.map((a) => a.id))
  const newest = fetched.reduce((max, a) => (a.created_at > max ? a.created_at : max), '')
  const kept = current.filter((a) => !ids.has(a.id) && a.created_at > newest)
  return [...fetched, ...kept].sort((x, y) => y.created_at.localeCompare(x.created_at))
}
