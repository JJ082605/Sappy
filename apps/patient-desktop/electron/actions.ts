// Actions the assistant takes on the patient's behalf (item requests, nurse calls, emergencies),
// and how they reach the nurses as rows in the Supabase `alerts` table.
//
// Privacy (CLAUDE.md): nothing the patient said goes into an alert. The model picks from fixed
// categories below, and the alert `reason` is built only from those. The patient's own words stay
// in `local` (terminal log on this device) and are never sent anywhere.
//
// Delivery: dispatchAction() POSTs each action as fixed values only (toRequestBody) to the vitals
// simulator server (server/sim/cli.py, on Render). The server looks up the patient's in-progress
// encounter and inserts the `alerts` row, rebuilding tier and reason from those values with a Python
// mirror of the categories, labels, alertTier() and alertReason() below
// (server/sim/patient_requests.py). This file is the source of truth: change both together;
// server/sim/test_patient_requests.py fails if they drift.
import { randomUUID } from 'node:crypto'
import type { AlertTier } from '@repo/shared'

// ---------- categories the model chooses from ----------

export const ITEM_CATEGORIES = ['drink', 'food', 'comfort', 'hygiene', 'other'] as const
export const NURSE_REASONS = ['bathroom', 'pain', 'mobility', 'equipment', 'medication', 'comfort', 'talk', 'other'] as const
export const EMERGENCY_KINDS = [
  'chest_pain', 'breathing', 'fall', 'stroke_signs', 'bleeding', 'seizure', 'fainting', 'severe_pain', 'self_harm', 'other',
] as const

export type ItemCategory = (typeof ITEM_CATEGORIES)[number]
export type NurseReason = (typeof NURSE_REASONS)[number]
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number]

// Labels staff see. Mirrored in server/sim/patient_requests.py, and the nurse dashboard parses the
// reasons built from them: change them together.
const ITEM_CATEGORY_LABEL: Record<ItemCategory, string> = {
  drink: 'a drink', food: 'food', comfort: 'a comfort item', hygiene: 'a hygiene item', other: 'an item',
}
const NURSE_REASON_LABEL: Record<NurseReason, string> = {
  bathroom: 'help to the bathroom',
  pain: 'pain or discomfort',
  mobility: 'help moving or getting up',
  equipment: 'equipment alarm or problem',
  medication: 'a medication question',
  comfort: 'comfort or repositioning',
  talk: 'wants to talk to the nurse',
  other: 'needs the nurse',
}
const EMERGENCY_LABEL: Record<EmergencyKind, string> = {
  chest_pain: 'chest pain',
  breathing: 'trouble breathing',
  fall: 'a fall',
  stroke_signs: 'possible stroke signs',
  bleeding: 'heavy bleeding',
  seizure: 'a seizure',
  fainting: 'fainting or about to faint',
  severe_pain: 'sudden severe pain',
  self_harm: 'thoughts of self-harm',
  other: 'other symptoms',
}

// Common items that may be named in an alert (lowercase words). Anything else is reported by its
// category only.
export const NAMED_ITEMS = [
  'ice chips', 'water', 'ice', 'juice', 'coffee', 'tea', 'milk', 'snack', 'meal', 'blanket', 'pillow',
  'tissues', 'towel', 'toothbrush', 'toothpaste', 'lip balm', 'socks', 'reading glasses', 'phone charger', 'tv remote',
] as const
export type NamedItem = (typeof NAMED_ITEMS)[number]

// Whole words only, longest item first: "ice chips" beats "ice", "orange juice" is "juice", and
// "a slice of toast" or "steak" name nothing (not "ice" or "tea"). A plural ("pillows") still counts.
const NAMED_ITEM_PATTERNS = [...NAMED_ITEMS]
  .sort((a, b) => b.length - a.length)
  .map((item) => ({ item, pattern: new RegExp(`\\b${item.replaceAll(' ', '[\\s-]+')}(?:e?s)?\\b`, 'i') }))

/** The common item named in the model's free-text `item`, or undefined if it names none. */
export function matchNamedItem(text: string): NamedItem | undefined {
  return NAMED_ITEM_PATTERNS.find(({ pattern }) => pattern.test(text))?.item
}

// ---------- the action record ----------

type Base = {
  id: string
  /** Pseudonymous Patient.id this device is assigned to (null if PATIENT_ID isn't set). */
  patientId: string | null
  /** Short label for the patient's screen and staff, e.g. "water" or "help to the bathroom". Never free text. */
  label: string
  /** 'assistant' = the AI chose this action; 'safety_check' = keyword safety net (no AI involved). */
  source: 'assistant' | 'safety_check'
  createdAt: string // ISO 8601
  /** Stays on this device (terminal log only). NEVER sent to Supabase. */
  local: { patientMessage: string; detail?: string }
}

// An item request's `item` is the common item it named (one of NAMED_ITEMS, never free text), if any.
export type PatientAction =
  | (Base & { type: 'item_request'; priority: 'routine'; category: ItemCategory; item?: NamedItem })
  | (Base & { type: 'nurse_call'; priority: 'routine' | 'soon' | 'urgent'; category: NurseReason })
  | (Base & { type: 'emergency'; priority: 'emergency'; category: EmergencyKind })

type NewAction =
  | { type: 'item_request'; category: ItemCategory; item?: string }
  | { type: 'nurse_call'; category: NurseReason; priority: 'routine' | 'soon' | 'urgent' }
  | { type: 'emergency'; category: EmergencyKind }

/** Build an action. `item` (free text from the model) is only kept as the common item it names, if any. */
export function createAction(
  spec: NewAction,
  ctx: { patientId: string | null; source: Base['source']; patientMessage: string; detail?: string },
): PatientAction {
  const base = {
    id: randomUUID(),
    patientId: ctx.patientId,
    source: ctx.source,
    createdAt: new Date().toISOString(),
    local: { patientMessage: ctx.patientMessage, ...(ctx.detail && { detail: ctx.detail }) },
  }
  switch (spec.type) {
    case 'item_request': {
      const named = spec.item ? matchNamedItem(spec.item) : undefined
      return {
        ...base,
        type: 'item_request',
        priority: 'routine',
        category: spec.category,
        ...(named ? { item: named } : {}),
        label: named ?? ITEM_CATEGORY_LABEL[spec.category],
      }
    }
    case 'nurse_call':
      return { ...base, type: 'nurse_call', priority: spec.priority, category: spec.category, label: NURSE_REASON_LABEL[spec.category] }
    case 'emergency':
      return { ...base, type: 'emergency', priority: 'emergency', category: spec.category, label: EMERGENCY_LABEL[spec.category] }
  }
}

// ---------- mapping onto the `alerts` table ----------

/**
 * Tier, using the same scale as NEWS2 alerts so the nurse dashboard can sort them together:
 *   emergency            → go now
 *   nurse call urgent    → check soon
 *   nurse call soon      → check soon
 *   nurse call routine   → watch
 *   item request         → watch
 */
export function alertTier(action: PatientAction): AlertTier {
  if (action.type === 'emergency') return 'go now'
  if (action.type === 'nurse_call' && action.priority !== 'routine') return 'check soon'
  return 'watch'
}

/** Plain-language reason built only from fixed categories (no patient free text). */
export function alertReason(action: PatientAction): string {
  switch (action.type) {
    case 'item_request':
      return `Patient request: ${action.label}`
    case 'nurse_call':
      return `Patient asked for the nurse: ${action.label}`
    case 'emergency':
      return `Patient reported a possible emergency: ${action.label}` + (action.source === 'safety_check' ? ' (keyword safety check)' : '')
  }
}

// ---------- what is sent ----------

/**
 * Body of POST /patient-requests on the simulator (server/sim/patient_requests.py). Fixed values
 * only, never `label`, `local` or anything else the model or patient wrote. The server rejects any
 * other field and rebuilds the alert's tier and reason from these.
 */
export type PatientRequestBody = { patientId: string; source: PatientAction['source'] } & (
  | { type: 'item_request'; category: ItemCategory; item?: NamedItem }
  | { type: 'nurse_call'; category: NurseReason; priority: Extract<PatientAction, { type: 'nurse_call' }>['priority'] }
  | { type: 'emergency'; category: EmergencyKind }
)

/** The request body for this action, or null if this device has no PATIENT_ID. */
export function toRequestBody(action: PatientAction): PatientRequestBody | null {
  if (!action.patientId) return null
  const common = { patientId: action.patientId, source: action.source }
  switch (action.type) {
    case 'item_request':
      return { ...common, type: action.type, category: action.category, ...(action.item ? { item: action.item } : {}) }
    case 'nurse_call':
      return { ...common, type: action.type, category: action.category, priority: action.priority }
    case 'emergency':
      return { ...common, type: action.type, category: action.category }
  }
}

// ---------- delivery ----------

/** What happened to an action. Only 'sent' means the nurses' station has it. */
export type Delivery =
  | 'sent' // the simulator wrote the alert, or already had it from the last minute
  | 'failed' // it didn't get through (network, server or configuration error)
  | 'offline' // demo/offline device (no PATIENT_ID, SIM_URL or token): logged here only

const ICON = { item_request: '🥤', nurse_call: '🔔', emergency: '🚨' } as const
const DELIVERY_TIMEOUT_MS = 5_000 // per attempt, so a failed emergency reaches its fallback in ~12 s at worst
const EMERGENCY_RETRY_DELAY_MS = 2_000

/** Where requests go, from this device's .env (loaded at startup by patient.ts). */
function deliveryTarget(): { url: string; token: string } | { missing: string[] } {
  const simUrl = process.env.SIM_URL?.trim()
  const token = process.env.PATIENT_REQUEST_TOKEN?.trim()
  if (!simUrl || !token) {
    return { missing: [...(simUrl ? [] : ['SIM_URL']), ...(token ? [] : ['PATIENT_REQUEST_TOKEN'])] }
  }
  return { url: `${simUrl.replace(/\/+$/, '')}/patient-requests`, token }
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message
}

/**
 * One POST to the simulator, logged; never throws. 'sent' if it accepted the request, 'transient'
 * for a failure that may pass (network error, timeout, HTTP 5xx), 'rejected' for one that won't
 * (HTTP 4xx: bad token, patient not on the ward, invalid request).
 */
async function post(
  action: PatientAction,
  target: { url: string; token: string },
  body: PatientRequestBody,
): Promise<'sent' | 'transient' | 'rejected'> {
  const log = action.type === 'emergency' ? console.error : console.log
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    const reply = (await res.json().catch(() => ({}))) as { duplicate?: boolean; reason?: string; error?: string }
    if (!res.ok) {
      console.error(`[patient-action] NOT DELIVERED (HTTP ${res.status}): ${reply.error ?? res.statusText} [${action.id}]`)
      return res.status >= 400 && res.status < 500 ? 'rejected' : 'transient'
    }
    log(`[patient-action] ${reply.duplicate ? 'already sent in the last minute, not repeated' : 'delivered to staff'} [${action.id}]`)
    if (reply.reason && reply.reason !== alertReason(action)) {
      console.warn(`[patient-action] the simulator wrote "${reply.reason}": its labels differ from actions.ts (redeploy it?)`)
    }
    return 'sent'
  } catch (err) {
    console.error(`[patient-action] NOT DELIVERED: couldn't reach ${target.url}: ${errorText(err)} [${action.id}]`)
    return 'transient'
  }
}

const offline = (why: string) =>
  `NOT SENT, demo/offline device (${why}; see apps/patient-desktop/.env.example): logged here only, the nurses were NOT told`

/**
 * Deliver an action to staff: POST it to the simulator, which writes the `alerts` row. Logs on this
 * device first and never throws; only 'sent' means the nurses have it. An emergency whose POST fails
 * in a way that may pass (network error, timeout, HTTP 5xx) is retried once after `retryDelayMs`; a
 * 4xx won't pass, so it fails at once and the patient is sent to the call button without a delay.
 * If the first POST did get through (only its answer was lost), the simulator answers the retry as a
 * repeat (same patient, type and category within a minute), which still counts as sent, so the
 * nurses aren't paged twice.
 */
export async function dispatchAction(action: PatientAction, retryDelayMs = EMERGENCY_RETRY_DELAY_MS): Promise<Delivery> {
  const log = action.type === 'emergency' ? console.error : console.log
  const body = toRequestBody(action)
  const target = deliveryTarget()
  const plan = !body
    ? offline('no PATIENT_ID assigned')
    : 'missing' in target
      ? offline(`${target.missing.join(' and ')} not set`)
      : `sending to ${target.url}:\n${JSON.stringify(body, null, 2)}`
  log(
    `\n[patient-action] ${ICON[action.type]} [${alertTier(action).toUpperCase()}] ${alertReason(action)}\n${plan}\n` +
      `local only, never sent: ${JSON.stringify({ id: action.id, source: action.source, ...action.local })}\n`,
  )
  if (!body || 'missing' in target) return 'offline'

  const first = await post(action, target, body)
  if (first === 'sent') return 'sent'
  if (first === 'rejected' || action.type !== 'emergency') return 'failed'
  console.error(`[patient-action] retrying the emergency alert in ${retryDelayMs / 1000} s [${action.id}]`)
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  return (await post(action, target, body)) === 'sent' ? 'sent' : 'failed'
}
