// El proxio contesta 429 al pedir el relevo (tope diario, cuota, consumo sin leer): se sigue
// por el proxio, se dice, y se vuelve a pedir cuando el proxio dice que se puede.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'
import { DEFAULT_ICE_SERVERS } from '../src/webrtc.js'

function client (answers) {
  const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: true, autoReconnect: false })
  const set = []
  c._rtc.setIceServers = (l) => { set.push(l) }
  let n = 0
  c.getTurnCredentials = async () => {
    const a = answers[Math.min(n++, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  }
  return { c, set, calls: () => n }
}
const err429 = (code, retryAfterMs) => Object.assign(new Error('not now'), { code, status: 429, retryAfterMs })
const ok = { enabled: true, iceServers: [{ urls: 'turn:198.51.100.4:3478', username: 'u', credential: 'c' }], expiresAt: Date.now() + 600000 }

test('a 429 is not an error: TURN off, the old relay removed, and it says why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { c, set } = client([err429('turn-daily-cap', 3600000)])
  const seen = []
  c.on('turn_unavailable', (e) => seen.push(e))
  assert.equal(await c.enableTurn({ publicKey: 'pk', sign: async () => 'sig' }), false)
  assert.deepEqual(set.at(-1), DEFAULT_ICE_SERVERS)
  assert.deepEqual(seen, [{ code: 'turn-daily-cap', retryAfterMs: 3600000 }])
  const st = await c.stats()
  assert.equal(st.turn.active, false)
  assert.equal(st.turn.code, 'turn-daily-cap')
  clearTimeout(c._turnTimer)
})

test('it asks again when the proxy says it can, and comes back on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { c, calls } = client([err429('turn-daily-cap', 120000), ok])
  await c.enableTurn({ publicKey: 'pk', sign: async () => 'sig' })
  t.mock.timers.tick(119000)
  assert.equal(calls(), 1)
  t.mock.timers.tick(1000)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(calls(), 2)
  assert.equal((await c.stats()).turn.active, true)
  clearTimeout(c._turnTimer)
})

test('never asks again sooner than a minute, whatever the proxy says', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { c, calls } = client([err429('turn-usage-unknown', 1000), ok])
  await c.enableTurn({ publicKey: 'pk', sign: async () => 'sig' })
  t.mock.timers.tick(59000)
  assert.equal(calls(), 1)
  clearTimeout(c._turnTimer)
})

test('any other error still throws', async () => {
  const { c } = client([Object.assign(new Error('bad signature'), { code: 'bad-signature' })])
  await assert.rejects(c.enableTurn({ publicKey: 'pk', sign: async () => 'sig' }), /bad signature/)
})

test('the proxy error keeps its status and retry_after_ms', async () => {
  const c = new WebSocketProxyClient({ url: 'ws://x', autoReconnect: false })
  const p = new Promise((resolve, reject) => c._pending.set('r1', { resolve, reject, timer: null }))
  c._rejectPending({ id: 'r1', type: 'error', status: 429, code: 'turn-daily-cap', error: 'x', retry_after_ms: 5000 })
  await assert.rejects(p, (e) => e.status === 429 && e.code === 'turn-daily-cap' && e.retryAfterMs === 5000)
})
