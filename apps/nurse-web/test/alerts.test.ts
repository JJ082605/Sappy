// Unit tests for src/lib/alerts.ts: how `alerts` rows are described, ranked, grouped, merged and
// turned into bed states. Run from apps/nurse-web: pnpm test (node --test, no extra dependencies).
//
// Two writers share the `alerts` table, and both are checked against their source of truth here:
//   - NEWS2 worker: response wording is parsed from server/news2/scoring.py, so drift fails a test.
//   - Sappy (patient assistant): the reasons apps/patient-desktop/electron/actions.ts can build must be
//     exactly the ones in the tables below, each shown with its own label (so it is in the allow-lists in
//     src/lib/alerts.ts). A new, renamed or removed label fails a test until both sides are updated.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AlertRow, AlertTier } from '@repo/shared'
import type { AlertView } from '../src/lib/alerts.ts'
import {
  alertPriority,
  bedState,
  describeAlert,
  displayTier,
  isOpen,
  mergeAlerts,
  openGroups,
  outranks,
  previousScore,
  stateTier,
  takenAt,
  TIER_RANK,
  tone,
} from '../src/lib/alerts.ts'

// ---------- fixtures ----------

/** A timestamp as Supabase returns `timestamptz`, on a fixed day: "10:05" or "10:05:30". */
const ts = (time: string) => `2026-11-08T${time.length === 5 ? `${time}:00` : time}.000000+00:00`

let nextId = 1
function row(fields: Partial<AlertRow> = {}): AlertRow {
  return {
    id: nextId++,
    patient_id: 'p1',
    encounter_id: 'e1',
    created_at: ts('10:00'),
    tier: 'watch',
    news2_score: null,
    reason: '',
    status: 'incomplete',
    completed_at: null,
    ...fields,
  }
}
/** Taken by a nurse ("I'm on it"); the database stamps completed_at. */
const done = (time: string): Partial<AlertRow> => ({ status: 'completed', completed_at: ts(time) })

/**
 * The tier the NEWS2 worker gives a steady reading with this total (RCP 2017, see CLAUDE.md):
 * 7+ go now; 5-6, or any single parameter scoring 3, check soon; otherwise watch.
 */
const tierFor = (score: number, reason: string): AlertTier =>
  score >= 7 ? 'go now' : score >= 5 || /\(\+3\)/.test(reason) ? 'check soon' : 'watch'
/** An alert written by the NEWS2 worker: the realistic tier for its score unless `fields` overrides it. */
const news2 = (score: number, reason: string, fields: Partial<AlertRow> = {}) =>
  row({ news2_score: score, reason, tier: tierFor(score, reason), ...fields })
/** An alert written for Sappy (no NEWS2 score), at the tier alertTier() gives its kind (an urgent nurse call). */
const sappy = (reason: string, fields: Partial<AlertRow> = {}) =>
  row({
    news2_score: null,
    reason,
    tier: reason.startsWith('Patient reported a possible emergency: ')
      ? 'go now'
      : reason.startsWith('Patient asked for the nurse: ')
        ? 'check soon'
        : 'watch',
    ...fields,
  })

// NEWS2 reasons as scoring.py writes them (highest first); the totals match the points.
const SEVEN = 'Consciousness C (not alert) (+3); Respiratory rate 23/min (+2); Pulse 118 bpm (+2)'
const SEVEN_NO_3 = 'Respiratory rate 23/min (+2); SpO2 93% (+2); Pulse 118 bpm (+2); Temperature 38.6 °C (+1)'
const NINE = 'Respiratory rate 26/min (+3); Pulse 124 bpm (+2); SpO2 93% (+2); Temperature 39.2 °C (+2)'
const SEPTIC =
  'Respiratory rate 26/min (+3); Systolic BP 88 mmHg (+3); Consciousness C (not alert) (+3); ' +
  'Pulse 124 bpm (+2); Temperature 39.2 °C (+2); SpO2 95% (+1)'

/** What the nurse sees (extra fields added later don't break these tests). */
const shown = (v: AlertView) => ({
  source: v.source,
  title: v.title,
  detail: v.detail,
  contributors: v.contributors,
  response: v.response,
  safetyCheck: v.safetyCheck,
})
type Shown = ReturnType<typeof shown>

/** RESPONSES as written in server/news2/scoring.py, the source of truth for the wording. */
function pythonResponses(): Record<string, string> {
  const src = readFileSync(new URL('../../../server/news2/scoring.py', import.meta.url), 'utf8')
  const block = /^RESPONSES = \{$([\s\S]*?)^\}$/m.exec(src)
  assert.ok(block, 'RESPONSES = {...} not found in server/news2/scoring.py')
  const entries = [...block[1].matchAll(/^\s*(["'])(.+?)\1:\s*(["'])(.*)\3,?[ \t]*$/gm)]
  return Object.fromEntries(entries.map((m) => [m[2], m[4]]))
}

// ---------- NEWS2 worker alerts ----------

describe('describeAlert: NEWS2 worker alerts', () => {
  test('parses each contributor and its points, keeping the worker order (highest first)', () => {
    const v = describeAlert(news2(5, 'Respiratory rate 26/min (+3); Pulse 124 bpm (+2)'))
    assert.deepEqual(shown(v), {
      source: 'vitals',
      title: 'NEWS2 score 5',
      detail: 'Respiratory rate 26/min, Pulse 124 bpm',
      contributors: [
        { label: 'Respiratory rate 26/min', points: 3 },
        { label: 'Pulse 124 bpm', points: 2 },
      ],
      response: pythonResponses().medium,
      safetyCheck: false,
    })
  })

  test('parses every label shape scoring.py writes, incl. labels with their own parentheses', () => {
    // As _reasons() builds it for a confused COPD patient on oxygen (Scale 2): all 7 inputs score.
    const reason =
      'Respiratory rate 26/min (+3); Consciousness C (not alert) (+3); SpO2 85% (Scale 2) (+2); ' +
      'On supplemental oxygen (+2); Systolic BP 98 mmHg (+2); Pulse 118 bpm (+2); Temperature 38.6 °C (+1)'
    assert.deepEqual(describeAlert(news2(15, reason)).contributors, [
      { label: 'Respiratory rate 26/min', points: 3 },
      { label: 'New confusion (C)', points: 3 },
      { label: 'SpO2 85% (Scale 2)', points: 2 },
      { label: 'On supplemental oxygen', points: 2 },
      { label: 'Systolic BP 98 mmHg', points: 2 },
      { label: 'Pulse 118 bpm', points: 2 },
      { label: 'Temperature 38.6 °C', points: 1 },
    ])
  })

  test('spells out the consciousness level (ACVPU)', () => {
    const CASES: Array<[level: string, label: string]> = [
      ['C', 'New confusion (C)'],
      ['V', 'Responds to voice (V)'],
      ['P', 'Responds to pain (P)'],
      ['U', 'Unresponsive (U)'],
    ]
    for (const [level, label] of CASES) {
      const v = describeAlert(news2(5, `Consciousness ${level} (not alert) (+3); Pulse 118 bpm (+2)`))
      assert.deepEqual(v.contributors[0], { label, points: 3 }, level)
      assert.equal(v.detail, `${label}, Pulse 118 bpm`, level)
    }
  })

  test('skips parts that are not "<label> (+<points>)"', () => {
    const v = describeAlert(news2(3, 'Pulse 118 bpm (+2); not a contributor; SpO2 95% (+1)'))
    assert.deepEqual(
      v.contributors.map((c) => c.label),
      ['Pulse 118 bpm', 'SpO2 95%'],
    )
    assert.equal(v.detail, 'Pulse 118 bpm, SpO2 95%')
  })

  test('says "Vitals deteriorating" when nothing parses (the worker’s fallback reason)', () => {
    const v = describeAlert(news2(2, 'NEWS2 tier confirmed'))
    assert.equal(v.source, 'vitals')
    assert.equal(v.detail, 'Vitals deteriorating')
    assert.deepEqual(v.contributors, [])
  })

  test('a NEWS2 score of 0 is still a vitals alert (0 is not "no score")', () => {
    const v = describeAlert(news2(0, ''))
    assert.equal(v.source, 'vitals')
    assert.equal(v.title, 'NEWS2 score 0')
    assert.equal(v.response, pythonResponses().low)
  })
})

describe('NEWS2 recommended response', () => {
  test('server/news2/scoring.py still defines exactly the four risk bands', () => {
    assert.deepEqual(Object.keys(pythonResponses()).sort(), ['high', 'low', 'low-medium', 'medium'])
  })

  // The response follows the card's tier. Without `tier`, the alert has the tier the worker gives that
  // score. With it, the tier trails the score: the worker confirms a tier only after two readings in a
  // row, so a reading at 9 after one at 5 is written as "check soon" with score 9.
  const CASES: Array<{ name: string; score: number; reason: string; tier?: AlertTier; risk: string }> = [
    { name: 'total 7', score: 7, reason: SEVEN, risk: 'high' },
    { name: 'total 14 (septic)', score: 14, reason: SEPTIC, risk: 'high' },
    { name: 'total 6', score: 6, reason: 'Respiratory rate 23/min (+2); SpO2 93% (+2); Pulse 118 bpm (+2)', risk: 'medium' },
    { name: 'total 5', score: 5, reason: 'Respiratory rate 23/min (+2); Pulse 118 bpm (+2); Temperature 38.6 °C (+1)', risk: 'medium' },
    { name: 'total 5 incl. a 3 (not under 5)', score: 5, reason: 'Systolic BP 88 mmHg (+3); Pulse 118 bpm (+2)', risk: 'medium' },
    { name: 'total 4 with a single 3', score: 4, reason: 'Respiratory rate 7/min (+3); Temperature 38.6 °C (+1)', risk: 'low-medium' },
    { name: 'total 3, all from one 3', score: 3, reason: 'Consciousness U (not alert) (+3)', risk: 'low-medium' },
    { name: 'a single 3 on SpO2 Scale 2', score: 3, reason: 'SpO2 83% (Scale 2) (+3)', risk: 'low-medium' },
    { name: 'total 4, no single 3', score: 4, reason: 'Pulse 118 bpm (+2); SpO2 95% (+1); Temperature 38.6 °C (+1)', risk: 'low' },
    { name: 'total 1', score: 1, reason: 'SpO2 95% (+1)', risk: 'low' },
    { name: 'total 9, tier not yet confirmed', score: 9, reason: NINE, tier: 'check soon', risk: 'medium' },
    { name: 'total 4 with a single 3, tier not yet confirmed', score: 4, reason: 'Respiratory rate 7/min (+3); Temperature 38.6 °C (+1)', tier: 'watch', risk: 'low' },
    { name: 'total 7, tier not yet confirmed', score: 7, reason: SEVEN, tier: 'watch', risk: 'low' },
  ]
  for (const c of CASES) {
    const tier = c.tier ?? tierFor(c.score, c.reason)
    test(`${tier} card, ${c.name} -> ${c.risk}, worded as in scoring.py`, () => {
      const expected = pythonResponses()[c.risk]
      assert.ok(expected, `scoring.py has no RESPONSES["${c.risk}"]`)
      assert.equal(describeAlert(news2(c.score, c.reason, { tier })).response, expected)
    })
  }

  test('a "check soon" card never shows the emergency (high) response, whatever its score', () => {
    const CARDS: Array<[score: number, reason: string]> = [
      [7, SEVEN],
      [9, NINE],
      [14, SEPTIC],
    ]
    for (const [score, reason] of CARDS) {
      const response = describeAlert(news2(score, reason, { tier: 'check soon' })).response
      assert.notEqual(response, pythonResponses().high, `score ${score}`)
      assert.doesNotMatch(response ?? '', /Emergency assessment/, `score ${score}`)
      assert.equal(response, pythonResponses().medium, `score ${score}`)
    }
  })

  test('a "go now" card always shows the emergency (high) response', () => {
    for (const [score, reason] of [[7, SEVEN_NO_3], [9, NINE], [14, SEPTIC]] as const) {
      assert.equal(describeAlert(news2(score, reason, { tier: 'go now' })).response, pythonResponses().high, `score ${score}`)
    }
  })
})

// ---------- Sappy (patient assistant) alerts ----------

// Labels apps/patient-desktop/electron/actions.ts puts after each prefix, and the title the nurse sees.
const ITEM_LABELS = [
  // ITEM_CATEGORY_LABEL
  'a drink', 'food', 'a comfort item', 'a hygiene item', 'an item',
  // NAMED_ITEMS
  'ice chips', 'water', 'ice', 'juice', 'coffee', 'tea', 'milk', 'snack', 'meal', 'blanket', 'pillow',
  'tissues', 'towel', 'toothbrush', 'toothpaste', 'lip balm', 'socks', 'reading glasses', 'phone charger', 'tv remote',
]
const NURSE_CALLS: Array<[label: string, title: string]> = [
  ['help to the bathroom', 'Help to the bathroom'],
  ['pain or discomfort', 'Pain or discomfort'],
  ['help moving or getting up', 'Help moving or getting up'],
  ['equipment alarm or problem', 'Equipment alarm or problem'],
  ['a medication question', 'A medication question'],
  ['comfort or repositioning', 'Comfort or repositioning'],
  ['wants to talk to the nurse', 'Wants to talk to the nurse'],
  ['needs the nurse', 'Needs the nurse'],
]
const EMERGENCIES: Array<[label: string, title: string]> = [
  ['chest pain', 'Chest pain'],
  ['trouble breathing', 'Trouble breathing'],
  ['a fall', 'A fall'],
  ['possible stroke signs', 'Possible stroke signs'],
  ['heavy bleeding', 'Heavy bleeding'],
  ['a seizure', 'A seizure'],
  ['fainting or about to faint', 'Fainting or about to faint'],
  ['sudden severe pain', 'Sudden severe pain'],
  ['other symptoms', 'Other symptoms'],
]
const SAFETY_CHECK = ' (keyword safety check)'
const SELF_HARM = 'Patient reported a possible emergency: thoughts of self-harm'
const REPORTED = 'Possible emergency reported to Sappy'
const CAUGHT = 'Possible emergency, caught by Sappy’s keyword check'
const DISCREET_DETAIL = 'Possible emergency reported to Sappy. Details at the bedside.'

const sappyView = (title: string, detail: string, safetyCheck = false): Shown => ({
  source: 'sappy',
  title,
  detail,
  contributors: [],
  response: undefined,
  safetyCheck,
})

/** Every reason Sappy can write -> what the dashboard must show for it. */
const SAPPY_EXPECTED = new Map<string, Shown>([
  ...ITEM_LABELS.map((label): [string, Shown] => [
    `Patient request: ${label}`,
    sappyView(`Asked for ${label}`, 'Request made to Sappy'),
  ]),
  ...NURSE_CALLS.map(([label, title]): [string, Shown] => [
    `Patient asked for the nurse: ${label}`,
    sappyView(title, 'Asked Sappy for the nurse'),
  ]),
  ...EMERGENCIES.flatMap(([label, title]): Array<[string, Shown]> => [
    [`Patient reported a possible emergency: ${label}`, sappyView(title, REPORTED)],
    [`Patient reported a possible emergency: ${label}${SAFETY_CHECK}`, sappyView(title, CAUGHT, true)],
  ]),
  [SELF_HARM, sappyView('Urgent: mental health', DISCREET_DETAIL)],
  [SELF_HARM + SAFETY_CHECK, sappyView('Urgent: mental health', DISCREET_DETAIL, true)],
])

describe('describeAlert: Sappy alerts', () => {
  for (const [reason, expected] of SAPPY_EXPECTED) {
    test(reason, () => {
      assert.deepEqual(shown(describeAlert(sappy(reason))), expected)
    })
  }

  test('thoughts of self-harm never appear on screen, with or without the keyword check', () => {
    for (const reason of [SELF_HARM, SELF_HARM + SAFETY_CHECK]) {
      const v = describeAlert(sappy(reason))
      assert.equal(v.title, 'Urgent: mental health')
      assert.doesNotMatch(v.title, /self-harm|harm|suicid/i)
      assert.doesNotMatch(JSON.stringify(v), /self-harm|thoughts of/i)
    }
  })

  test('a reason without a known prefix is shown generically, never verbatim', () => {
    const UNEXPECTED = [
      '',
      'I fell and hurt my hip, please call my daughter Jane', // patient free text, no known prefix
      'patient request: water', // known prefix, wrong case
      'Patient request water', // known prefix without the colon
      'Emergency: chest pain', // a prefix Sappy doesn't use
      'Pulse 118 bpm (+2)', // NEWS2-style text but no NEWS2 score
    ]
    for (const reason of UNEXPECTED) {
      const v = describeAlert(sappy(reason))
      assert.deepEqual(shown(v), sappyView('Patient request', 'Reported through Sappy'), JSON.stringify(reason))
      if (reason) assert.ok(!JSON.stringify(v).includes(reason), `echoed ${JSON.stringify(reason)}`)
    }
  })

  test('a known prefix with a label Sappy doesn’t use gets a generic title, never the text', () => {
    const CASES: Array<[reason: string, expected: Shown]> = [
      ['Patient request: my phone, tell Jane Doe on 555-0100', sappyView('Asked for an item', 'Request made to Sappy')],
      ['Patient request: Water', sappyView('Asked for an item', 'Request made to Sappy')], // labels are exact
      ['Patient request: ', sappyView('Asked for an item', 'Request made to Sappy')],
      ['Patient asked for the nurse: i want to go home, I live at 12 Main St', sappyView('Needs the nurse', 'Asked Sappy for the nurse')],
      ['Patient reported a possible emergency: my chest has hurt since my operation on 3 May', sappyView('Possible emergency', REPORTED)],
      ['Patient reported a possible emergency: a new kind of emergency' + SAFETY_CHECK, sappyView('Possible emergency', CAUGHT, true)],
    ]
    for (const [reason, expected] of CASES) {
      const v = describeAlert(sappy(reason))
      assert.deepEqual(shown(v), expected, reason)
      const text = reason.slice(reason.indexOf(': ') + 2).replace(SAFETY_CHECK, '')
      if (text) assert.ok(!JSON.stringify(v).toLowerCase().includes(text.toLowerCase()), `echoed ${JSON.stringify(text)}`)
    }
  })

  test('labels named like Object.prototype members are just unknown labels', () => {
    for (const label of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const as = (prefix: string) => shown(describeAlert(sappy(prefix + label)))
      assert.deepEqual(as('Patient reported a possible emergency: '), sappyView('Possible emergency', REPORTED), label)
      assert.deepEqual(as('Patient request: '), sappyView('Asked for an item', 'Request made to Sappy'), label)
      assert.deepEqual(as('Patient asked for the nurse: '), sappyView('Needs the nurse', 'Asked Sappy for the nurse'), label)
    }
  })

  test('mirrors every reason the patient app can build (apps/patient-desktop/electron/actions.ts)', async () => {
    // Imported here rather than at the top so a load problem in the other app fails only this test.
    const { ITEM_CATEGORIES, NAMED_ITEMS, NURSE_REASONS, EMERGENCY_KINDS, createAction, alertReason } = await import(
      '../../patient-desktop/electron/actions.ts'
    )
    type Spec = Parameters<typeof createAction>[0]
    const built = new Set<string>()
    for (const source of ['assistant', 'safety_check'] as const) {
      const add = (spec: Spec) =>
        built.add(alertReason(createAction(spec, { patientId: 'p1', source, patientMessage: 'stays on the device' })))
      for (const category of ITEM_CATEGORIES) add({ type: 'item_request', category })
      for (const item of NAMED_ITEMS) add({ type: 'item_request', category: 'other', item })
      for (const category of NURSE_REASONS) {
        for (const priority of ['routine', 'soon', 'urgent'] as const) add({ type: 'nurse_call', category, priority })
      }
      for (const category of EMERGENCY_KINDS) add({ type: 'emergency', category })
    }

    // Exactly the reasons this file knows. On a diff: update the tables above AND the allow-lists in
    // src/lib/alerts.ts (and decide whether a new emergency needs DISCREET wording).
    const known = new Set(SAPPY_EXPECTED.keys())
    assert.deepEqual(
      { newInActionsTs: [...built].filter((r) => !known.has(r)), goneFromActionsTs: [...known].filter((r) => !built.has(r)) },
      { newInActionsTs: [], goneFromActionsTs: [] },
    )
    // Each is shown with its own label, i.e. its label is in the matching allow-list in src/lib/alerts.ts.
    // ("an item" and "needs the nurse" read the same as the generic titles, so for those two it can't matter.)
    for (const reason of built) {
      assert.deepEqual(shown(describeAlert(sappy(reason))), SAPPY_EXPECTED.get(reason), `${reason}: label not in the allow-list?`)
    }
  })
})

// ---------- tiers, status ----------

describe('tiers and status', () => {
  test('tone maps each tier to its CSS modifier, and nothing open to "clear"', () => {
    const CASES: Array<[AlertTier | undefined, string]> = [
      ['go now', 'go'],
      ['check soon', 'soon'],
      ['watch', 'watch'],
      [undefined, 'clear'],
    ]
    for (const [tier, expected] of CASES) assert.equal(tone(tier), expected, String(tier))
  })

  test('TIER_RANK orders watch < check soon < go now', () => {
    assert.ok(TIER_RANK.watch < TIER_RANK['check soon'])
    assert.ok(TIER_RANK['check soon'] < TIER_RANK['go now'])
  })

  test('isOpen until a nurse completes it', () => {
    assert.equal(isOpen(row()), true)
    assert.equal(isOpen(row({ status: 'incomplete' })), true)
    assert.equal(isOpen(row(done('10:01'))), false)
  })

  test('takenAt is when it was completed, falling back to created_at if never stamped', () => {
    assert.equal(takenAt(row({ created_at: ts('10:00'), ...done('10:04') })), ts('10:04'))
    assert.equal(takenAt(row({ created_at: ts('10:00'), status: 'completed', completed_at: null })), ts('10:00'))
    assert.equal(takenAt(row({ created_at: ts('10:00') })), ts('10:00'))
  })
})

// ---------- ranking ----------

describe('alertPriority and outranks', () => {
  test('emergency (3) > vitals with a single 3 (2) > other vitals (1) > other requests (0)', () => {
    const CASES: Array<[alert: AlertRow, priority: number]> = [
      [sappy('Patient reported a possible emergency: possible stroke signs'), 3],
      [sappy(`Patient reported a possible emergency: chest pain${SAFETY_CHECK}`), 3],
      [sappy(SELF_HARM), 3],
      [sappy('Patient reported a possible emergency: not one of the labels'), 3], // still reported as an emergency
      [news2(9, NINE), 2],
      [news2(5, 'Pulse 118 bpm (+2); Consciousness V (not alert) (+3)'), 2], // a 3 at the end
      [news2(3, 'SpO2 83% (Scale 2) (+3)'), 2],
      [news2(7, SEVEN_NO_3), 1],
      [news2(2, 'NEWS2 tier confirmed'), 1],
      [news2(0, ''), 1],
      [sappy('Patient asked for the nurse: help to the bathroom'), 0],
      [sappy('Patient request: water'), 0],
      [sappy('something else entirely'), 0],
    ]
    for (const [alert, priority] of CASES) assert.equal(alertPriority(alert), priority, alert.reason)
  })

  test('outranks: tier first, then priority, then the newer alert', () => {
    const goVitals = news2(7, SEVEN_NO_3) // go now, priority 1
    const soonSingle3 = news2(3, 'Consciousness U (not alert) (+3)', { created_at: ts('10:30') }) // check soon, priority 2
    assert.ok(outranks(goVitals, soonSingle3) > 0) // tier beats priority
    const stroke = sappy('Patient reported a possible emergency: possible stroke signs') // go now, 10:00
    const newerGo = news2(9, NINE, { created_at: ts('10:10') }) // go now, priority 2
    assert.ok(outranks(stroke, newerGo) > 0) // priority beats recency
    const older = news2(7, SEVEN_NO_3, { created_at: ts('09:00') })
    assert.ok(outranks(goVitals, older) > 0) // same tier and priority: newer first
  })

  test('outranks is antisymmetric, and 0 only for a tie', () => {
    const a = news2(7, SEVEN_NO_3)
    const b = sappy('Patient reported a possible emergency: a fall')
    assert.equal(Math.sign(outranks(a, b)), -Math.sign(outranks(b, a)))
    assert.notEqual(outranks(a, b), 0)
    assert.equal(outranks(a, a), 0)
  })
})

// ---------- openGroups ----------

describe('openGroups', () => {
  // Same priority throughout (no score, no prefix), so tier and time decide; ranking is tested below.
  const aTaken = row({ patient_id: 'pA', tier: 'go now', created_at: ts('10:09'), ...done('10:10') })
  const eGo = row({ patient_id: 'pE', tier: 'go now', created_at: ts('10:08') })
  const aWatch = row({ patient_id: 'pA', tier: 'watch', created_at: ts('10:07') })
  const aGoNewer = row({ patient_id: 'pA', tier: 'go now', created_at: ts('10:06') })
  const aGoOlder = row({ patient_id: 'pA', tier: 'go now', created_at: ts('10:05') })
  const dTaken = row({ patient_id: 'pD', tier: 'go now', created_at: ts('10:04'), ...done('10:05') })
  const aSoonOldest = row({ patient_id: 'pA', tier: 'check soon', created_at: ts('10:00') })
  const cGo = row({ patient_id: 'pC', tier: 'go now', created_at: ts('09:30') })
  const aWatchOld = row({ patient_id: 'pA', tier: 'watch', created_at: ts('09:15') }) // older than pA's urgent alerts
  const bSoon = row({ patient_id: 'pB', tier: 'check soon', created_at: ts('09:00') })
  const fWatchNewer = row({ patient_id: 'pF', tier: 'watch', created_at: ts('08:30') })
  const fWatchOlder = row({ patient_id: 'pF', tier: 'watch', created_at: ts('08:00') })
  // Newest first, like ward.alerts.
  const ALERTS = [aTaken, eGo, aWatch, aGoNewer, aGoOlder, dTaken, aSoonOldest, cGo, aWatchOld, bSoon, fWatchNewer, fWatchOlder]

  const group = (alerts: AlertRow[], patientId: string) => {
    const g = openGroups(alerts).find((x) => x.patientId === patientId)
    assert.ok(g, `no open group for ${patientId}`)
    return g
  }

  test('one group per patient with open alerts; completed alerts are left out', () => {
    assert.deepEqual(openGroups(ALERTS).map((g) => g.patientId).sort(), ['pA', 'pB', 'pC', 'pE', 'pF']) // pD: all taken
    assert.deepEqual(group(ALERTS, 'pA').alerts, [aWatch, aGoNewer, aGoOlder, aSoonOldest, aWatchOld])
  })

  test('top is the highest tier, newest within it (not the newest overall, not a taken one)', () => {
    assert.equal(group(ALERTS, 'pA').top, aGoNewer)
    assert.equal(group(ALERTS, 'pB').top, bSoon)
    assert.equal(group(ALERTS, 'pF').top, fWatchNewer)
  })

  test('top: a reported emergency beats a newer NEWS2 alert of the same tier', () => {
    const stroke = row({
      patient_id: 'pS',
      tier: 'go now',
      created_at: ts('10:00'),
      reason: 'Patient reported a possible emergency: possible stroke signs',
    })
    const newerVitals = row({
      patient_id: 'pS',
      tier: 'go now',
      created_at: ts('10:10'),
      news2_score: 8,
      reason: 'Respiratory rate 26/min (+3); Pulse 124 bpm (+2); SpO2 93% (+2); Temperature 38.6 °C (+1)',
    })
    assert.equal(group([newerVitals, stroke], 'pS').top, stroke)
  })

  test('top within a tier: a single 3 beats other vitals and requests, even when older', () => {
    const single3 = row({ tier: 'check soon', created_at: ts('10:00'), news2_score: 3, reason: 'Consciousness U (not alert) (+3)' })
    const score5 = row({
      tier: 'check soon',
      created_at: ts('10:05'),
      news2_score: 5,
      reason: 'Respiratory rate 23/min (+2); Pulse 118 bpm (+2); Temperature 38.6 °C (+1)',
    })
    const pain = row({ tier: 'check soon', created_at: ts('10:10'), reason: 'Patient asked for the nurse: pain or discomfort' })
    assert.equal(group([pain, score5, single3], 'p1').top, single3)
  })

  test('since is the oldest open urgent alert; an older watch alert doesn’t count', () => {
    assert.equal(group(ALERTS, 'pA').since, ts('10:00')) // not aWatchOld's 09:15
    const oldestTaken = ALERTS.map((a) => (a === aSoonOldest ? { ...a, ...done('10:20') } : a))
    assert.equal(group(oldestTaken, 'pA').since, ts('10:05')) // the next urgent one, still not 09:15
  })

  test('since is the oldest watch alert when only watch alerts are open', () => {
    assert.equal(group(ALERTS, 'pF').since, ts('08:00'))
    const urgentTaken = ALERTS.map((a) => (a.patient_id === 'pA' && a.tier !== 'watch' && isOpen(a) ? { ...a, ...done('10:20') } : a))
    assert.equal(group(urgentTaken, 'pA').top, aWatch)
    assert.equal(group(urgentTaken, 'pA').since, ts('09:15'))
  })

  test('most urgent first, then longest waiting', () => {
    // pA waits from 10:00 (its old watch alert doesn't move it ahead of pC). pB and pF waited longest
    // but are only "check soon" and "watch".
    assert.deepEqual(
      openGroups(ALERTS).map((g) => g.patientId),
      ['pC', 'pA', 'pE', 'pB', 'pF'],
    )
  })

  test('within a tier, a higher-priority top goes first, before longer waits', () => {
    const unresponsive = row({
      patient_id: 'pU',
      tier: 'check soon',
      created_at: ts('10:30'),
      news2_score: 3,
      reason: 'Consciousness U (not alert) (+3)',
    })
    const score5 = row({
      patient_id: 'pV',
      tier: 'check soon',
      created_at: ts('09:30'),
      news2_score: 5,
      reason: 'Respiratory rate 23/min (+2); Pulse 118 bpm (+2); Temperature 38.6 °C (+1)',
    })
    const bathroom = row({
      patient_id: 'pB',
      tier: 'check soon',
      created_at: ts('09:00'),
      reason: 'Patient asked for the nurse: help to the bathroom',
    })
    assert.deepEqual(
      openGroups([unresponsive, score5, bathroom]).map((g) => g.patientId),
      ['pU', 'pV', 'pB'],
    )
    const fall = row({ patient_id: 'pF', tier: 'go now', created_at: ts('10:40'), reason: 'Patient reported a possible emergency: a fall' })
    const septic = row({
      patient_id: 'pS',
      tier: 'go now',
      created_at: ts('09:00'),
      news2_score: 9,
      reason: 'Respiratory rate 26/min (+3); Pulse 124 bpm (+2); SpO2 93% (+2); Temperature 39.2 °C (+2)',
    })
    assert.deepEqual(
      openGroups([fall, septic]).map((g) => g.patientId),
      ['pF', 'pS'],
    )
  })

  test('does not depend on the order of the input', () => {
    const summary = (alerts: AlertRow[]) => openGroups(alerts).map((g) => [g.patientId, g.top.id, g.since])
    assert.deepEqual(summary([...ALERTS].reverse()), summary(ALERTS))
  })

  test('nothing open -> no groups', () => {
    assert.deepEqual(openGroups([]), [])
    assert.deepEqual(openGroups([aTaken, dTaken]), [])
  })
})

// ---------- bedState, displayTier ----------

describe('bedState', () => {
  // Groups from the same alerts, as every screen calls it.
  const stateOf = (alerts: AlertRow[], patientId = 'p1') => bedState(alerts, openGroups(alerts), patientId)
  const groupOf = (alerts: AlertRow[]) => {
    const g = openGroups(alerts).find((x) => x.patientId === 'p1')
    assert.ok(g, 'no open group for p1')
    return g
  }
  const open = (time: string, tier: AlertTier, fields: Partial<AlertRow> = {}) =>
    row({ tier, created_at: ts(time), ...fields })
  const taken = (time: string, tier: AlertTier, doneAt: string, fields: Partial<AlertRow> = {}) =>
    row({ tier, created_at: ts(time), ...done(doneAt), ...fields })

  test('quiet: nothing open and no urgent alert taken', () => {
    assert.deepEqual(stateOf([]), { kind: 'quiet' })
    assert.deepEqual(stateOf([taken('10:00', 'watch', '10:01')]), { kind: 'quiet' }) // a taken watch alert isn't "taken"
    assert.deepEqual(stateOf([open('10:00', 'go now', { patient_id: 'p2' })]), { kind: 'quiet' }) // other beds don't count
  })

  test('watch: only watch-tier alerts are open', () => {
    const alerts = [open('10:05', 'watch'), open('10:00', 'watch')]
    assert.deepEqual(stateOf(alerts), { kind: 'watch', tier: 'watch', group: groupOf(alerts) })
  })

  test('open: an urgent alert is waiting, shown at the highest open tier', () => {
    const soon = [open('10:00', 'check soon')]
    assert.deepEqual(stateOf(soon), { kind: 'open', tier: 'check soon', group: groupOf(soon) })
    const go = [open('10:05', 'watch'), open('10:00', 'go now'), open('09:55', 'check soon')]
    assert.deepEqual(stateOf(go), { kind: 'open', tier: 'go now', group: groupOf(go) })
  })

  test('taken: the highest tier a nurse took, newest within it, with no time limit', () => {
    const goHoursAgo = taken('01:00', 'go now', '01:02') // bedState takes no clock
    assert.deepEqual(stateOf([goHoursAgo]), { kind: 'taken', tier: 'go now', alert: goHoursAgo })
    const goNewer = taken('09:30', 'go now', '09:31')
    const alerts = [taken('10:00', 'check soon', '10:02'), goNewer, taken('09:00', 'go now', '09:01')]
    assert.deepEqual(stateOf(alerts), { kind: 'taken', tier: 'go now', alert: goNewer })
  })

  test('a later taken check-soon request doesn’t make a taken go-now bed look check soon', () => {
    const go = taken('09:00', 'go now', '09:01')
    const pain = taken('10:00', 'check soon', '10:01', { reason: 'Patient asked for the nurse: pain or discomfort' })
    assert.deepEqual(stateOf([pain, go]), { kind: 'taken', tier: 'go now', alert: go })
  })

  test('taken beats a newer open watch request (taking an alert is not recovery)', () => {
    const go = taken('10:00', 'go now', '10:01')
    const water = open('10:30', 'watch', { reason: 'Patient request: water' })
    assert.deepEqual(stateOf([water, go]), { kind: 'taken', tier: 'go now', alert: go })
  })

  test('a newer open urgent alert makes a taken bed open again, at its own tier', () => {
    const alerts = [open('10:30', 'check soon'), taken('10:00', 'go now', '10:01')]
    assert.deepEqual(stateOf(alerts), { kind: 'open', tier: 'check soon', group: groupOf(alerts) })
  })

  test('an older urgent alert still open keeps the bed open, even if a newer one was taken', () => {
    const alerts = [taken('10:30', 'go now', '10:31'), open('10:00', 'check soon')]
    assert.deepEqual(stateOf(alerts), { kind: 'open', tier: 'check soon', group: groupOf(alerts) })
  })

  test('taken watch alerts don’t hide a taken urgent one', () => {
    const go = taken('10:00', 'go now', '10:01')
    assert.deepEqual(stateOf([taken('10:40', 'watch', '10:41'), go]), { kind: 'taken', tier: 'go now', alert: go })
  })

  test('Sappy emergencies count like vitals alerts', () => {
    const fall = taken('10:00', 'go now', '10:01', { reason: 'Patient reported a possible emergency: a fall' })
    assert.deepEqual(stateOf([fall]), { kind: 'taken', tier: 'go now', alert: fall })
  })

  test('does not depend on the order of the alerts', () => {
    const alerts = [open('10:30', 'watch'), taken('10:00', 'check soon', '10:02'), taken('09:30', 'go now', '09:31'), taken('09:00', 'go now', '09:01')]
    assert.deepEqual(stateOf([...alerts].reverse()), stateOf(alerts))
  })

  test('stateTier: open, taken and watch beds show their tier; quiet beds none', () => {
    assert.equal(stateTier(stateOf([open('10:00', 'go now')])), 'go now')
    assert.equal(stateTier(stateOf([taken('10:00', 'check soon', '10:01')])), 'check soon')
    assert.equal(stateTier(stateOf([open('10:00', 'watch')])), 'watch')
    assert.equal(stateTier(stateOf([])), undefined)
  })
})

describe('displayTier', () => {
  type LiveScore = NonNullable<Parameters<typeof displayTier>[1]>
  const live = (confirmed_tier: LiveScore['confirmed_tier']): LiveScore => ({ confirmed_tier })
  const stateOf = (alerts: AlertRow[]) => bedState(alerts, openGroups(alerts), 'p1')
  const QUIET = stateOf([])
  const WATCH = stateOf([row({ tier: 'watch' })])
  const OPEN_SOON = stateOf([row({ tier: 'check soon' })])
  const TAKEN_GO = stateOf([row({ tier: 'go now', ...done('10:01') })])
  const TAKEN_SOON = stateOf([row({ tier: 'check soon', ...done('10:01') })])

  test('without a live score, the alert state’s tier', () => {
    assert.equal(displayTier(QUIET), undefined)
    assert.equal(displayTier(WATCH), 'watch')
    assert.equal(displayTier(TAKEN_GO), 'go now')
  })

  test('a live "none" or "watch" never changes it (a quiet bed stays quiet)', () => {
    for (const tier of ['none', 'watch'] as const) {
      assert.equal(displayTier(QUIET, live(tier)), undefined, tier)
      assert.equal(displayTier(OPEN_SOON, live(tier)), 'check soon', tier)
    }
  })

  test('raised to a more urgent live confirmed tier', () => {
    assert.equal(displayTier(QUIET, live('check soon')), 'check soon') // e.g. the alert row never arrived
    assert.equal(displayTier(WATCH, live('go now')), 'go now')
    assert.equal(displayTier(TAKEN_SOON, live('go now')), 'go now')
  })

  test('never lowered by a less urgent live tier', () => {
    assert.equal(displayTier(TAKEN_GO, live('check soon')), 'go now') // taken go-now patient asking for pain relief
    assert.equal(displayTier(OPEN_SOON, live('check soon')), 'check soon')
  })
})

// ---------- mergeAlerts ----------

describe('mergeAlerts', () => {
  test('fetched rows win over what’s on screen', () => {
    const onScreen = row({ id: 9001, tier: 'go now', created_at: ts('10:00') })
    const fetched = { ...onScreen, ...done('10:05') } // taken elsewhere while this page was disconnected
    assert.deepEqual(mergeAlerts([onScreen], [fetched]), [fetched])
  })

  test('drops on-screen rows missing from the fetch that are older than its newest row (deleted)', () => {
    const deleted = row({ created_at: ts('09:00') })
    const fetched = [row({ created_at: ts('10:00') }), row({ created_at: ts('08:00') })]
    assert.deepEqual(mergeAlerts([deleted], fetched), fetched)
  })

  test('keeps on-screen rows newer than the fetch’s newest row (arrived via Realtime after the query)', () => {
    const viaRealtime = row({ created_at: ts('10:30') })
    const fetched = [row({ created_at: ts('10:00') })]
    assert.deepEqual(mergeAlerts([viaRealtime], fetched), [viaRealtime, ...fetched])
  })

  test('adds rows only the fetch has, and returns each id once, newest first', () => {
    const a = row({ created_at: ts('09:00') })
    const b = row({ created_at: ts('10:00') })
    const c = row({ created_at: ts('10:30') })
    const merged = mergeAlerts([b, c], [a, b])
    assert.deepEqual(merged, [c, b, a])
    assert.equal(new Set(merged.map((x) => x.id)).size, merged.length)
  })
})

// ---------- previousScore ----------

describe('previousScore', () => {
  const a8 = row({ patient_id: 'pA', news2_score: 8, tier: 'go now', created_at: ts('11:00') })
  const b6 = row({ patient_id: 'pB', news2_score: 6, tier: 'check soon', created_at: ts('10:50') })
  const aSappy = row({ patient_id: 'pA', news2_score: null, tier: 'check soon', created_at: ts('10:40') })
  const a5 = row({ patient_id: 'pA', news2_score: 5, tier: 'check soon', created_at: ts('10:30'), ...done('10:31') })
  const a2 = row({ patient_id: 'pA', news2_score: 2, tier: 'watch', created_at: ts('10:00') })
  const ALERTS = [a8, b6, aSappy, a5, a2] // newest first, like ward.alerts

  test('is the latest earlier vitals alert for the same patient, taken or not', () => {
    assert.equal(previousScore(ALERTS, a8), a5) // skips pB and the Sappy alert; a5 was taken
  })

  test('steps back one alert at a time', () => {
    assert.equal(previousScore(ALERTS, a5), a2)
  })

  test('is undefined for a patient’s first vitals alert', () => {
    assert.equal(previousScore(ALERTS, a2), undefined)
    assert.equal(previousScore(ALERTS, b6), undefined)
  })

  test('works for a new alert that is not in the list yet', () => {
    const incoming = row({ patient_id: 'pA', news2_score: 9, tier: 'go now', created_at: ts('11:30') })
    assert.equal(previousScore(ALERTS, incoming), a8)
  })
})
