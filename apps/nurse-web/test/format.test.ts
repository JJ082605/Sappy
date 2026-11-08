// Unit tests for src/lib/format.ts: small display helpers (beds, times, durations, patient facts).
// Run from apps/nurse-web: pnpm test
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import type { Patient } from '@repo/shared'
import {
  bedParts,
  clinicalConditions,
  elapsed,
  hourLabel,
  median,
  minutes,
  patientMeta,
  shortMed,
  timer,
} from '../src/lib/format.ts'

const MIN = 60_000
const patient = (fields: Partial<Patient> = {}): Patient => ({ id: 'p1', ageBand: '70-79', ...fields })
const conditionsOf = (...conditions: string[]) => clinicalConditions(patient({ conditions }))

/** The scrubbed patients the simulator loads (server/data/clean, committed). */
interface CleanPatient {
  conditions?: Array<{ display?: string }>
  medications?: Array<{ display?: string }>
}
function cleanDisplays(field: 'conditions' | 'medications'): string[] {
  const dir = new URL('../../../server/data/clean/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.length > 0, 'no patients in server/data/clean')
  const all = files.flatMap((f) => {
    const p = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as CleanPatient
    return (p[field] ?? []).map((x) => x.display ?? '')
  })
  return [...new Set(all.filter(Boolean))].sort()
}

describe('bedParts', () => {
  const CASES: Array<[label: string | undefined, expected: { ward: string; num: string }]> = [
    ['4W-02', { ward: '4W', num: '02' }],
    ['ICU-B-12', { ward: 'ICU-B', num: '12' }], // splits on the last dash
    ['12', { ward: '', num: '12' }], // no dash: the whole label is the number
    ['-7', { ward: '', num: '-7' }], // a leading dash is not a separator
    ['', { ward: '', num: '?' }],
    [undefined, { ward: '', num: '?' }],
  ]
  for (const [label, expected] of CASES) {
    test(`${JSON.stringify(label)} -> ${expected.ward}|${expected.num}`, () => {
      assert.deepEqual(bedParts(label), expected)
    })
  }
})

describe('hourLabel', () => {
  // Built from local time, as the activity log's hour buckets are.
  const CASES: Array<[hour: number, minute: number, expected: string]> = [
    [0, 5, '00:00'],
    [9, 59, '09:00'],
    [14, 30, '14:00'], // 24 h, not "2 PM"
    [23, 59, '23:00'],
  ]
  for (const [hour, minute, expected] of CASES) {
    test(`${hour}:${String(minute).padStart(2, '0')} -> ${expected}`, () => {
      assert.equal(hourLabel(new Date(2026, 10, 8, hour, minute)), expected)
    })
  }
})

describe('timer', () => {
  const CASES: Array<[ms: number, expected: string]> = [
    [0, '0:00'],
    [999, '0:00'], // whole seconds, rounded down
    [42_000, '0:42'],
    [59_999, '0:59'],
    [MIN, '1:00'],
    [12 * MIN + 5_000, '12:05'],
    [3_599_999, '59:59'],
    [60 * MIN, '1:00:00'], // hours appear from 60 minutes
    [64 * MIN + 10_000, '1:04:10'],
    [600 * MIN, '10:00:00'],
    [25 * 60 * MIN + 61_000, '25:01:01'], // no day rollover
    [-5_000, '0:00'], // clock skew never shows a negative wait
  ]
  for (const [ms, expected] of CASES) {
    test(`${ms} ms -> ${expected}`, () => {
      assert.equal(timer(ms), expected)
    })
  }
})

describe('minutes', () => {
  const CASES: Array<[ms: number, expected: string]> = [
    [0, '<1 min'],
    [30_000, '<1 min'], // a wait never rounds up
    [59_999, '<1 min'],
    [MIN, '1 min'],
    [2 * MIN - 1, '1 min'],
    [4 * MIN, '4 min'],
    [59.5 * MIN, '59 min'],
    [60 * MIN - 1, '59 min'],
    [60 * MIN, '1 h 00 min'],
    [65 * MIN, '1 h 05 min'],
    [125 * MIN, '2 h 05 min'],
    [600 * MIN, '10 h 00 min'],
    [-2 * MIN, '<1 min'],
  ]
  for (const [ms, expected] of CASES) {
    test(`${ms} ms -> ${expected}`, () => {
      assert.equal(minutes(ms), expected)
    })
  }
})

describe('elapsed', () => {
  const CASES: Array<[ms: number, expected: string]> = [
    [0, '0 s'],
    [999, '0 s'],
    [45_000, '45 s'],
    [59_999, '59 s'],
    [MIN, '1 min'], // from a minute on, as minutes()
    [2 * MIN - 1, '1 min'],
    [22 * MIN + 59_000, '22 min'],
    [65 * MIN, '1 h 05 min'],
    [-5_000, '0 s'], // clock skew never shows a negative time
    [-2 * MIN, '0 s'],
  ]
  for (const [ms, expected] of CASES) {
    test(`${ms} ms -> ${expected}`, () => {
      assert.equal(elapsed(ms), expected)
    })
  }

  test('reads as a duration, never as a time of day like "1:05"', () => {
    for (const ms of [0, 45_000, MIN, 65 * MIN, 600 * MIN]) assert.doesNotMatch(elapsed(ms), /:/, String(ms))
  })
})

describe('median', () => {
  const CASES: Array<[values: number[], expected: number | undefined]> = [
    [[], undefined],
    [[7], 7],
    [[3, 1, 2], 2], // odd count: the middle value
    [[4, 1, 3, 2], 2.5], // even count: mean of the two middle values
    [[1, 10, 2, 9], 5.5], // sorted as numbers (as strings it would be 6)
    [[-3, 3], 0],
    [[MIN, 3 * MIN], 2 * MIN], // response times in ms, as the shift panel uses it
  ]
  for (const [values, expected] of CASES) {
    test(`[${values.join(', ')}] -> ${expected}`, () => {
      assert.equal(median(values), expected)
    })
  }

  test('leaves the input in its original order', () => {
    const values = [3, 1, 2]
    median(values)
    assert.deepEqual(values, [3, 1, 2])
  })
})

describe('patientMeta', () => {
  const CASES: Array<[fields: Partial<Patient>, expected: string]> = [
    [{ ageBand: '80-89', gender: 'female' }, '80-89, female'],
    [{ ageBand: '70-79', gender: 'male' }, '70-79, male'],
    [{ ageBand: '60-69', gender: 'other' }, '60-69, other'],
    [{ ageBand: '60-69', gender: 'unknown' }, '60-69'], // "unknown" isn't worth showing
    [{ ageBand: '90+' }, '90+'],
  ]
  for (const [fields, expected] of CASES) {
    test(`${JSON.stringify(fields)} -> ${expected}`, () => {
      assert.equal(patientMeta(patient(fields)), expected)
    })
  }
})

describe('clinicalConditions', () => {
  test('strips the SNOMED semantic tag', () => {
    assert.deepEqual(
      conditionsOf(
        'Essential hypertension (disorder)',
        'Prediabetes (finding)',
        'Chronic pain (finding)',
        'History of myocardial infarction (situation)',
        'Polyp of colon (morphologic abnormality)',
        'Anemia (DISORDER)',
        'Gingivitis (disorder)  ',
        'Body mass index 30+ - obesity (finding)',
        'Hyperlipidemia', // already plain: what the simulator writes to Supabase
      ),
      [
        'Essential hypertension',
        'Prediabetes',
        'Chronic pain',
        'History of myocardial infarction',
        'Polyp of colon',
        'Anemia',
        'Gingivitis',
        'Body mass index 30+ - obesity',
        'Hyperlipidemia',
      ],
    )
  })

  // Social findings Synthea v4.0.0 records as Conditions (modules encounter/sdoh_hrsn.json,
  // encounter/hark_screening.json, encounter/substance_use_screening.json, med_rec.json).
  test('drops Synthea’s social findings by whole name, tagged or plain, in any case', () => {
    const SOCIAL = [
      'Full-time employment (finding)',
      'Part-time employment (finding)',
      'Not in labor force (finding)',
      'Unemployed (finding)',
      'Received higher education (finding)',
      'Educated to high school level (finding)',
      'Only received primary school education (finding)',
      'Has a criminal record (finding)',
      'Housing unsatisfactory (finding)',
      'Stress (finding)',
      'Social isolation (finding)',
      'Limited social contact (finding)',
      'Reports of violence in the environment (finding)',
      'Victim of intimate partner abuse (finding)',
      'Lack of access to transportation (finding)',
      'Transport problem (finding)',
      'Risk activity involvement (finding)',
      'Medication review due (situation)',
    ]
    for (const c of SOCIAL) {
      const plain = c.replace(/ \((finding|situation)\)$/, '') // as the simulator writes it to Supabase
      assert.deepEqual(conditionsOf(c, plain, plain.toUpperCase()), [], c)
    }
    assert.deepEqual(conditionsOf('Refugee'), []) // the simulator strips "(person)" before Supabase
    assert.deepEqual(
      conditionsOf('Full-time employment (finding)', 'Sepsis (disorder)', 'Stress (finding)', 'Alcoholism (disorder)'),
      ['Sepsis', 'Alcoholism'],
    )
  })

  test('drops the other social findings Synthea v4.0.0 records', () => {
    const missed = [
      'Homeless (finding)',
      'Social migrant (finding)',
      'Serving in military service (finding)',
      'Refugee (person)',
    ].filter((c) => conditionsOf(c).length > 0)
    assert.deepEqual(missed, [])
  })

  test('keeps substance-use findings: they change care (e.g. withdrawal risk)', () => {
    assert.deepEqual(conditionsOf('Unhealthy alcohol drinking behavior (finding)', 'Misuses drugs (finding)'), [
      'Unhealthy alcohol drinking behavior',
      'Misuses drugs',
    ])
  })

  test('keeps clinical names that merely contain a social word (whole-name match only)', () => {
    assert.deepEqual(
      conditionsOf(
        'Posttraumatic stress disorder (disorder)', // Synthea's spelling
        'Post-traumatic stress disorder',
        'Acute respiratory distress syndrome (disorder)',
        'Respiratory distress (finding)',
        'Stress incontinence',
        'Dependent drug abuse (disorder)',
      ),
      [
        'Posttraumatic stress disorder',
        'Post-traumatic stress disorder',
        'Acute respiratory distress syndrome',
        'Respiratory distress',
        'Stress incontinence',
        'Dependent drug abuse',
      ],
    )
  })

  test('no conditions, or blank ones -> nothing', () => {
    assert.deepEqual(clinicalConditions(patient()), [])
    assert.deepEqual(conditionsOf('', '   ', '(disorder)'), [])
  })

  test('keeps every condition the transform step lets through (server/data/clean)', () => {
    const hidden = cleanDisplays('conditions').filter((c) => conditionsOf(c).length === 0)
    assert.deepEqual(hidden, [])
  })
})

describe('shortMed', () => {
  const CASES: Array<[display: string, expected: string]> = [
    ['24 HR metoprolol succinate 100 MG Extended Release Oral Tablet', 'Metoprolol succinate 100 mg'],
    ['24 HR tacrolimus 1 MG Extended Release Oral Tablet [Envarsus]', 'Tacrolimus 1 mg'],
    ['lisinopril 10 MG Oral Tablet', 'Lisinopril 10 mg'],
    ['Acetaminophen 325 MG Oral Tablet [Tylenol]', 'Acetaminophen 325 mg'],
    ['Loratadine 5 MG Chewable Tablet', 'Loratadine 5 mg'],
    ['Alteplase 100 MG Injection', 'Alteplase 100 mg'],
    ['albuterol 5 MG/ML Inhalation Solution', 'Albuterol 5 mg/mL'],
    ['Vitamin B12 5 MG/ML Injectable Solution', 'Vitamin B12 5 mg/mL'],
    ['Hydrocortisone 10 MG/ML Topical Cream', 'Hydrocortisone 10 mg/mL'],
    ['doxycycline hyclate 100 MG', 'Doxycycline hyclate 100 mg'],
    ['amLODIPine 2.5 MG Oral Tablet', 'AmLODIPine 2.5 mg'], // tall-man lettering kept
    // package code and decimal pack sizes
    ['NDA020800 0.3 ML Epinephrine 1 MG/ML Auto-Injector', 'Epinephrine 1 mg/mL'],
    ['0.4 ML Medroxyprogesterone acetate 150 MG/ML Injection', 'Medroxyprogesterone acetate 150 mg/mL'],
  ]
  for (const [display, expected] of CASES) {
    test(`${display} -> ${expected}`, () => {
      assert.equal(shortMed(display), expected)
    })
  }

  // Dropping an ingredient would hide e.g. an opioid from the nurse.
  const COMBINATIONS: Array<[display: string, expected: string]> = [
    ['Acetaminophen 325 MG / Oxycodone Hydrochloride 10 MG Oral Tablet [Percocet]', 'Acetaminophen 325 mg + Oxycodone Hydrochloride 10 mg'],
    ['Acetaminophen 300 MG / Hydrocodone Bitartrate 5 MG Oral Tablet', 'Acetaminophen 300 mg + Hydrocodone Bitartrate 5 mg'],
    ['Acetaminophen 300 MG / Codeine Phosphate 15 MG Oral Tablet', 'Acetaminophen 300 mg + Codeine Phosphate 15 mg'],
    ['amlodipine 10 MG / benazepril hydrochloride 20 MG Oral Capsule', 'Amlodipine 10 mg + benazepril hydrochloride 20 mg'],
    [
      '60 ACTUAT Fluticasone propionate 0.25 MG/ACTUAT / salmeterol 0.05 MG/ACTUAT Dry Powder Inhaler',
      'Fluticasone propionate 0.25 mg/ACTUAT + salmeterol 0.05 mg/ACTUAT',
    ],
    [
      'insulin isophane, human 70 UNT/ML / insulin, regular, human 30 UNT/ML Injectable Suspension [Humulin]',
      'Insulin isophane, human 70 UNT/mL + insulin, regular, human 30 UNT/mL',
    ],
    [
      '24 HR Donepezil hydrochloride 10 MG / Memantine hydrochloride 28 MG Extended Release Oral Capsule',
      'Donepezil hydrochloride 10 mg + Memantine hydrochloride 28 mg',
    ],
  ]
  for (const [display, expected] of COMBINATIONS) {
    test(`keeps every ingredient: ${display} -> ${expected}`, () => {
      assert.equal(shortMed(display), expected)
    })
  }

  test('every medication in server/data/clean keeps its ingredients and loses pack, form, brand and upper-case units', () => {
    for (const display of cleanDisplays('medications')) {
      const s = shortMed(display)
      const msg = `${display} -> ${s}`
      assert.match(s, /^[A-Z]/, msg)
      assert.equal(s.split(' + ').length, display.split(' / ').length, msg)
      assert.doesNotMatch(s, /\b(MG|ML)\b/, msg)
      assert.doesNotMatch(s, /^(NDA\d|\d+(\.\d+)?\s*(HR|ML|ACTUAT)\b)|Oral|Tablet|Capsule|Extended Release|\[| \/ /i, msg)
    }
  })
})
