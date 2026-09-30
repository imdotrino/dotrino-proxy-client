/**
 * QUÉ APP ES CADA CONEXIÓN (websocket-proxy ≥ 1.4.0). En un teléfono varias apps comparten la
 * llave del perfil; sin decir cuál es, el proxio timbraba a la última suscrita (messenger
 * sonaba con los pedidos de la bóveda) y la primera en conectarse se llevaba la cola de todas.
 */
import './_entorno.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

function cliente (opts = {}) {
  const c = new WebSocketProxyClient({ autoReconnect: false, ...opts })
  const pedidos = []
  const crudos = []
  c.token = 'TOK'
  c._request = (msg) => { pedidos.push(msg); return Promise.resolve({ type: 'ok' }) }
  c._sendRaw = (msg) => { crudos.push(msg) }
  return { c, pedidos, crudos }
}

test('al identificarse dice qué app es', async () => {
  const { c, pedidos } = cliente({ app: 'messenger' })
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  assert.equal(pedidos[0].app, 'messenger')
})

test('sin app, el identify va como siempre', async () => {
  const { c, pedidos } = cliente()
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  assert.equal('app' in pedidos[0], false)
})

test('la suscripción al timbre lleva la app DENTRO de lo firmado', async () => {
  const { c, pedidos } = cliente({ app: 'vault' })
  let firmado = null
  await c.registerPushToken({ publicKey: 'PK', sign: async (d) => { firmado = d; return 'f' }, token: 'tok-fcm' })
  assert.equal(firmado.app, 'vault')
  assert.equal(pedidos[0].data.app, 'vault')
})

test('el emisor marca a qué app va el mensaje', () => {
  const { c, crudos } = cliente()
  c.sendByPubkey('PEER', { hola: 1 }, { app: 'messenger' })
  assert.equal(crudos[0].app, 'messenger')
  c.sendByPubkey('PEER', { hola: 2 })
  assert.equal('app' in crudos[1], false, 'sin app: a todas, como antes')
})

test('un nombre de app mal escrito LANZA: el timbre no sonaría nunca y no se vería', () => {
  assert.throws(() => new WebSocketProxyClient({ app: 'Messenger App' }), (e) => e.code === 'bad-app')
  const { c } = cliente()
  assert.throws(() => c.sendByPubkey('PEER', {}, { app: '../x' }), (e) => e.code === 'bad-app')
})
