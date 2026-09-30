import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair } from '../src/sealing.js'

setSealingPrimitives(await import('@dotrino/identity/content'))

// UN TOKEN MUERTO NO SE TRAGA EL MENSAJE: la otra punta reinició la app, su token ya no
// existe, y el proxio lo dice en `message_sent.failed`. El mismo sobre sale por su pubkey.
function cliente () {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, requireSealed: true })
  c.enviados = []
  c._sendRaw = (frame) => { c.enviados.push(frame) }
  c.ws = { readyState: 1 }
  c.token = 'MIO'
  c.myPublickey = 'PK-MIA'
  return c
}

test('si el proxio dice que el token no existe, el mismo sobre va a la cola por pubkey', async () => {
  const c = cliente()
  const otro = await makeEncKeypair()
  const gone = []
  c.on('token_gone', (t, pk) => gone.push([t, pk]))

  await c.sendSealedTo('VIEJO', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-OTRO', peerEncPub: otro.encPub })
  const [porToken] = c.enviados
  assert.deepEqual(porToken.to, ['VIEJO'])
  assert.ok(porToken.id, 'lleva id para casar la respuesta')

  c._handleFrame(JSON.stringify({ type: 'message_sent', id: porToken.id, sent: 0, total: 1, failed: ['VIEJO'] }))
  const porPubkey = c.enviados[1]
  assert.deepEqual(porPubkey.to_publickey, ['PK-OTRO'])
  assert.equal(porPubkey.message, porToken.message, 'el mismo sobre, sin volver a sellar')
  assert.deepEqual(gone, [['VIEJO', 'PK-OTRO']])
})

test('si el token vive, el proxio no contesta y no sale nada más', async () => {
  const c = cliente()
  const otro = await makeEncKeypair()
  await c.sendSealedTo('VIVO', { type: 'DM', text: 'hola' }, { peerPubkey: 'PK-OTRO', peerEncPub: otro.encPub })
  // Una respuesta de OTRO envío no dispara nada.
  c._handleFrame(JSON.stringify({ type: 'message_sent', id: 'msg_999', failed: ['VIVO'] }))
  assert.equal(c.enviados.length, 1)
})
