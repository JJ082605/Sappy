// Unit tests for src/lib/freshness.ts: is the data on screen still arriving, and is it being scored?
// Run from apps/nurse-web: pnpm test
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Freshness } from '../src/lib/freshness.ts'
import { isStale, scoringStalledFor, STALE_MS, wardDataAge } from '../src/lib/freshness.ts'

const READY = Date.parse('2026-11-08T12:00:00Z') // browser time the ward finished loading
const S = 1000
const ward = (fields: Partial<Freshness> = {}): Freshness => ({ live: 'live', seen: {}, readyAt: READY, ...fields })

describe('isStale', () => {
  test('a bed goes stale after 30 s without data', () => {
    assert.equal(STALE_MS, 30 * S)
  })

  test('offline: every bed is stale at once, however recent its data', () => {
    const now = READY + 10 * S
    assert.equal(isStale(ward({ live: 'offline', seen: { p1: now } }), 'p1', now), true)
  })

  test('live or connecting: stale once more than 30 s have passed since the bed’s latest reading arrived', () => {
    const arrived = READY + 10 * S
    for (const live of ['live', 'connecting'] as const) {
      const f = ward({ live, seen: { p1: arrived } })
      assert.equal(isStale(f, 'p1', arrived + 5 * S), false, live)
      assert.equal(isStale(f, 'p1', arrived + STALE_MS), false, live) // exactly 30 s is still fresh
      assert.equal(isStale(f, 'p1', arrived + STALE_MS + 1), true, live)
    }
  })

  test('a page that has just loaded isn’t flagged while Realtime is still connecting', () => {
    assert.equal(isStale(ward({ live: 'connecting' }), 'p1', READY + 2 * S), false)
  })

  test('a bed with no live reading yet counts from when the ward loaded', () => {
    const f = ward({ seen: { p2: READY + 60 * S } }) // another bed's arrivals don't help p1
    assert.equal(isStale(f, 'p1', READY + STALE_MS), false)
    assert.equal(isStale(f, 'p1', READY + STALE_MS + 1), true)
  })

  test('before the ward has loaded, a bed with no reading is not flagged (unless offline)', () => {
    const later = READY + 10 * 60 * S
    for (const live of ['live', 'connecting'] as const) assert.equal(isStale(ward({ live, readyAt: undefined }), 'p1', later), false, live)
    assert.equal(isStale(ward({ live: 'offline', readyAt: undefined }), 'p1', later), true)
  })

  test('an arrival time ahead of the clock (skew) is not stale', () => {
    assert.equal(isStale(ward({ seen: { p1: READY + 60 * S } }), 'p1', READY), false)
  })
})

describe('wardDataAge', () => {
  const BEDS = ['p1', 'p2', 'p3']

  test('undefined until the ward has loaded', () => {
    assert.equal(wardDataAge(ward({ readyAt: undefined, seen: { p1: READY } }), BEDS, READY + 5 * S), undefined)
  })

  test('time since loading while no bed has sent live data', () => {
    assert.equal(wardDataAge(ward(), BEDS, READY + 42 * S), 42 * S)
    assert.equal(wardDataAge(ward(), [], READY + 42 * S), 42 * S)
  })

  test('time since the newest arrival from any of the ward’s beds', () => {
    const f = ward({ seen: { p1: READY + 5 * S, p2: READY + 20 * S } }) // p3: none yet
    assert.equal(wardDataAge(f, BEDS, READY + 60 * S), 40 * S)
  })

  test('ignores beds that are not on the ward', () => {
    const f = ward({ seen: { p1: READY + 5 * S, discharged: READY + 50 * S } })
    assert.equal(wardDataAge(f, BEDS, READY + 60 * S), 55 * S)
  })

  test('arrivals from before loading finished count as the load time', () => {
    const f = ward({ seen: { p1: READY - 10 * S } })
    assert.equal(wardDataAge(f, BEDS, READY + 30 * S), 30 * S)
  })
})

describe('scoringStalledFor', () => {
  const BEDS = ['p1', 'p2']
  const NOW = READY + 120 * S // loaded 2 min ago
  /** Live, loaded, the scores feed exists, vitals arrived 2 s ago and a score 1 s ago. */
  const healthy = (fields: Partial<Freshness> = {}) =>
    ward({ scoresAvailable: true, seen: { p1: NOW - 2 * S }, scoresSeen: NOW - 1 * S, ...fields })

  test('undefined while scores keep arriving', () => {
    assert.equal(scoringStalledFor(healthy(), BEDS, NOW), undefined)
  })

  test('how long scores have been missing, once over 30 s while vitals still arrive', () => {
    assert.equal(scoringStalledFor(healthy({ scoresSeen: NOW - 45 * S }), BEDS, NOW), 45 * S)
    assert.equal(scoringStalledFor(healthy({ scoresSeen: NOW - STALE_MS }), BEDS, NOW), undefined) // exactly 30 s
    assert.equal(scoringStalledFor(healthy({ scoresSeen: NOW - STALE_MS - 1 }), BEDS, NOW), STALE_MS + 1)
  })

  test('with no score since loading, counts from when the ward loaded', () => {
    assert.equal(scoringStalledFor(healthy({ scoresSeen: undefined }), BEDS, NOW), 120 * S)
    assert.equal(scoringStalledFor(healthy({ scoresSeen: READY - 60 * S }), BEDS, NOW), 120 * S)
    assert.equal(scoringStalledFor(healthy({ scoresSeen: undefined, seen: { p1: READY + 20 * S } }), BEDS, READY + 25 * S), undefined)
  })

  test('can’t be judged without the scores feed, before loading, or when not live', () => {
    const stalled = { scoresSeen: NOW - 60 * S }
    assert.equal(scoringStalledFor(healthy({ ...stalled, scoresAvailable: false }), BEDS, NOW), undefined)
    assert.equal(scoringStalledFor(healthy({ ...stalled, scoresAvailable: undefined }), BEDS, NOW), undefined)
    assert.equal(scoringStalledFor(healthy({ ...stalled, readyAt: undefined }), BEDS, NOW), undefined)
    for (const live of ['connecting', 'offline'] as const) {
      assert.equal(scoringStalledFor(healthy({ ...stalled, live }), BEDS, NOW), undefined, live)
    }
  })

  test('left to the vitals banner when vitals have stopped too', () => {
    assert.equal(scoringStalledFor(healthy({ scoresSeen: NOW - 60 * S, seen: { p1: NOW - 31 * S } }), BEDS, NOW), undefined)
    assert.equal(scoringStalledFor(healthy({ scoresSeen: NOW - 60 * S, seen: { p1: NOW - 30 * S } }), BEDS, NOW), 60 * S)
  })
})
