/**
 * EL CANAL DIRECTO SE ABRE PIDA QUIEN LO PIDA.
 *
 * El canal lo crea siempre el del token MAYOR (así no hay ofertas cruzadas). Hasta 0.38.3,
 * si quien quería ir directo era el del token MENOR, no creaba nada, `onnegotiationneeded`
 * no saltaba y el otro nunca se enteraba: el canal no se abría jamás. Media `smoke:direct`
 * fallaba así, según cómo cayera el sorteo de tokens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebRTCManager, setPeerConnection } from '../src/webrtc.js'

/** Un RTCPeerConnection de mentira: lo justo para que oferta, respuesta y canal circulen. */
class FakePC {
  constructor () {
    this.signalingState = 'stable'
    this.localDescription = null
    this.remoteDescription = null
    this.dc = null
  }

  createDataChannel () {
    this.dc = new FakeDC()
    queueMicrotask(() => this.onnegotiationneeded?.())
    return this.dc
  }

  async setLocalDescription () {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer'
    this.localDescription = { type, sdp: type, pc: this }
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'
  }

  async setRemoteDescription (d) {
    this.remoteDescription = d
    if (d.type === 'offer') {
      this.signalingState = 'have-remote-offer'
      const dc = new FakeDC()
      d.pc.dc.peer = dc
      dc.peer = d.pc.dc
      queueMicrotask(() => this.ondatachannel?.({ channel: dc }))
    } else {
      this.signalingState = 'stable'
      queueMicrotask(() => { this.connectionState = 'connected'; d.pc.connectionState = 'connected'; this.dc.open(); this.dc.peer.open() })
    }
  }

  async addIceCandidate () {}
  close () {}
}

class FakeDC {
  constructor () { this.readyState = 'connecting' }
  open () { this.readyState = 'open'; this.onopen?.() }
  send () {}
  close () {}
}

function pair (tokA, tokB) {
  const mgr = {}
  const make = (self, other) => new WebRTCManager({
    getSelfToken: () => self,
    // La señalización «por el proxio»: entrega asíncrona al otro gestor.
    signalSend: (to, payload) => setImmediate(() => mgr[to].handleIncoming(self, payload)),
    deliverMessage: () => {},
    emit: (ev, e) => { if (ev === 'error') throw e.error }
  })
  mgr[tokA] = make(tokA, tokB)
  mgr[tokB] = make(tokB, tokA)
  return mgr
}

const until = async (cond) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setImmediate(r))
}

test('lo pide el del token MAYOR: crea el canal y se abre', async () => {
  setPeerConnection(FakePC)
  const m = pair('b-mayor', 'a-menor')
  m['b-mayor'].trySend('a-menor', '{}')
  await until(() => m['b-mayor'].isOpen('a-menor'))
  assert.ok(m['b-mayor'].isOpen('a-menor'))
  assert.ok(m['a-menor'].isOpen('b-mayor'))
})

test('lo pide el del token MENOR: le pide al otro que lo cree, y se abre igual', async () => {
  setPeerConnection(FakePC)
  const m = pair('b-mayor', 'a-menor')
  m['a-menor'].trySend('b-mayor', '{}')
  await until(() => m['a-menor'].isOpen('b-mayor'))
  assert.ok(m['a-menor'].isOpen('b-mayor'), 'antes de 0.38.4 esto se quedaba en el proxio para siempre')
  assert.ok(m['b-mayor'].isOpen('a-menor'))
})

test('si los dos lo piden a la vez, sale un solo canal y no rebota nada', async () => {
  setPeerConnection(FakePC)
  const m = pair('b-mayor', 'a-menor')
  let signals = 0
  for (const t of ['a-menor', 'b-mayor']) {
    const send = m[t].signalSend
    m[t].signalSend = (to, p) => { signals++; send(to, p) }
  }
  m['a-menor'].trySend('b-mayor', '{}')
  m['b-mayor'].trySend('a-menor', '{}')
  await until(() => m['a-menor'].isOpen('b-mayor') && m['b-mayor'].isOpen('a-menor'))
  assert.ok(m['a-menor'].isOpen('b-mayor'))
  assert.ok(m['b-mayor'].isOpen('a-menor'))
  assert.equal(signals, 3, 'start + oferta + respuesta: nada más')
})
