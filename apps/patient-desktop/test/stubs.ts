// Test doubles for the patient app tests: a fetch stub that plays both the vitals simulator
// (POST /patient-requests) and the chat model (POST /api/chat), plus console capture.
// No ports, no network, no Python: runs anywhere Node can run TypeScript (22.18+).
import assert from 'node:assert/strict'

/** Something the patient said. It may go in the local-only log line, never anywhere else. */
export const PATIENT_WORDS = 'my name is Jane Doe and I live at 12 Elm Street'
export const TOKEN = 'test-token-3f9a1c'
export const ONLINE = { SIM_URL: 'http://sim.test', PATIENT_REQUEST_TOKEN: TOKEN }

// Fields a request body may have (server/sim/patient_requests.py rejects anything else).
const BODY_FIELDS = new Set(['patientId', 'type', 'category', 'source', 'priority', 'item'])

export type SimRequest = { url: string; method: string; headers: Record<string, string>; body: string; at: number }
type Answer = () => Response | Promise<Response>
type ToolCall = { function: { name: string; arguments: Record<string, unknown> } }
type ModelMessage = { role: 'assistant'; content: string; tool_calls?: ToolCall[] }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** How the fake simulator answers one POST. */
export const sim = {
  created: (): Answer => () => json(201, { ok: true }),
  duplicate: (): Answer => () => json(200, { ok: true, duplicate: true }),
  status: (status: number): Answer => () => json(status, { error: `test error ${status}` }),
  page: (status: number, statusText: string): Answer => () => new Response('<html>error</html>', { status, statusText }),
  reason: (reason: string): Answer => () => json(201, { ok: true, reason }),
  networkError: (): Answer => () => {
    throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8765') })
  },
  timeout: (): Answer => () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  },
}

/** What the fake chat model answers next. */
export const model = {
  say: (content: string): ModelMessage => ({ role: 'assistant', content }),
  tools: (...calls: [string, Record<string, unknown>][]): ModelMessage => ({
    role: 'assistant',
    content: '',
    tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })),
  }),
}

export type Stub = {
  /** Answers the simulator and the model give, in order. */
  sim: Answer[]
  model: ModelMessage[]
  simRequests: SimRequest[]
  modelRequests: { messages: { role: string; content: string }[] }[]
  /** Every console line (multi-line messages split). */
  logs: string[]
  /** Calls no answer was queued for: a test bug, or a request the code shouldn't have made. */
  unexpected: string[]
  restore(): void
}

const ENV_KEYS = ['SIM_URL', 'PATIENT_REQUEST_TOKEN'] as const

/** Set exactly these delivery settings (anything not given is unset). */
export function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

/** Replace fetch and console; restore() puts them (and the delivery settings) back. */
export function install(): Stub {
  const realFetch = globalThis.fetch
  const realConsole = { log: console.log, error: console.error, warn: console.warn }
  const realEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const stub: Stub = {
    sim: [],
    model: [],
    simRequests: [],
    modelRequests: [],
    logs: [],
    unexpected: [],
    restore() {
      globalThis.fetch = realFetch
      Object.assign(console, realConsole)
      setEnv(realEnv)
    },
  }
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    if (new URL(url).pathname === '/api/chat') {
      stub.modelRequests.push(JSON.parse(body))
      const message = stub.model.shift()
      if (!message) {
        stub.unexpected.push(`model call to ${url}`)
        throw new Error('no model reply queued')
      }
      return json(200, { message })
    }
    const headers = { ...(init?.headers as Record<string, string> | undefined) }
    stub.simRequests.push({ url, method: init?.method ?? 'GET', headers, body, at: Date.now() })
    const answer = stub.sim.shift()
    if (!answer) {
      stub.unexpected.push(`simulator call to ${url}`)
      throw new Error('no simulator answer queued')
    }
    return answer()
  }
  for (const level of ['log', 'error', 'warn'] as const) {
    console[level] = (...args: unknown[]) => {
      stub.logs.push(...args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ').split('\n'))
    }
  }
  return stub
}

/** Every queued answer was used, and nothing else was called. */
export function assertAllUsed(stub: Stub) {
  assert.deepEqual(stub.unexpected, [], 'calls nothing was queued for')
  assert.equal(stub.sim.length, 0, 'simulator answers left over: fewer POSTs than expected')
  assert.equal(stub.model.length, 0, 'model replies left over: the model was asked fewer times than expected')
}

/**
 * The patient's words never leave the device (and are only logged in the local-only line), request
 * bodies hold only the allowed fields, and the token is never logged.
 */
export function assertPrivate(stub: Stub) {
  for (const request of stub.simRequests) {
    const sent = JSON.stringify(request)
    assert.ok(!sent.includes('Jane') && !sent.includes('Elm Street'), `patient text sent: ${sent}`)
    const extra = Object.keys(JSON.parse(request.body)).filter((key) => !BODY_FIELDS.has(key))
    assert.deepEqual(extra, [], 'fields the simulator would reject')
  }
  for (const line of stub.logs) {
    assert.ok(!line.includes(TOKEN), `token logged: ${line}`)
    if (line.includes('Jane') || line.includes('Elm Street')) {
      assert.ok(line.startsWith('local only, never sent: '), `patient text logged outside the local-only line: ${line}`)
    }
  }
}
