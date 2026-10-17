/**
 * DESPIÉRTAME AQUÍ (websocket-proxy ≥ 1.7.0): una bóveda que no vive conectada registra una
 * URL; si llega algo para su cuenta y no hay nadie conectado, el proxio la llama.
 */
import './_entorno.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

test('registerWake firma la URL y manda el acta que prueba de quién es la llave', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  const pedidos = []
  c._request = (msg) => { pedidos.push(msg); return Promise.resolve({ type: 'push-subscribed', publickey: 'PERFIL' }) }
  let firmado = null
  const acta = { profileId: 'PERFIL', members: [] }
  const r = await c.registerWake({ publicKey: 'COMM', sign: async (d) => { firmado = d; return 'f' }, url: 'https://x.example/wake?k=1', acta })
  assert.deepEqual(JSON.parse(firmado.subscription), { kind: 'wake', url: 'https://x.example/wake?k=1' })
  assert.equal(firmado.publickey, 'COMM')
  assert.equal(pedidos[0].acta, acta, 'el acta va en el frame, fuera de lo firmado')
  assert.equal(r.profile, 'PERFIL')
})

test('sin acta no se registra: no habría cómo saber de qué cuenta es el timbre', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  await assert.rejects(c.registerWake({ publicKey: 'COMM', sign: async () => 'f', url: 'https://x' }), (e) => e.code === 'bad-args')
})

test('list() dice que la bóveda se está despertando', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  c._request = () => Promise.resolve({ type: 'channel_list', tokens: [], waking: true })
  const t = await c.list('dotrino-vault-AB12-CD34-EF56')
  assert.deepEqual([...t], [])
  assert.equal(t.waking, true)
})

test('registerWake con canal lo manda dentro de lo firmado', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  c._request = () => Promise.resolve({ type: 'push-subscribed', publickey: 'P' })
  let firmado = null
  await c.registerWake({ publicKey: 'C', sign: async (d) => { firmado = d; return 'f' }, url: 'https://x', acta: {}, channel: 'dotrino-vault-AB12-CD34-EF56' })
  assert.equal(JSON.parse(firmado.subscription).channel, 'dotrino-vault-AB12-CD34-EF56')
})
