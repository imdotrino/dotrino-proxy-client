/**
 * QUÉ APP ES CADA CONEXIÓN (websocket-proxy ≥ 1.4.0). En un teléfono varias apps comparten la
 * llave del perfil; sin decir cuál es, el proxio timbraba a la última suscrita (messenger
 * sonaba con los pedidos de la bóveda) y la primera en conectarse se llevaba la cola de todas.
 */
import './_env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

function client (opts = {}) {
  const c = new WebSocketProxyClient({ autoReconnect: false, ...opts })
  const requests = []
  const raw = []
  c.token = 'TOK'
  c._request = (msg) => { requests.push(msg); return Promise.resolve({ type: 'ok' }) }
  c._sendRaw = (msg) => { raw.push(msg) }
  return { c, requests, raw }
}

test('al identificarse dice qué app es', async () => {
  const { c, requests } = client({ app: 'messenger' })
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  assert.equal(requests[0].app, 'messenger')
})

test('sin app, el identify va como siempre', async () => {
  const { c, requests } = client()
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  assert.equal('app' in requests[0], false)
})

test('la suscripción al timbre lleva la app DENTRO de lo firmado', async () => {
  const { c, requests } = client({ app: 'vault' })
  let signed = null
  await c.registerPushToken({ publicKey: 'PK', sign: async (d) => { signed = d; return 'f' }, token: 'tok-fcm' })
  assert.equal(signed.app, 'vault')
  assert.equal(requests[0].data.app, 'vault')
})

test('el emisor marca a qué app va el mensaje', () => {
  const { c, raw } = client()
  c.sendByPubkey('PEER', { hello: 1 }, { app: 'messenger' })
  assert.equal(raw[0].app, 'messenger')
  c.sendByPubkey('PEER', { hello: 2 })
  assert.equal('app' in raw[1], false, 'sin app: a todas, como antes')
})

test('un nombre de app mal escrito LANZA: el timbre no sonaría nunca y no se vería', () => {
  assert.throws(() => new WebSocketProxyClient({ app: 'Messenger App' }), (e) => e.code === 'bad-app')
  const { c } = client()
  assert.throws(() => c.sendByPubkey('PEER', {}, { app: '../x' }), (e) => e.code === 'bad-app')
})

test('el singleton: la app que llega por updateConfig se aplica, y otra distinta lanza', () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  c.updateConfig({ app: 'messenger' })
  assert.equal(c.app, 'messenger')
  c.updateConfig({ app: 'messenger' })
  assert.throws(() => c.updateConfig({ app: 'vault' }), (e) => e.code === 'app-conflict')
})
