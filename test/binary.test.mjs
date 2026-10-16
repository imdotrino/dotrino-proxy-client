import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair, identitySealing } from '../src/sealing.js'
import { pack, unpack, hasBinary, encodeFrame, decodeFrame } from '../src/binpack.js'
import { QUEUE_MAX_BYTES, PROXY_PART_BYTES, DIRECT_PART_BYTES } from '../src/parts.js'
import { WebRTCManager } from '../src/webrtc.js'
import { fakeVault } from './_fake-vault.mjs'

setSealingPrimitives(await import('@dotrino/identity/content'))

// BYTES QUE VIAJAN COMO BYTES (0.35.0): un archivo ocupaba 1,78 veces su tamaño en el cable
// (base64 en el JSON y otra vez base64 al sellar). Con Uint8Array en el mensaje, ~1,0.

const fileBytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 2654435761) >>> 24
  return b
}

async function pairOfClients ({ caps = ['binary'], sealingA = null, sealingB = null } = {}) {
  const keyB = await makeEncKeypair()
  const a = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, requireSealed: true, sealing: sealingA })
  a.sent = []
  a._sendRaw = function (frame) {
    if (frame.message instanceof Uint8Array) this._needBinaryProxy()
    this.sent.push(frame)
  }
  a.ws = { readyState: 1 }
  a.token = 'A'
  a.myPublickey = 'PK-A'
  a.caps = caps
  const b = new WebSocketProxyClient({
    url: 'wss://x', enableWebRTC: false, requireSealed: true,
    ...(sealingB ? { sealing: sealingB } : { myEncPrivateKey: keyB.privateKey })
  })
  b.ws = { readyState: 1 }
  b.token = 'B'
  const received = []
  const errors = []
  b.on('message', (from, payload, meta) => received.push({ from, payload, meta }))
  b.on('error', (e) => errors.push(e))
  // Lo que A mandó, tal como el proxio se lo entrega a B: la misma trama binaria.
  const deliver = async (frames) => {
    const before = received.length + errors.length
    for (const f of frames) {
      const header = { type: 'message', from: 'A', from_publickey: 'PK-A' }
      b._handleFrame(f.message instanceof Uint8Array ? encodeFrame(header, f.message).buffer : JSON.stringify({ ...header, message: f.message }))
    }
    const deadline = Date.now() + 15000
    while (received.length + errors.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 50))
  }
  return { a, b, keyB, received, errors, deliver }
}

test('pack/unpack: bytes come back as bytes at any depth, a Buffer too', () => {
  const obj = { t: 'DM', file: { name: 'a.pdf', data: fileBytes(1000) }, more: [Buffer.from('hola'), 3], none: null }
  assert.equal(hasBinary(obj), true)
  assert.equal(hasBinary({ a: [1, { b: 'x' }] }), false)
  const p = pack(obj)
  assert.ok(p.byteLength < 1000 + 200, 'the pack is the bytes plus a little')
  const back = unpack(p)
  assert.deepEqual(back.file.data, obj.file.data)
  assert.equal(new TextDecoder().decode(back.more[0]), 'hola')
  assert.equal(back.more[1], 3)
  assert.equal(back.none, null)
  assert.throws(() => unpack(new Uint8Array([1, 2, 3, 4, 5])), (e) => e.code === 'bad-pack')
  const broken = pack({ d: fileBytes(10) })
  assert.throws(() => unpack(broken.subarray(0, broken.length - 5)), (e) => e.code === 'bad-pack')
})

test('a binary frame carries the usual header and the raw body', () => {
  const body = fileBytes(300)
  const { header, body: back } = decodeFrame(encodeFrame({ to: ['B'], id: 'm1' }, body))
  assert.deepEqual(header, { to: ['B'], id: 'm1' })
  assert.deepEqual(back, body)
  assert.throws(() => decodeFrame(new Uint8Array([9, 0, 0, 0, 0])), (e) => e.code === 'bad-frame')
})

test('a message without bytes also goes binary (0.37.0: everything does)', async () => {
  const { a, keyB, received, deliver } = await pairOfClients()
  await a.sendSealedTo('B', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.ok(a.sent[0].message instanceof Uint8Array)
  await deliver(a.sent)
  assert.equal(received[0].payload.text, 'hola')
})

test('a file goes in ONE sealed binary frame of its own size and arrives as bytes', async () => {
  const { a, keyB, received, errors, deliver } = await pairOfClients()
  const data = fileBytes(300 * 1024)
  await a.sendSealedTo('B', { type: 'DM', file: { name: 'foto.jpg', mime: 'image/jpeg', data } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.equal(a.sent.length, 1)
  const body = a.sent[0].message
  assert.ok(body instanceof Uint8Array)
  assert.ok(body.byteLength < data.byteLength + 2048, `${body.byteLength} bytes on the wire for a ${data.byteLength}-byte file`)
  // El proxio no ve el archivo: va cifrado.
  assert.equal(Buffer.from(body).indexOf(Buffer.from(data.subarray(0, 64))), -1)
  await deliver(a.sent)
  assert.deepEqual(errors, [])
  assert.equal(received.length, 1)
  assert.ok(received[0].payload.file.data instanceof Uint8Array)
  assert.deepEqual(received[0].payload.file.data, data)
  assert.equal(received[0].payload.file.name, 'foto.jpg')
  assert.equal(received[0].meta.sealed, true)
})

test('a big one goes in binary parts that fit the frame, and arrives whole out of order', async () => {
  const { a, keyB, received, errors, deliver } = await pairOfClients()
  const data = fileBytes(PROXY_PART_BYTES * 3 + 1234)
  await a.sendSealedTo('B', { type: 'DM', file: { data } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.equal(a.sent.length, 4)
  let total = 0
  for (const f of a.sent) {
    assert.ok(f.message instanceof Uint8Array)
    const frame = encodeFrame({ to: f.to, id: f.id }, f.message)
    assert.ok(frame.byteLength < 1024 * 1024, 'fits the 1 MB proxy frame')
    total += frame.byteLength
  }
  assert.ok(total / data.byteLength < 1.01, `${(total / data.byteLength).toFixed(3)}x the file on the wire`)
  await deliver([...a.sent].reverse())
  assert.deepEqual(errors, [])
  assert.equal(received.length, 1)
  assert.deepEqual(received[0].payload.file.data, data)
  assert.equal(received[0].meta.parts, 4)
})

test('by pubkey: the queue cap is measured in file bytes (8 MB), not base64', async () => {
  const { a, keyB, received, deliver } = await pairOfClients()
  const data = fileBytes(2 * 1024 * 1024)
  await a.sendSealed(['PK-B'], { type: 'DM', file: { data } }, { peerEncPub: keyB.encPub })
  for (const f of a.sent) assert.deepEqual(f.to_publickey, ['PK-B'])
  await deliver(a.sent)
  assert.deepEqual(received[0].payload.file.data, data)

  a.sent = []
  await assert.rejects(
    a.sendSealed(['PK-B'], { file: { data: new Uint8Array(QUEUE_MAX_BYTES + 1) } }, { peerEncPub: keyB.encPub }),
    (e) => e.code === 'too-big-for-queue')
  assert.equal(a.sent.length, 0)
})

test('a proxy without binary frames is reported before anything is sent', async () => {
  const { a, keyB } = await pairOfClients({ caps: ['offline-queue'] })
  await assert.rejects(
    a.sendSealedTo('B', { file: { data: fileBytes(10) } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub }),
    (e) => e.code === 'no-binary-support')
  await assert.rejects(
    a.sendSealed(['PK-B'], { file: { data: fileBytes(10) } }, { peerEncPub: keyB.encPub }),
    (e) => e.code === 'no-binary-support')
  assert.equal(a.sent.length, 0)
})

test('with the browser vault: only the message key goes through it, once per message', async () => {
  const vaultA = await fakeVault()
  const vaultB = await fakeVault()
  let sealCount = 0
  const ia = {
    getEncryptionPubkey: async () => vaultA.encPub,
    encrypt: (r, pt) => { sealCount++; assert.ok(pt.length < 200, 'the vault only sees the key'); return vaultA.encrypt(r, pt) },
    decrypt: async (from, _t, s) => ({ plaintext: await vaultA.open(from, s) })
  }
  let openCount = 0
  const ib = {
    getEncryptionPubkey: async () => vaultB.encPub,
    encrypt: (r, pt) => vaultB.encrypt(r, pt),
    decrypt: async (from, _t, s) => { openCount++; return { plaintext: await vaultB.open(from, s) } }
  }
  const { a, received, errors, deliver } = await pairOfClients({ sealingA: identitySealing(ia), sealingB: identitySealing(ib) })
  const data = fileBytes(PROXY_PART_BYTES * 2 + 10)
  await a.sendSealedTo('B', { file: { data } }, { peerPubkey: 'PK-B', peerEncPub: vaultB.encPub })
  assert.equal(a.sent.length, 3)
  assert.equal(sealCount, 1)
  await deliver(a.sent)
  assert.deepEqual(errors, [])
  assert.deepEqual(received[0].payload.file.data, data)
  assert.equal(openCount, 1, 'the key is opened once for the three parts')
  assert.equal(received[0].meta.senderEncPub, vaultA.encPub)
})

test('a part changed on the way does not open, and it is reported', async () => {
  const { a, keyB, errors, received, deliver } = await pairOfClients()
  await a.sendSealedTo('B', { file: { data: fileBytes(1000) } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  const m = a.sent[0].message
  m[m.length - 3] ^= 1
  await deliver(a.sent)
  assert.equal(received.length, 0)
  assert.equal(errors[0]?.type, 'undecipherable')
})

test('the direct channel carries bytes, and an ArrayBuffer is delivered as bytes', async () => {
  const delivered = []
  const m = new WebRTCManager({ getSelfToken: () => 'A', signalSend: () => {}, deliverMessage: (from, p) => delivered.push(p), emit: () => {} })
  const dc = { readyState: 'open', bufferedAmount: 0, sent: [], send (s) { this.sent.push(s) } }
  const peer = { remote: 'B' }
  m.peers.set('B', peer)
  m._attachDC(peer, dc)
  assert.equal(dc.binaryType, 'arraybuffer')
  const bytes = pack({ d: fileBytes(100) })
  assert.equal(await m.sendDirect('B', bytes), true)
  assert.ok(dc.sent[0] instanceof Uint8Array)
  dc.onmessage({ data: bytes.slice().buffer })
  assert.ok(delivered[0] instanceof Uint8Array)
  assert.deepEqual(unpack(delivered[0]).d, fileBytes(100))
  assert.ok(DIRECT_PART_BYTES + 16 * 1024 <= 64 * 1024)
})

test('the greeting says it understands bytes; to one that did not, bytes are refused before sending', async () => {
  const { a, keyB } = await pairOfClients()
  a._proxySendOne = () => {}
  assert.equal(a.speaks('B'), null, 'without a greeting nobody knows')
  // An older client greets without `speaks`.
  a._onHello('B', { t: '__cc_hello__', publickey: 'PK-B' })
  assert.equal(a.speaks('B'), false)
  assert.equal(a.speaks('PK-B'), false)
  await assert.rejects(
    a.sendSealedTo('B', { file: { data: fileBytes(10) } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub }),
    (e) => e.code === 'peer-no-binary')
  await assert.rejects(
    a.sendSealed(['PK-B'], { file: { data: fileBytes(10) } }, { peerEncPub: keyB.encPub }),
    (e) => e.code === 'peer-no-binary')
  // Nor text: everything goes binary now, so one that does not take it gets nothing — and is told.
  await assert.rejects(
    a.sendSealedTo('B', { text: 'hola' }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub }),
    (e) => e.code === 'peer-no-binary')
  assert.equal(a.sent.length, 0)

  // One that says it does: bytes go.
  a._onHello('C', { t: '__cc_hello__', publickey: 'PK-C', speaks: ['binary'] })
  assert.equal(a.speaks('C'), true)
  await a.sendSealedTo('C', { file: { data: fileBytes(10) } }, { peerPubkey: 'PK-C', peerEncPub: keyB.encPub })
  assert.ok(a.sent.at(-1).message instanceof Uint8Array)

  // B updates: its NEW connection says it does, and that is what counts by token, even though
  // its identity was remembered as not understanding bytes.
  a._onHello('B2', { t: '__cc_hello__', publickey: 'PK-B', speaks: ['binary'] })
  await a.sendSealedTo('B2', { file: { data: fileBytes(10) } }, { peerPubkey: 'PK-B', peerEncPub: keyB.encPub })
  assert.ok(a.sent.at(-1).message instanceof Uint8Array)
  assert.equal(a.speaks('PK-B'), true)
})

test('my own greeting announces binary', () => {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false })
  const out = []
  c._proxySendOne = (to, payload) => out.push(payload)
  c.myPublickey = 'PK-A'
  c.token = 'A'
  c.helloTo('B')
  assert.deepEqual(out[0].speaks, ['binary'])
})
