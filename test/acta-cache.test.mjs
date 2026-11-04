/**
 * LAS ÚLTIMAS ACTAS DE UNA CUENTA EN EL PROXIO (websocket-proxy ≥ 1.10.0): getActas / putActa.
 */
import './_env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

test('getActas pide las más nuevas que sinceSeq y devuelve la lista', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  const sent = []
  c._request = (msg) => { sent.push(msg); return Promise.resolve({ type: 'acta-get', actas: [{ seq: 9 }] }) }
  assert.deepEqual(await c.getActas('P', { sinceSeq: 7 }), [{ seq: 9 }])
  assert.deepEqual(sent[0], { type: 'acta-get', profileId: 'P', sinceSeq: 7 })
  c._request = () => Promise.resolve({ type: 'acta-get' })
  assert.deepEqual(await c.getActas('P'), [])
})

test('putActa dice si la guardó', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  c._request = (msg) => Promise.resolve({ type: 'acta-put', stored: msg.acta.seq === 2 })
  assert.deepEqual(await c.putActa({ seq: 2 }), { stored: true })
  assert.deepEqual(await c.putActa({ seq: 1 }), { stored: false })
  await assert.rejects(c.putActa(null), (e) => e.code === 'bad-input')
})

test('un proxio que anuncia caps sin acta-cache: se dice con su código', async () => {
  const c = new WebSocketProxyClient({ autoReconnect: false })
  c._request = () => { throw new Error('no debería preguntar') }
  c.caps = ['encpub']
  await assert.rejects(c.getActas('P'), (e) => e.code === 'no-acta-cache')
  await assert.rejects(c.putActa({ seq: 1 }), (e) => e.code === 'no-acta-cache')
})
