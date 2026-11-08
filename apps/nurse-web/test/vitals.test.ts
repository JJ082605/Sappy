// Unit tests for src/lib/vitals.ts: the vitals shown on tiles and tables, and the trend chart series.
// Run from apps/nurse-web: pnpm test
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { VitalsReading } from '@repo/shared'
import type { VitalDef } from '../src/lib/vitals.ts'
import { series, VITALS } from '../src/lib/vitals.ts'

const reading = (fields: Partial<VitalsReading> = {}): VitalsReading => ({
  patientId: 'p1',
  recordedAt: '2026-01-01T08:00:05.000Z',
  ...fields,
})
// The reading shape from CLAUDE.md.
const FULL = reading({
  encounterId: 'e1',
  heartRateBpm: 78,
  systolicMmHg: 136,
  diastolicMmHg: 80,
  spo2Percent: 94,
  temperatureC: 36.6,
  respiratoryRate: 16,
  onOxygen: false,
  consciousness: 'A',
})

function vital(key: string): VitalDef {
  const def = VITALS.find((v) => v.key === key)
  assert.ok(def, `no vital "${key}"`)
  return def
}

describe('VITALS', () => {
  test('pulse, resp. rate, SpO2, blood pressure, temperature, in that order and unit', () => {
    assert.deepEqual(
      VITALS.map((v) => [v.key, v.unit]),
      [
        ['hr', 'bpm'],
        ['rr', '/min'],
        ['spo2', '%'],
        ['bp', 'mmHg'],
        ['temp', '°C'],
      ],
    )
  })

  test('show prints each value (blood pressure as systolic/diastolic)', () => {
    const CASES: Array<[key: string, expected: string]> = [
      ['hr', '78'],
      ['rr', '16'],
      ['spo2', '94'],
      ['bp', '136/80'],
      ['temp', '36.6'],
    ]
    for (const [key, expected] of CASES) assert.equal(vital(key).show(FULL), expected, key)
  })

  test('show rounds to whole numbers, temperature to one decimal', () => {
    const r = reading({ heartRateBpm: 78.6, spo2Percent: 93.4, systolicMmHg: 120.4, diastolicMmHg: 79.6, temperatureC: 37 })
    assert.equal(vital('hr').show(r), '79')
    assert.equal(vital('spo2').show(r), '93')
    assert.equal(vital('bp').show(r), '120/80')
    assert.equal(vital('temp').show(r), '37.0')
    assert.equal(vital('temp').show(reading({ temperatureC: 38.46 })), '38.5')
  })

  test('show prints a dash for a missing value, but 0 as 0', () => {
    const empty = reading()
    for (const key of ['hr', 'rr', 'spo2', 'temp']) assert.equal(vital(key).show(empty), '–', key)
    assert.equal(vital('bp').show(empty), '–/–')
    assert.equal(vital('bp').show(reading({ systolicMmHg: 136 })), '136/–')
    assert.equal(vital('bp').show(reading({ diastolicMmHg: 80 })), '–/80')
    assert.equal(vital('hr').show(reading({ heartRateBpm: 0 })), '0')
  })

  test('get returns the raw number (systolic for blood pressure), undefined when missing', () => {
    const CASES: Array<[key: string, expected: number]> = [
      ['hr', 78],
      ['rr', 16],
      ['spo2', 94],
      ['bp', 136],
      ['temp', 36.6],
    ]
    for (const [key, expected] of CASES) {
      assert.equal(vital(key).get(FULL), expected, key)
      assert.equal(vital(key).get(reading()), undefined, key)
    }
  })

  test('calm bands are the NEWS2 0-point ranges (RCP 2017); SpO2 has none (depends on the scale)', () => {
    assert.deepEqual(vital('hr').calm, [51, 90])
    assert.deepEqual(vital('rr').calm, [12, 20])
    assert.deepEqual(vital('bp').calm, [111, 219])
    assert.deepEqual(vital('temp').calm, [36.1, 38])
    assert.equal(vital('spo2').calm, undefined)
  })
})

describe('series', () => {
  test('no history yet -> empty', () => {
    assert.deepEqual(series(undefined, vital('hr')), [])
    assert.deepEqual(series([], vital('hr')), [])
  })

  test('picks one vital in reading order, skipping readings without it', () => {
    const history = [
      reading({ heartRateBpm: 78, systolicMmHg: 136 }),
      reading({ systolicMmHg: 130 }),
      reading({ heartRateBpm: 92, systolicMmHg: 118 }),
    ]
    assert.deepEqual(series(history, vital('hr')), [78, 92])
    assert.deepEqual(series(history, vital('bp')), [136, 130, 118]) // systolic
  })

  test('keeps 0 (only undefined counts as missing)', () => {
    assert.deepEqual(series([reading({ heartRateBpm: 0 }), reading({ heartRateBpm: 40 })], vital('hr')), [0, 40])
  })
})
