/**
 * CERRAR NO DEJA NADA ABIERTO, AUNQUE SE ESTÉ NEGOCIANDO.
 *
 * En Node, `setLocalDescription` reúne los candidatos y abre un socket UDP por dirección. Si
 * `close()` llega en medio, werift cierra los sockets que ya tenía y los que terminan de abrirse
 * después se quedan vivos: el proceso no sale. Así se colgaron una hora las pruebas de la
 * bóveda en CI (0.186.0 y 0.186.1). Y una señal que llega después de `closeAll()` no puede
 * abrir otra conexión, que ya nadie cerraría.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebRTCManager, setPeerConnection } from '../src/webrtc.js'

const sockets = { open: 0, leaked: 0 }
let created = 0

/** Como werift: el socket se abre AL FINAL de la descripción, y `close()` solo cierra los que hay. */
class SlowPC {
  constructor () { created++; this.signalingState = 'stable'; this.closed = false; this.socks = 0 }
  createDataChannel () {
    queueMicrotask(() => this.onnegotiationneeded?.())
    return { readyState: 'connecting', close () {} }
  }

  async setLocalDescription () {
    await new Promise((resolve) => setTimeout(resolve, 30))
    sockets.open++
    if (this.closed) sockets.leaked++
    else this.socks++
    this.localDescription = { type: 'offer', sdp: 'x' }
  }

  async setRemoteDescription (d) { this.remoteDescription = d }
  async addIceCandidate () {}
  close () { this.closed = true; sockets.open -= this.socks; this.socks = 0 }
}

const manager = (self) => new WebRTCManager({
  getSelfToken: () => self,
  signalSend: () => {},
  deliverMessage: () => {},
  emit: (ev, e) => { if (ev === 'error') throw e.error }
})

test('cerrar a mitad de la descripción cierra la conexión al terminar: ningún socket queda vivo', async () => {
  setPeerConnection(SlowPC)
  sockets.open = 0; sockets.leaked = 0
  const m = manager('b-mayor')
  m.trySend('a-menor', '{}')           // el del token mayor crea el canal y negocia
  await new Promise((resolve) => setTimeout(resolve, 5))
  m.closeAll()                          // en medio del setLocalDescription
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sockets.leaked, 0, 'nada se abrió sobre una conexión ya cerrada')
  assert.equal(sockets.open, 0, 'y lo que se abrió, se cerró')
})

test('cerrado, una señal que llega tarde no abre otra conexión; reabierto, sí', async () => {
  setPeerConnection(SlowPC)
  const m = manager('b-mayor')
  m.closeAll()
  created = 0
  assert.equal(m.handleIncoming('a-menor', { t: '__cc_rtc__', kind: 'start' }), true, 'la señal se consume')
  assert.equal(m.trySend('a-menor', '{}'), false)
  assert.equal(created, 0, 'ninguna conexión nueva')
  assert.equal(m.peers.size, 0)
  m.reopen()
  m.trySend('a-menor', '{}')
  assert.equal(created, 1, 'tras reabrir se negocia otra vez')
  m.closeAll()
  await new Promise((resolve) => setTimeout(resolve, 60))
})
