// Unit tests for electron/agent.ts: what the patient is told about each action. Nothing is confirmed
// until it has been delivered; when it wasn't, the reply is fixed (NOT_DELIVERED_REPLY) and sends the
// patient to the call button. Run from apps/patient-desktop: pnpm test (node --test, no network).
// The chat model and the simulator are stubbed (test/stubs.ts).
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchAction, type Delivery, type PatientAction } from '../electron/actions.ts'
import { NOT_DELIVERED_REPLY, runAgent, type AgentOptions } from '../electron/agent.ts'
import { assertAllUsed, assertPrivate, install, model, ONLINE, PATIENT_WORDS, setEnv, sim, type Stub } from './stubs.ts'

const HELP_ON_THE_WAY = "I've alerted the nursing staff and help is on the way. Please press your call button now if you can."

let stub: Stub
beforeEach(() => {
  stub = install()
})
afterEach(() => stub.restore())

/** One turn: the patient says `text`, plus words that must stay on the device. */
const turn = (text: string, onAction: AgentOptions['onAction'], patientId: string | null = 'p0') =>
  runAgent([{ role: 'user', content: `${text} (${PATIENT_WORDS})` }], {
    ollamaHost: 'http://ollama.test',
    model: 'test',
    patientId,
    onAction,
  })

/** A delivery function reporting fixed outcomes in order ('failed' once they run out). */
function deliver(...outcomes: Delivery[]) {
  const actions: PatientAction[] = []
  const onAction = async (action: PatientAction): Promise<Delivery> => {
    actions.push(action)
    return outcomes.shift() ?? 'failed'
  }
  return { onAction, actions }
}

const toolResults = () => stub.modelRequests.flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => m.content)

describe('delivered: confirmed', () => {
  test('a request is confirmed by the model, which is told it was sent', async () => {
    const d = deliver('sent')
    stub.model.push(model.tools(['request_item', { item: 'some water', category: 'drink' }]), model.say("I've asked your nurse to bring you some water."))
    const r = await turn('Could I have some water?', d.onAction)
    assert.equal(r.reply, "I've asked your nurse to bring you some water.")
    assert.deepEqual(r.actions.map((a) => [a.type, a.delivery]), [['item_request', 'sent']])
    assert.match(toolResults()[0], /^Request sent to staff: water\./)
    assertAllUsed(stub)
  })

  test('a keyword emergency is delivered before the model is asked, and the model is told', async () => {
    const d = deliver('sent')
    stub.model.push(model.say('Help is on the way. Please press your call button if you can.'))
    const r = await turn("I can't breathe", d.onAction)
    assert.equal(r.reply, 'Help is on the way. Please press your call button if you can.')
    assert.deepEqual(d.actions.map((a) => [a.type, a.source]), [['emergency', 'safety_check']])
    const told = stub.modelRequests[0].messages.some((m) => m.role === 'system' && m.content.includes('ALREADY been sent'))
    assert.ok(told, 'the model should be told the alert was sent')
    assertAllUsed(stub)
  })

  test('no usable model reply after delivered actions: an accurate fallback', async () => {
    const d = deliver('sent')
    stub.model.push(model.tools(['call_nurse', { reason: 'pain', priority: 'soon' }]), model.say('  '))
    const r = await turn('My back is sore, can a nurse come?', d.onAction)
    assert.equal(r.reply, "I've let the staff know. Someone will be with you soon.")
    assertAllUsed(stub)
  })
})

describe('not delivered: a fixed reply sends the patient to the call button', () => {
  for (const outcome of ['failed', 'offline'] as const) {
    test(`request ${outcome}: other-request reply, and the model isn't asked again`, async () => {
      const d = deliver(outcome)
      stub.model.push(model.tools(['call_nurse', { reason: 'pain', priority: 'soon' }]))
      const r = await turn('My back is sore, can a nurse come?', d.onAction)
      assert.equal(r.reply, NOT_DELIVERED_REPLY.other)
      assert.deepEqual(r.actions.map((a) => a.delivery), [outcome])
      assert.equal(stub.modelRequests.length, 1)
      assertAllUsed(stub)
    })

    test(`keyword emergency ${outcome}: emergency reply at once, the model is never asked`, async () => {
      const d = deliver(outcome)
      const r = await turn("I can't breathe", d.onAction)
      assert.equal(r.reply, NOT_DELIVERED_REPLY.emergency)
      assert.equal(stub.modelRequests.length, 0)
      assertAllUsed(stub)
    })

    test(`emergency_alert tool ${outcome}: emergency reply`, async () => {
      const d = deliver(outcome)
      stub.model.push(model.tools(['emergency_alert', { kind: 'other' }]))
      const r = await turn('Something is very wrong, please get help', d.onAction)
      assert.equal(r.reply, NOT_DELIVERED_REPLY.emergency)
      assertAllUsed(stub)
    })
  }

  test('stops at the first action that is not delivered', async () => {
    const d = deliver('failed', 'sent')
    stub.model.push(model.tools(['request_item', { item: 'water', category: 'drink' }], ['call_nurse', { reason: 'talk', priority: 'routine' }]))
    const r = await turn('Water please, and I want to talk to my nurse', d.onAction)
    assert.equal(r.reply, NOT_DELIVERED_REPLY.other)
    assert.equal(d.actions.length, 1, 'the second request should not be tried')
    assertAllUsed(stub)
  })

  test('an emergency that got through outranks a later request that did not', async () => {
    const d = deliver('sent', 'failed')
    stub.model.push(model.tools(['call_nurse', { reason: 'bathroom', priority: 'urgent' }]))
    const r = await turn("I've fallen and I need the bathroom", d.onAction)
    assert.equal(r.reply, HELP_ON_THE_WAY)
    assert.deepEqual(r.actions.map((a) => [a.type, a.delivery]), [['emergency', 'sent'], ['nurse_call', 'failed']])
    assertAllUsed(stub)
  })

  test('a delivery function that throws counts as not delivered', async () => {
    stub.model.push(model.tools(['request_item', { item: 'pillow', category: 'comfort' }]))
    const r = await turn('Can I have a pillow?', async () => {
      throw new Error('boom')
    })
    assert.equal(r.reply, NOT_DELIVERED_REPLY.other)
    assert.equal(r.actions[0].delivery, 'failed')
    assertAllUsed(stub)
  })
})

describe('end to end through dispatchAction (stubbed simulator)', () => {
  test('emergency rejected with a 4xx: the fallback at once, no retry', async () => {
    setEnv(ONLINE)
    stub.sim.push(sim.status(401))
    const start = Date.now()
    const r = await turn("I can't breathe", dispatchAction) // the real 2 s retry wait, which must not apply
    assert.equal(r.reply, NOT_DELIVERED_REPLY.emergency)
    assert.ok(Date.now() - start < 1_000)
    assert.equal(stub.simRequests.length, 1)
    assert.equal(stub.modelRequests.length, 0)
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('emergency with a transient failure: retried, then the model is told it was sent', async () => {
    setEnv(ONLINE)
    stub.sim.push(sim.networkError(), sim.created())
    stub.model.push(model.say('Help is on the way.'))
    const r = await turn("I can't breathe", (action) => dispatchAction(action, 1))
    assert.equal(r.reply, 'Help is on the way.')
    assert.deepEqual(r.actions.map((a) => a.delivery), ['sent'])
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('lost answer: the retry is answered as a repeat and counts as sent', async () => {
    setEnv(ONLINE)
    stub.sim.push(sim.timeout(), sim.duplicate())
    stub.model.push(model.say('Help is on the way.'))
    const r = await turn('I think I am having a stroke', (action) => dispatchAction(action, 1))
    assert.equal(r.reply, 'Help is on the way.')
    assert.deepEqual(r.actions.map((a) => a.delivery), ['sent'])
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('emergency that fails twice: the emergency fallback', async () => {
    setEnv(ONLINE)
    stub.sim.push(sim.networkError(), sim.status(503))
    const r = await turn("I can't breathe", (action) => dispatchAction(action, 1))
    assert.equal(r.reply, NOT_DELIVERED_REPLY.emergency)
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('delivered request: confirmed', async () => {
    setEnv(ONLINE)
    stub.sim.push(sim.created())
    stub.model.push(model.tools(['request_item', { item: 'a blanket', category: 'comfort' }]), model.say("I've asked for a blanket for you."))
    const r = await turn('Can I get a blanket?', (action) => dispatchAction(action, 1))
    assert.equal(r.reply, "I've asked for a blanket for you.")
    assertAllUsed(stub)
    assertPrivate(stub)
  })

  test('demo/offline device: nothing sent or claimed', async () => {
    setEnv({})
    stub.model.push(model.tools(['request_item', { item: 'a blanket', category: 'comfort' }]))
    const r = await turn('Can I get a blanket?', dispatchAction)
    assert.equal(r.reply, NOT_DELIVERED_REPLY.other)
    assert.deepEqual(r.actions.map((a) => a.delivery), ['offline'])
    assert.equal(stub.simRequests.length, 0)
    assert.ok(stub.logs.some((line) => line.includes('demo/offline device')))
    assertAllUsed(stub)
    assertPrivate(stub)
  })
})
