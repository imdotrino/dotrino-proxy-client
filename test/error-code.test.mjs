/**
 * EL `code` DEL PROXIO LLEGA A QUIEN LLAMÓ. Se perdía al convertir el frame de error en un
 * `Error`, así que la única forma de distinguir «no hay enlace con el nodo dueño» de
 * «firma inválida» era comparar la frase — que además estaba en español (CONVENCIONES §8.1).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/index.js'

test('una petición rechazada por el proxio trae su `code`', async () => {
  const c = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1', enableWebRTC: false, autoReconnect: false })
  const p = new Promise((resolve, reject) => {
    c._pending.set('req_1', { resolve, reject, timer: setTimeout(() => {}, 0), expectedType: 'published' })
  })
  c._rejectPending({ id: 'req_1', error: 'no link to the channel owner node', code: 'no-owner-link' })
  await assert.rejects(p, (e) => e.code === 'no-owner-link' && /no link/.test(e.message))
})
