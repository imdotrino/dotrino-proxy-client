/**
 * UN CANAL «ABIERTO» SOBRE UNA CONEXIÓN CAÍDA NO ES UN CAMINO.
 *
 * Cuando la red de debajo se corta (pantalla apagada, cambio de wifi, la pestaña congelada en
 * Android), el canal sigue en `open` hasta que ICE da la conexión por muerta, decenas de
 * segundos después. Hasta 0.45.0 se seguía mandando por ahí y lo mandado se perdía sin subir
 * al TURN ni al proxio.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebRTCManager, usable, setPeerConnection } from '../src/webrtc.js'

const manager = (events) => new WebRTCManager({
  getSelfToken: () => 'A', signalSend: () => {}, deliverMessage: () => {},
  emit: (ev, ...args) => events.push([ev, ...args])
})

const openPeer = (m, state) => {
  const dc = { readyState: 'open', bufferedAmount: 0, sent: [], send (s) { this.sent.push(s) }, close () { this.readyState = 'closed'; this.onclose?.() } }
  const pc = { connectionState: state }
  const peer = m._ensurePeer('B')
  peer.pc = pc
  peer.negotiating = true
  m._attachDC(peer, dc)
  return { peer, dc, pc }
}

test('con la conexión disconnected el canal no se usa: trySend da false y el mensaje va por el proxio', async () => {
  const m = manager([])
  const { dc } = openPeer(m, 'disconnected')
  assert.equal(m.isOpen('B'), false)
  assert.equal(m.trySend('B', 'hola'), false)
  assert.equal(await m.sendDirect('B', 'hola'), false)
  assert.deepEqual(dc.sent, [])
})

test('con la conexión connected el canal sí se usa', () => {
  const m = manager([])
  const { dc, peer } = openPeer(m, 'connected')
  assert.equal(usable(peer), true)
  assert.equal(m.trySend('B', 'hola'), true)
  assert.deepEqual(dc.sent, ['hola'])
})

test('cada cambio de la conexión se anuncia: disconnected cierra el camino, connected lo devuelve, failed lo cierra del todo', () => {
  class FakePC { constructor () { this.connectionState = 'new' } close () {} }
  setPeerConnection(FakePC)
  const events = []
  const m = manager(events)
  const peer = m._ensurePeer('B')
  const pc = m._createPC(peer)
  const dc = { readyState: 'open', send () {}, close () { this.readyState = 'closed'; this.onclose?.() } }
  m._attachDC(peer, dc)
  pc.connectionState = 'connected'
  dc.onopen()
  assert.equal(m.isOpen('B'), true)
  events.length = 0

  pc.connectionState = 'disconnected'; pc.onconnectionstatechange()
  assert.equal(m.isOpen('B'), false)
  assert.deepEqual(events.map((e) => e[0]), ['webrtc_close'])

  pc.connectionState = 'connected'; pc.onconnectionstatechange()
  assert.equal(m.isOpen('B'), true)
  assert.deepEqual(events.map((e) => e[0]), ['webrtc_close', 'webrtc_open'])

  pc.connectionState = 'failed'; pc.onconnectionstatechange()
  assert.equal(dc.readyState, 'closed')
  assert.equal(m.isOpen('B'), false)
  assert.equal(peer.failed, true)
  assert.deepEqual(events.map((e) => e[0]), ['webrtc_close', 'webrtc_open', 'webrtc_close'])
  setPeerConnection(null)
})
