// `send` y `sendToOrQueue` trocean lo que la app ya cifró por su cuenta (0.49.0), pero SOLO
// hacia quien dijo `parts` al saludar; lo de detrás espera su turno; y lo que llega en claro
// en partes se rearma. Las apps nativas no dicen `parts`: a ellas les llega entero, como antes.
import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient, PROXY_PART_CHARS } from '../src/index.js'

function client () {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false })
  c.sent = []
  c._sendRaw = (frame) => { c.sent.push(frame) }
  c.ws = { readyState: 1 }
  c.token = 'MIO'
  c.myPublickey = 'PK-MIO'
  return c
}
/** El otro saluda diciendo lo que entiende. */
const greet = (c, speaks) => c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO', speaks }) }))
const toOtro = (c) => c.sent.filter((f) => Array.isArray(f.to) && f.to.includes('OTRO')).map((f) => JSON.parse(f.message)).filter((m) => m.t !== '__cc_hello__')
const big = () => ({ type: 'scene', blob: 'x'.repeat(PROXY_PART_CHARS * 2 + 10) })
const settle = () => new Promise((r) => setTimeout(r, 200))

test('a quien no dijo parts le llega entero, como antes', async () => {
  const c = client()
  greet(c, ['binary'])
  c.send('OTRO', big())
  await settle()
  const got = toOtro(c)
  assert.equal(got.length, 1)
  assert.equal(got[0].type, 'scene')
})

test('a quien dijo parts, uno grande va en partes, y lo de detrás llega después', async () => {
  const c = client()
  greet(c, ['binary', 'parts'])
  c.send('OTRO', big())
  c.send('OTRO', { type: 'patch', n: 1 })
  await settle()
  const got = toOtro(c)
  assert.equal(got.length, 4, 'tres partes y el pequeño')
  assert.ok(got.slice(0, 3).every((m) => m.__dotrino_part))
  assert.deepEqual(got[3], { type: 'patch', n: 1 })
})

test('sendToOrQueue también trocea a quien dijo parts', async () => {
  const c = client()
  greet(c, ['parts'])
  c.sendToOrQueue('OTRO', big(), { peerPubkey: 'PK-OTRO' })
  await settle()
  assert.equal(toOtro(c).length, 3)
})

test('lo que llega en claro en partes se rearma y sale una sola vez, entero', async () => {
  const a = client()
  greet(a, ['parts'])
  const msg = big()
  a.send('OTRO', msg)
  await settle()
  const b = client()
  const seen = []
  b.on('message', (from, payload) => seen.push(payload))
  for (const p of toOtro(a)) b._handleFrame(JSON.stringify({ type: 'message', from: 'A', message: JSON.stringify(p) }))
  await settle()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], msg)
})

test('un canal directo que no vacía su búfer no cuelga: se cierra y se dice que no salió', async () => {
  const { WebRTCManager } = await import('../src/webrtc.js')
  const m = Object.create(WebRTCManager.prototype)
  const closed = []
  m.peers = new Map([['T', { dc: { readyState: 'open', bufferedAmount: 10_000_000, send () {} }, pc: { connectionState: 'connected' } }]])
  m.closePeer = (t) => { closed.push(t); m.peers.delete(t) }
  const t0 = Date.now()
  const ok = await m.sendDirect('T', 'x', 1024, 200)
  assert.equal(ok, false)
  assert.deepEqual(closed, ['T'])
  assert.ok(Date.now() - t0 < 2000)
})
