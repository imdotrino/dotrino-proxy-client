// El escalón del Bluetooth dentro del cliente: el primer mensaje sale por el proxio, por
// detrás se sube, y desde ahí va por Bluetooth sin tocar el proxio. Y la escalera manda:
// WebRTC directo antes que Bluetooth, Bluetooth antes que WebRTC por TURN.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'
import { FakeAir } from './_fake-air.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(5) }
  throw new Error('timeout')
}

/** Dos clientes cuyo «proxio» es una función: lo que uno manda al otro le llega como mensaje. */
async function pair () {
  const air = new FakeAir()
  const mk = (token) => {
    const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: false, autoReconnect: false, bluetooth: air.adapter('dev-' + token) })
    c.token = token
    c._connected = true
    c.viaProxy = []
    c.got = []
    c.on('message', (from, payload, meta) => c.got.push({ from, payload, via: meta?.via }))
    return c
  }
  const a = mk('tok-a'); const b = mk('tok-b')
  const peers = { 'tok-a': a, 'tok-b': b }
  for (const c of [a, b]) {
    const deliver = (to, message) => {
      const other = peers[to]
      setTimeout(() => other._handleFrame(JSON.stringify({ type: 'message', from: c.token, message })), 1)
    }
    c._sendRaw = (env) => { c.viaProxy.push(env); for (const t of env.to) deliver(t, env.message) }
    c._proxySendOne = (to, payload) => deliver(to, JSON.stringify(payload))
  }
  await a._prepareBluetooth(); await b._prepareBluetooth()
  return { a, b }
}

test('primero por el proxio, después por Bluetooth', async () => {
  const { a, b } = await pair()
  assert.equal(a.bluetoothAvailable, true)
  a.send('tok-b', { n: 1 })
  assert.equal(a.viaProxy.length, 1)
  await until(() => a._ble.isOpen('tok-b') && b._ble.isOpen('tok-a'))
  a.send('tok-b', { n: 2 })
  b.send('tok-a', { back: true })
  await until(() => b.got.length === 2 && a.got.length === 1)
  assert.equal(a.viaProxy.length, 1, 'el segundo ya no tocó el proxio')
  assert.deepEqual(b.got.map((m) => [m.payload.n, m.via]), [[1, 'proxy'], [2, 'bluetooth']])
  assert.equal(a.got[0].via, 'bluetooth')
  assert.equal(await a.routeTo('tok-b'), 'bluetooth')
  const s = await a.stats()
  assert.equal(s.bluetooth, true)
  assert.equal(s.peers.find((p) => p.token === 'tok-b').route, 'bluetooth')
  a.close(); b.close()
})

test('la escalera: WebRTC directo > Bluetooth > WebRTC por TURN', async () => {
  const { a, b } = await pair()
  a.send('tok-b', { n: 1 })
  await until(() => a._ble.isOpen('tok-b'))
  let route = 'direct'
  const rtcSent = []
  a._rtc = {
    peers: new Map([['tok-b', { get route () { return route } }]]),
    isOpen: () => true,
    trySend: (t, w) => { rtcSent.push(w); return true },
    closeAll () {}, closePeer () {},
  }
  a.send('tok-b', { via: 'rtc-direct' })
  assert.equal(rtcSent.length, 1, 'WebRTC directo va antes')
  route = 'turn'
  a.send('tok-b', { via: 'ble' })
  assert.equal(rtcSent.length, 1, 'con TURN, el Bluetooth va antes')
  await until(() => b.got.some((m) => m.payload.via === 'ble' && m.via === 'bluetooth'))
  a._rtc = null
  a.close(); b.close()
})

test('sin la opción, no hay Bluetooth y la señalización no sube a la app', async () => {
  const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: false, autoReconnect: false })
  assert.equal(c.bluetoothAvailable, false)
  assert.throws(() => c.announceBluetooth('pair', 'x'), { code: 'no-bluetooth' })
  await assert.rejects(c.discoverBluetooth({ kind: 'pair' }), { code: 'no-bluetooth' })
})

// Cerrar mientras el Bluetooth arranca: el stop() de close() no ve un adaptador que todavía no
// está, y antes quedaba encendido (y en Node, con el bus de sistema abierto, el proceso no
// terminaba: las pruebas de la bóveda se colgaron horas en CI).
test('cerrar mientras arranca el Bluetooth lo apaga al terminar de arrancar', async () => {
  const air = new FakeAir()
  const adapter = air.adapter('dev-slow')
  const start = adapter.start.bind(adapter)
  let stopped = 0
  adapter.start = async (s) => { await sleep(30); return start(s) }
  const stop = adapter.stop?.bind(adapter)
  adapter.stop = async () => { stopped++; return stop?.() }
  const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: false, autoReconnect: false, bluetooth: adapter })
  const p = c._prepareBluetooth()
  c.close()
  await p
  assert.equal(c.bluetoothAvailable, false, 'no queda encendido')
  assert.equal(stopped, 1, 'y el adaptador se apagó')
})
