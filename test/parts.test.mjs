import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair } from '../src/sealing.js'
import { PART_TAG, PROXY_PART_CHARS, QUEUE_MAX_CHARS, DIRECT_PART_CHARS } from '../src/parts.js'
import { WebRTCManager } from '../src/webrtc.js'

setSealingPrimitives(await import('@dotrino/identity/content'))

// MENSAJES GRANDES, EN PARTES. Con los dos conectados no hay tope; lo que se queda esperando
// en el proxio es como mucho 8 MB de archivo (regla del dueño, 2026-10-15).

async function par () {
  const keyB = await makeEncKeypair()
  const a = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, requireSealed: true })
  a.sent = []
  a._sendRaw = (frame) => { a.sent.push(frame) }
  a.ws = { readyState: 1 }
  a.token = 'A'
  a.myPublickey = 'PK-A'
  const b = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, requireSealed: true, myEncPrivateKey: keyB.privateKey })
  b.ws = { readyState: 1 }
  b.token = 'B'
  const received = []
  const errores = []
  b.on('message', (from, payload, meta) => received.push({ from, payload, meta }))
  b.on('error', (e) => errores.push(e))
  // Lo que A mandó, tal como el proxio se lo entrega a B.
  // Abrir cada parte es asíncrono: se espera a que llegue algo (o a que se rinda), no un
  // tiempo fijo, que en CI se queda corto.
  const deliver = async (frames) => {
    const antes = received.length + errores.length
    for (const f of frames) b._handleFrame(JSON.stringify({ type: 'message', from: 'A', from_publickey: 'PK-A', message: f.message }))
    const end = Date.now() + 15000
    while (received.length + errores.length === antes && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 50)) // por si llegara algo más (no debe)
  }
  return { a, b, keyB, received, errores, deliver }
}

const big = (chars) => ({ type: 'DM', image: { mime: 'image/jpeg', data: 'x'.repeat(chars) } })

test('un mensaje pequeño sale como siempre: una trama, sin partes', async () => {
  const { a, keyB, received, deliver } = await par()
  await a.sendSealedTo('B', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.equal(a.sent.length, 1)
  await deliver(a.sent)
  assert.equal(received.length, 1)
  assert.equal(received[0].payload.text, 'hola')
  assert.equal(received[0].meta.parts, undefined)
})

test('por token, uno grande sale en partes selladas y llega entero, una sola vez', async () => {
  const { a, keyB, received, errores, deliver } = await par()
  const msg = big(QUEUE_MAX_CHARS + 100) // más de lo que podría esperar en el proxio
  await a.sendSealedTo('B', msg, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.ok(a.sent.length > 1, 'salió en varias tramas')
  for (const f of a.sent) {
    assert.deepEqual(f.to, ['B'])
    assert.ok(!f.message.includes(PART_TAG), 'el proxio no ve que es una parte: va sellada')
    assert.ok(f.message.length < 1024 * 1024, 'cada parte cabe en la trama del proxio')
  }
  // Desordenadas: la cola y el canal directo pueden entregar en otro orden.
  await deliver([...a.sent].reverse())
  assert.deepEqual(errores, [])
  assert.equal(received.length, 1)
  assert.equal(received[0].payload.image.data, msg.image.data)
  assert.equal(received[0].meta.parts, a.sent.length)
})

test('por pubkey (puede quedarse esperando) se parte hasta el tope y no pasa de él', async () => {
  const { a, keyB, received, deliver } = await par()
  const msg = big(PROXY_PART_CHARS * 2)
  await a.sendSealed(['PK-B'], msg, { peerEncPub: keyB.encPub })
  assert.equal(a.sent.length, 3)
  for (const f of a.sent) assert.deepEqual(f.to_publickey, ['PK-B'])
  await deliver(a.sent)
  assert.equal(received[0].payload.image.data, msg.image.data)

  a.sent = []
  await assert.rejects(
    a.sendSealed(['PK-B'], big(QUEUE_MAX_CHARS + 1), { peerEncPub: keyB.encPub }),
    (e) => e.code === 'too-big-for-queue')
  assert.equal(a.sent.length, 0, 'no se deja nada a medias en el proxio')
})

test('si el token muere a mitad de uno que no cabe en la cola, no se deja en el proxio', async () => {
  const { a, keyB } = await par()
  const errores = []
  a.on('error', (e) => errores.push(e))
  await a.sendSealedTo('B', big(QUEUE_MAX_CHARS + 100), { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  const n = a.sent.length
  a._handleFrame(JSON.stringify({ type: 'message_sent', id: a.sent[0].id, failed: ['B'] }))
  assert.equal(a.sent.length, n, 'nada salió por pubkey')
  assert.equal(errores[0]?.code, 'too-big-for-queue')
})

test('si el token muere a mitad de uno que sí cabe en la cola, esa parte va por pubkey', async () => {
  const { a, keyB } = await par()
  await a.sendSealedTo('B', big(PROXY_PART_CHARS * 2), { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  const n = a.sent.length
  a._handleFrame(JSON.stringify({ type: 'message_sent', id: a.sent[0].id, failed: ['B'] }))
  assert.equal(a.sent.length, n + 1)
  assert.deepEqual(a.sent[n].to_publickey, ['PK-B'])
})

test('una parte con forma mala se dice, no desaparece', async () => {
  const { b, keyB, errores } = await par()
  const { seal } = await import('../src/sealing.js')
  const bad = await seal({ [PART_TAG]: { id: 'x', i: 5, n: 2 }, d: 'zz' }, keyB.encPub)
  b._handleFrame(JSON.stringify({ type: 'message', from: 'A', message: JSON.stringify(bad) }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(errores[0]?.code, 'bad-part')
})

test('el canal directo espera a que su búfer baje antes de mandar la siguiente parte', async () => {
  const m = new WebRTCManager({ getSelfToken: () => 'A', signalSend: () => {}, deliverMessage: () => {}, emit: () => {} })
  const dc = { readyState: 'open', bufferedAmount: 5 * 1024 * 1024, sent: [], send (s) { this.sent.push(s) } }
  m.peers.set('B', { remote: 'B', dc, pc: { connectionState: 'connected' } })
  const p = m.sendDirect('B', 'parte')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(dc.sent.length, 0, 'con el búfer lleno, espera')
  dc.bufferedAmount = 0
  assert.equal(await p, true)
  assert.deepEqual(dc.sent, ['parte'])
  dc.readyState = 'closed'
  assert.equal(await m.sendDirect('B', 'otra'), false)
  assert.ok(DIRECT_PART_CHARS < 64 * 1024)
})

test('por el proxio en vivo hay tope (25 MB de archivo): más que eso pide canal directo', async () => {
  const { RELAY_MAX_CHARS } = await import('../src/parts.js')
  const { a, keyB } = await par()
  await assert.rejects(
    a.sendSealedTo('B', big(RELAY_MAX_CHARS + 1), { peerPubkey: 'PK-B', peerEncPub: keyB.encPub }),
    (e) => e.code === 'too-big-for-relay')
  assert.equal(a.sent.length, 0, 'no salió ninguna parte')
})

test('routeTo dice por dónde va: proxio, canal directo o sin conexión', async () => {
  const { a } = await par()
  a._connected = true
  assert.equal(await a.routeTo(null), 'offline')
  assert.equal(await a.routeTo('B'), 'proxy')
  a._rtc = { isOpen: (t) => t === 'B', peers: new Map([['B', {}]]), probeRoute: async () => 'turn' }
  assert.equal(await a.routeTo('B'), 'turn')
  a._connected = false
  assert.equal(await a.routeTo('B'), 'offline')
})
