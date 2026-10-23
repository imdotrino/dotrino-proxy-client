// El escalón del Bluetooth (docs/bluetooth.md) sobre un aire falso: cable, negociación,
// canal en las dos direcciones, ofertas cruzadas, anunciar y descubrir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as W from '../src/ble/wire.js'
import { BluetoothManager } from '../src/ble/manager.js'
import { FakeAir } from './_fake-air.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await sleep(5) }
  throw new Error('timeout')
}

/** Dos (o más) gestores que se señalizan entre sí como lo haría el proxio. */
function net (air, tokens) {
  const nodes = new Map()
  for (const token of tokens) {
    const inbox = []
    const m = new BluetoothManager({
      getSelfToken: () => token,
      signalSend: (to, payload) => setTimeout(() => nodes.get(to)?.m.handleIncoming(token, JSON.parse(JSON.stringify(payload))), 1),
      deliverMessage: (from, parsed, meta) => inbox.push({ from, parsed, meta }),
      emit: (...a) => process.env.DBG && console.log(token, ...a),
    })
    nodes.set(token, { m, inbox, adapter: air.adapter('dev-' + token) })
  }
  return nodes
}

test('wire: trozos y registros hacen el viaje de vuelta', async () => {
  const rec = crypto.getRandomValues(new Uint8Array(1000))
  const r = new W.Reassembler()
  let out = null
  for (const c of W.toChunks(rec, 20)) out = r.push(c) ?? out
  assert.deepEqual(out, rec)
  assert.equal(W.toChunks(new Uint8Array(0), 20).length, 1)

  // Con etiqueta (tx): cada trozo la lleva y el rearmado la salta.
  const tag = W.tagOf(W.randomBid())
  const rt = new W.Reassembler(W.TAG_BYTES)
  let out2 = null
  for (const c of W.toChunks(rec, 20, tag)) { assert.ok(c.length <= 20 && W.hasTag(c, tag)); out2 = rt.push(c) ?? out2 }
  assert.deepEqual(out2, rec)

  const a = await W.makeEphemeral()
  const b = await W.makeEphemeral()
  const ka = await W.deriveKey(a.privateKey, b.epub, 'tok-a', 'tok-b')
  const kb = await W.deriveKey(b.privateKey, a.epub, 'tok-b', 'tok-a')
  const sealed = await W.sealRecord(ka, W.DIR_TO_CENTRAL, 7, W.TYPE_TEXT, W.encodeText('hola'))
  const opened = await W.openRecord(kb, W.DIR_TO_CENTRAL, 7, sealed)
  assert.equal(opened.type, W.TYPE_TEXT)
  assert.equal(W.decodeText(opened.body), 'hola')
  await assert.rejects(W.openRecord(kb, W.DIR_TO_CENTRAL, 8, sealed))
  await assert.rejects(W.openRecord(kb, W.DIR_TO_PERIPHERAL, 7, sealed))
})

test('wire: hello y beacon', () => {
  assert.equal(W.decodeHello(W.encodeHello('abc')), 'abc')
  assert.equal(W.decodeHello(new TextEncoder().encode('{"v":2,"bid":"x"}')), null)
  assert.deepEqual(W.decodeBeacon(W.encodeBeacon('pair', 'cAAA')), { kind: 'pair', data: 'cAAA' })
  assert.equal(W.decodeBeacon(new Uint8Array(0)), null)
  assert.throws(() => W.encodeBeacon('pair', 'x'.repeat(600)), { code: 'beacon-too-big' })
})

test('el canal se abre y lleva mensajes en las dos direcciones', async () => {
  const air = new FakeAir({ mtu: 23 })
  const n = net(air, ['tok-b', 'tok-a'])
  for (const { m, adapter } of n.values()) await m.start(adapter)
  const A = n.get('tok-a'); const B = n.get('tok-b')
  A.m.upgrade('tok-b')
  await until(() => A.m.isOpen('tok-b') && B.m.isOpen('tok-a'))

  assert.equal(A.m.trySend('tok-b', JSON.stringify({ hola: 1 })), true)
  const big = 'x'.repeat(5000)
  assert.equal(await B.m.sendDirect('tok-a', JSON.stringify({ big })), true)
  const bytes = crypto.getRandomValues(new Uint8Array(3000))
  assert.equal(B.m.trySend('tok-a', bytes), true)

  await until(() => B.inbox.length === 1 && A.inbox.length === 2)
  assert.deepEqual(B.inbox[0].parsed, { hola: 1 })
  assert.equal(B.inbox[0].meta.via, 'bluetooth')
  assert.equal(A.inbox[0].parsed.big, big)
  assert.deepEqual(A.inbox[1].parsed, bytes)
  assert.equal(A.m.describe().get('tok-b'), 'bluetooth')

  await A.m.stop(); await B.m.stop()
})

test('dos centrales en un periférico que notifica a todos (BlueZ): cada uno lee solo lo suyo', async () => {
  const air = new FakeAir({ broadcast: true })
  const n = net(air, ['tok-a', 'tok-b', 'tok-c'])
  for (const { m, adapter } of n.values()) await m.start(adapter)
  const A = n.get('tok-a')
  A.m.upgrade('tok-b'); A.m.upgrade('tok-c')
  await until(() => A.m.isOpen('tok-b') && A.m.isOpen('tok-c') && n.get('tok-b').m.isOpen('tok-a') && n.get('tok-c').m.isOpen('tok-a'))
  for (let i = 0; i < 5; i++) { A.m.trySend('tok-b', JSON.stringify({ to: 'b', i, pad: 'b'.repeat(200) })); A.m.trySend('tok-c', JSON.stringify({ to: 'c', i })) }
  await until(() => n.get('tok-b').inbox.length === 5 && n.get('tok-c').inbox.length === 5)
  assert.ok(n.get('tok-b').inbox.every((m) => m.parsed.to === 'b'))
  assert.ok(n.get('tok-c').inbox.every((m) => m.parsed.to === 'c'))
  assert.ok(A.m.isOpen('tok-b') && A.m.isOpen('tok-c'), 'ningún canal se cerró por trozos ajenos')
  for (const { m } of n.values()) await m.stop()
})

test('ofertas cruzadas: los dos suben a la vez y el canal sale igual', async () => {
  const air = new FakeAir()
  const n = net(air, ['tok-1', 'tok-2'])
  for (const { m, adapter } of n.values()) await m.start(adapter)
  n.get('tok-1').m.upgrade('tok-2')
  n.get('tok-2').m.upgrade('tok-1')
  await until(() => n.get('tok-1').m.isOpen('tok-2') && n.get('tok-2').m.isOpen('tok-1'))
  for (const { m } of n.values()) await m.stop()
})

test('al cerrarse, el canal deja de usarse en las dos puntas', async () => {
  const air = new FakeAir()
  const n = net(air, ['tok-x', 'tok-y'])
  const events = []
  for (const { m, adapter } of n.values()) { m.emit = (e, t) => events.push(e); await m.start(adapter) }
  n.get('tok-x').m.upgrade('tok-y')
  await until(() => n.get('tok-x').m.isOpen('tok-y') && n.get('tok-y').m.isOpen('tok-x'))
  n.get('tok-x').m.closePeer('tok-y')
  await until(() => !n.get('tok-y').m.isOpen('tok-x'))
  assert.equal(n.get('tok-x').m.trySend('tok-y', '{}'), false)
  assert.equal(events.filter((e) => e === 'bluetooth_close').length, 2)
  for (const { m } of n.values()) await m.stop()
})

test('quien no se negoció no abre canal ni recibe nada', async () => {
  const air = new FakeAir()
  const n = net(air, ['tok-p'])
  const P = n.get('tok-p')
  await P.m.start(P.adapter)
  const intruder = air.adapter('intruder')
  await intruder.start({ hello: () => new Uint8Array(0), beacon: () => new Uint8Array(0), onWrite () {}, onDisconnect () {} })
  const link = await intruder.connect({ id: 'dev-tok-p' })
  let got = 0
  await link.subscribe(() => got++)
  await link.write(Uint8Array.of(1, 9, 9, 9))
  await sleep(30)
  assert.equal(got, 0)
  assert.equal(P.m.peers.size, 0)
  await P.m.stop()
})

test('anunciar y descubrir, sin proxio', async () => {
  const air = new FakeAir()
  const n = net(air, ['tok-v', 'tok-d', 'tok-o'])
  for (const { m, adapter } of n.values()) await m.start(adapter)
  const stop = n.get('tok-v').m.announce('pair', 'cINVITE')
  n.get('tok-o').m.announce('contact', 'card')
  const seen = []
  const found = await n.get('tok-d').m.discover({ kind: 'pair', timeoutMs: 100, onFound: (b) => seen.push(b) })
  assert.deepEqual(found, [{ kind: 'pair', data: 'cINVITE' }])
  assert.deepEqual(seen, found)
  stop()
  assert.deepEqual(await n.get('tok-d').m.discover({ kind: 'pair', timeoutMs: 100 }), [])
  for (const { m } of n.values()) await m.stop()
})

test('dos búsquedas seguidas: la segunda espera a que la primera acabe de parar (BlueZ, InProgress)', async () => {
  const air = new FakeAir({ slowStop: 30 })
  const n = net(air, ['tok-v', 'tok-d'])
  for (const { m, adapter } of n.values()) await m.start(adapter)
  n.get('tok-v').m.announce('contact', 'card')
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await n.get('tok-d').m.discover({ kind: 'contact', timeoutMs: 60 }), [{ kind: 'contact', data: 'card' }])
  }
  for (const { m } of n.values()) await m.stop()
})

test('sin Bluetooth: anunciar lo dice, subir no hace nada', async () => {
  const m = new BluetoothManager({ getSelfToken: () => 't', signalSend: () => { throw new Error('no') }, deliverMessage () {}, emit () {} })
  assert.throws(() => m.announce('pair', 'x'), { code: 'no-bluetooth' })
  await assert.rejects(m.discover({ kind: 'pair' }), { code: 'no-bluetooth' })
  m.upgrade('otro')
  assert.equal(m.handleIncoming('otro', { t: W.BLE_TAG, kind: 'offer', bid: 'b', epub: 'e' }), true)
  assert.equal(m.handleIncoming('otro', { t: 'otra-cosa' }), false)
})

test('tarjeta de contacto: el fragmento #to= del messenger, ida y vuelta', () => {
  const publickey = '{"crv":"P-256","ext":true,"key_ops":["verify"],"kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}'
  const data = W.encodeContact({ publickey, nickname: 'Ana María & co' })
  assert.match(data, /^to=[A-Za-z0-9_-]+&nick=Ana%20Mar%C3%ADa%20%26%20co$/)
  assert.deepEqual(W.decodeContact(data), { publickey, nickname: 'Ana María & co' })
  assert.deepEqual(W.decodeContact(W.encodeContact({ publickey })), { publickey, nickname: '' })
  assert.equal(W.decodeContact(W.encodeContact({ publickey, nickname: 'x'.repeat(60) })).nickname.length, 40)
  // Cabe en el beacon con cualquier apodo: el recorte es también por bytes.
  for (const n of ['中'.repeat(40), '😀'.repeat(40), 'ñ'.repeat(40)]) {
    const nick = W.decodeContact(W.encodeContact({ publickey, nickname: n })).nickname
    assert.ok(new TextEncoder().encode(nick).length <= 60 && nick.length <= 40 && n.startsWith(nick))
    W.encodeBeacon(W.KIND_CONTACT, W.encodeContact({ publickey, nickname: n }))
  }
  assert.equal(W.trimNick('😀'.repeat(30)), '😀'.repeat(15)) // sin partir un emoji
  assert.equal(W.decodeContact('to=bm9wZQ'), null) // no es un JWK
  assert.equal(W.decodeContact('nick=a'), null)
  assert.throws(() => W.encodeContact({ publickey: '' }), (e) => e.code === 'bad-contact')
})
