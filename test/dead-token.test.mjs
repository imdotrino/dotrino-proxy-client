import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair } from '../src/sealing.js'

setSealingPrimitives(await import('@dotrino/identity/content'))

// UN TOKEN MUERTO NO SE TRAGA EL MENSAJE: la otra punta reinició la app, su token ya no
// existe, y el proxio lo dice en `message_sent.failed`. El mismo sobre sale por su pubkey.
function client () {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, requireSealed: true })
  c.sent = []
  c._sendRaw = (frame) => { c.sent.push(frame) }
  c.ws = { readyState: 1 }
  c.token = 'MIO'
  c.myPublickey = 'PK-MIA'
  return c
}

test('si el proxio dice que el token no existe, el mismo sobre va a la cola por pubkey', async () => {
  const c = client()
  const other = await makeEncKeypair()
  const gone = []
  c.on('token_gone', (t, pk) => gone.push([t, pk]))

  await c.sendSealedTo('VIEJO', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-OTRO', peerEncPub: other.encPub })
  const [byToken] = c.sent
  assert.deepEqual(byToken.to, ['VIEJO'])
  assert.ok(byToken.id, 'lleva id para casar la respuesta')

  c._handleFrame(JSON.stringify({ type: 'message_sent', id: byToken.id, sent: 0, total: 1, failed: ['VIEJO'] }))
  const byPubkey = c.sent[1]
  assert.deepEqual(byPubkey.to_publickey, ['PK-OTRO'])
  assert.equal(byPubkey.message, byToken.message, 'el mismo sobre, sin volver a sellar')
  assert.deepEqual(gone, [['VIEJO', 'PK-OTRO']])
})

test('si el token vive, el proxio no contesta y no sale nada más', async () => {
  const c = client()
  const other = await makeEncKeypair()
  await c.sendSealedTo('VIVO', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-OTRO', peerEncPub: other.encPub })
  // Una respuesta de OTRO envío no dispara nada.
  c._handleFrame(JSON.stringify({ type: 'message_sent', id: 'msg_999', failed: ['VIVO'] }))
  assert.equal(c.sent.length, 1)
})

// Lo que la app ya cifró por su cuenta (un canal de sesión propio) usa la misma red.
test('sendToOrQueue: por token, y a la cola por pubkey si el token murió', () => {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false })
  c.sent = []
  c._sendRaw = (frame) => { c.sent.push(frame) }
  c.ws = { readyState: 1 }
  c.token = 'MIO'
  const gone = []
  c.on('token_gone', (t, pk) => gone.push([t, pk]))

  c.sendToOrQueue('VIEJO', { type: 'ra.data', env: 'x' }, { peerPubkey: 'PK-OTRO' })
  const [byToken] = c.sent
  assert.deepEqual(byToken.to, ['VIEJO'])
  c._handleFrame(JSON.stringify({ type: 'message_sent', id: byToken.id, failed: ['VIEJO'] }))
  assert.deepEqual(c.sent[1].to_publickey, ['PK-OTRO'])
  assert.equal(c.sent[1].message, byToken.message)
  assert.deepEqual(gone, [['VIEJO', 'PK-OTRO']])
})

test('sendToOrQueue: sin saber de quién es el token no manda, y con requireSealed se niega', () => {
  const c = client()
  assert.throws(() => c.sendToOrQueue('T', { a: 1 }, {}), (e) => e.code === 'no-peer-identity')
  assert.throws(() => c.sendToOrQueue('T', { a: 1 }, { peerPubkey: 'PK' }), (e) => e.code === 'unsealed')
  assert.equal(c.sent.length, 0)
})
