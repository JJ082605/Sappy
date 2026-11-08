// Unit tests for delivery in electron/actions.ts: dispatchAction() POSTs an action to the vitals
// simulator (POST /patient-requests) and resolves 'sent', 'failed' or 'offline'.
// Run from apps/patient-desktop: pnpm test (node --test, no extra dependencies, no network).
// The simulator's side (validation, the 60 s repeat rule) is tested in server/sim/test_patient_requests.py.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAction, dispatchAction, type PatientAction } from '../electron/actions.ts'
import { assertAllUsed, assertPrivate, install, ONLINE, PATIENT_WORDS, setEnv, sim, TOKEN, type Stub } from './stubs.ts'

type Spec = Parameters<typeof createAction>[0]
const make = (spec: Spec, patientId: string | null = 'p0', source: PatientAction['source'] = 'assistant') =>
  createAction(spec, { patientId, source, patientMessage: PATIENT_WORDS, detail: PATIENT_WORDS })
const emergency = () => make({ type: 'emergency', category: 'chest_pain' }, 'p0', 'safety_check')
const nurseCall = () => make({ type: 'nurse_call', category: 'pain', priority: 'soon' })
const NO_WAIT = 1 // ms between an emergency's two attempts here; the real 2 s default has its own test

/** Let pending promises and I/O callbacks run (setImmediate isn't faked by the timer mocks below). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

let stub: Stub
beforeEach(() => {
  stub = install()
  setEnv(ONLINE)
})
afterEach(() => stub.restore())

describe('sent', () => {
  test('posts only fixed values to <SIM_URL>/patient-requests, with the token', async () => {
    setEnv({ SIM_URL: 'https://sim.test/', PATIENT_REQUEST_TOKEN: ` ${TOKEN} ` })
    stub.sim.push(sim.created())
    const action = make({ type: 'item_request', category: 'drink', item: 'orange juice, no ice' })
    assert.equal(await dispatchAction(action, NO_WAIT), 'sent')
    const [request] = stub.simRequests
    assert.equal(request.url, 'https://sim.test/patient-requests')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(request.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(request.body), {
      patientId: 'p0', source: 'assistant', type: 'item_request', category: 'drink', item: 'juice',
    })
    assert.ok(stub.logs.some((line) => line.includes('delivered to staff')))
    assert.ok(stub.logs.some((line) => line.startsWith('local only, never sent: ') && line.includes('Jane')))
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('every type sends its fixed values and nothing else', async () => {
    const cases: [PatientAction, object][] = [
      [make({ type: 'item_request', category: 'comfort' }), { patientId: 'p0', source: 'assistant', type: 'item_request', category: 'comfort' }],
      [nurseCall(), { patientId: 'p0', source: 'assistant', type: 'nurse_call', category: 'pain', priority: 'soon' }],
      [emergency(), { patientId: 'p0', source: 'safety_check', type: 'emergency', category: 'chest_pain' }],
    ]
    for (const [action, body] of cases) {
      stub.sim.push(sim.created())
      assert.equal(await dispatchAction(action, NO_WAIT), 'sent')
      assert.deepEqual(JSON.parse(stub.simRequests.at(-1)!.body), body)
    }
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('a reply whose reason differs from actions.ts is flagged in the log', async () => {
    stub.sim.push(sim.reason('Patient request: a pony'))
    assert.equal(await dispatchAction(make({ type: 'item_request', category: 'food' }), NO_WAIT), 'sent')
    assert.ok(stub.logs.some((line) => line.includes('labels differ from actions.ts')))
    assertAllUsed(stub)
  })
})

describe('emergencies: one retry after a transient failure', () => {
  const transient: [string, () => () => Response | Promise<Response>][] = [
    ['network error', sim.networkError],
    ['timeout', sim.timeout],
    ['HTTP 500', () => sim.status(500)],
    ['HTTP 502 error page', () => sim.page(502, 'Bad Gateway')],
    ['HTTP 503', () => sim.status(503)],
  ]
  for (const [name, failure] of transient) {
    test(`${name}: retried once, then sent`, async () => {
      stub.sim.push(failure(), sim.created())
      assert.equal(await dispatchAction(emergency(), NO_WAIT), 'sent')
      const [first, second] = stub.simRequests
      assert.equal(second.body, first.body) // same patient, type and category: a repeat if the first got through
      assert.ok(stub.logs.some((line) => line.includes('retrying the emergency alert')))
      assertAllUsed(stub)
      assertPrivate(stub)
    })
  }

  test('fails if the retry fails too', async () => {
    stub.sim.push(sim.networkError(), sim.status(503))
    assert.equal(await dispatchAction(emergency(), NO_WAIT), 'failed')
    assert.equal(stub.simRequests.length, 2)
    assertAllUsed(stub)
  })

  test('lost answer: the simulator answers the retry as a repeat, which counts as sent', async () => {
    // The first POST reached the simulator, which wrote the alert, but its answer never arrived.
    stub.sim.push(sim.networkError(), sim.duplicate())
    assert.equal(await dispatchAction(emergency(), NO_WAIT), 'sent')
    assert.equal(stub.simRequests.length, 2)
    assert.ok(stub.logs.some((line) => line.includes('already sent in the last minute')))
    assertAllUsed(stub)
  })

  test('waits 2 s before the retry by default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    stub.sim.push(sim.status(503), sim.created())
    const delivery = dispatchAction(emergency())
    await settle()
    assert.equal(stub.simRequests.length, 1)
    t.mock.timers.tick(1_999)
    await settle()
    assert.equal(stub.simRequests.length, 1, 'retried before 2 s')
    t.mock.timers.tick(1)
    assert.equal(await delivery, 'sent')
    assert.equal(stub.simRequests.length, 2)
    assertAllUsed(stub)
  })
})

describe('no retry', () => {
  test('HTTP 4xx is final, even for an emergency: one POST and no wait', async () => {
    for (const status of [400, 401, 404, 413]) {
      stub.sim.push(sim.status(status))
      const start = Date.now()
      assert.equal(await dispatchAction(emergency(), 5_000), 'failed')
      assert.ok(Date.now() - start < 1_000, `waited for a retry after HTTP ${status}`)
      assert.ok(stub.logs.some((line) => line.includes(`NOT DELIVERED (HTTP ${status})`)))
    }
    assert.equal(stub.simRequests.length, 4)
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('requests other than emergencies are never retried', async () => {
    for (const failure of [sim.networkError(), sim.timeout(), sim.status(503), sim.status(401)]) {
      stub.sim.push(failure)
      assert.equal(await dispatchAction(nurseCall(), NO_WAIT), 'failed')
    }
    assert.equal(stub.simRequests.length, 4)
    assertAllUsed(stub)
    assertPrivate(stub)
  })
})

describe('offline (demo) device', () => {
  const cases: [string, Record<string, string>, string | null, string][] = [
    ['SIM_URL unset', { PATIENT_REQUEST_TOKEN: TOKEN }, 'p0', 'SIM_URL not set'],
    ['PATIENT_REQUEST_TOKEN unset', { SIM_URL: 'http://sim.test' }, 'p0', 'PATIENT_REQUEST_TOKEN not set'],
    ['both unset', {}, 'p0', 'SIM_URL and PATIENT_REQUEST_TOKEN not set'],
    ['PATIENT_ID unset', ONLINE, null, 'no PATIENT_ID assigned'],
  ]
  for (const [name, env, patientId, why] of cases) {
    test(`${name}: nothing sent, no retry wait, logged as a demo/offline device`, async () => {
      setEnv(env)
      const start = Date.now()
      const action = make({ type: 'emergency', category: 'fall' }, patientId)
      assert.equal(await dispatchAction(action), 'offline') // the default 2 s retry wait must not apply
      assert.ok(Date.now() - start < 1_000)
      assert.equal(stub.simRequests.length, 0)
      const line = stub.logs.find((l) => l.startsWith('NOT SENT, demo/offline device'))
      assert.ok(line?.includes(`(${why};`), `log line: ${line}`)
      assert.ok(line?.includes('the nurses were NOT told'))
      assertAllUsed(stub)
      assertPrivate(stub)
    })
  }
})
