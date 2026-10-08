/**
 * ESTADÍSTICAS DE RED: cuánto tráfico, con quién y por qué camino.
 *
 * Lo que fija: que el byte que sale por el proxio se cuenta como proxio, el que sale por el
 * canal directo como WebRTC (directo o TURN según ICE), y que el cliente se ve en el
 * registro de la página mientras está vivo — el topbar lo encuentra ahí sin que la app lo
 * cablee.
 */
import { FakeWebSocket } from './_entorno.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient, listTransports, routeOf, logStats } from '../src/index.js'
import { utf8Length } from '../src/stats.js'

const tick = () => new Promise((r) => setImmediate(r))

async function conectado () {
  const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: false, autoReconnect: false, enableHeartbeat: false })
  const p = c.connect()
  await tick()
  FakeWebSocket.ultimo.responde({ type: 'connected', token: 'yo', node: 'n1' })
  await p
  return { c, ws: FakeWebSocket.ultimo }
}

test('utf8Length cuenta bytes, no caracteres', () => {
  assert.equal(utf8Length('abc'), 3)
  assert.equal(utf8Length('ñ'), 2)
  assert.equal(utf8Length('€'), 3)
  assert.equal(utf8Length('😀'), 4)
  assert.equal(utf8Length('😀'), Buffer.byteLength('😀'))
})

test('lo que sale y entra por el proxio se cuenta por conexión, como proxio', async () => {
  const { c, ws } = await conectado()
  c.send('peer-1', { hola: 'ñ' })
  ws.responde({ type: 'message', from: 'peer-1', message: JSON.stringify({ r: 1 }) })
  const s = await c.stats()
  assert.equal(s.connected, true)
  assert.equal(s.node, 'n1')
  const p = s.peers.find((x) => x.token === 'peer-1')
  assert.ok(p)
  assert.equal(p.route, 'proxy')
  assert.equal(p.bytesOut.proxy, utf8Length(JSON.stringify({ hola: 'ñ' })))
  assert.equal(p.bytesIn.proxy, utf8Length(JSON.stringify({ r: 1 })))
  assert.equal(p.msgsOut, 1)
  assert.equal(p.msgsIn, 1)
  assert.ok(s.proxy.bytesOut > p.bytesOut.proxy, 'el frame entero pesa más que el payload')
  assert.equal(s.proxy.framesIn, 2, 'connected + message')
  c.close()
})

test('por pubkey, la conexión se apunta por la llave', async () => {
  const { c } = await conectado()
  c.sendByPubkey(['PK1'], { x: 1 })
  const s = await c.stats()
  const p = s.peers.find((x) => x.pubkey === 'PK1')
  assert.ok(p)
  assert.equal(p.token, null)
  assert.equal(p.bytesOut.proxy, utf8Length(JSON.stringify({ x: 1 })))
  c.close()
})

test('el cliente está en el registro mientras vive, y sale al cerrarlo', async () => {
  const { c } = await conectado()
  assert.ok(listTransports().includes(c))
  c.close()
  assert.ok(!listTransports().includes(c))
})

test('el canal directo cuenta como WebRTC con su ruta (directo o TURN)', async () => {
  const { c } = await conectado()
  c._tokenPubkeys.set('peer-2', 'PK2')
  // Lo que haría WebRTCManager al mandar y recibir por un canal abierto por TURN.
  c._rtc = { describe: async () => new Map([['peer-2', 'turn']]) }
  c._traffic.peer('out', 'turn', { token: 'peer-2' }, 10)
  c._traffic.peer('in', 'turn', { token: 'peer-2' }, 7)
  const s = await c.stats()
  const p = s.peers.find((x) => x.token === 'peer-2')
  assert.equal(p.route, 'turn')
  assert.equal(p.pubkey, 'PK2')
  assert.equal(p.bytesOut.turn, 10)
  assert.equal(p.bytesIn.turn, 7)
  assert.equal(p.bytesOut.proxy, 0)
  c._rtc = null
  c.close()
})

/** Un informe de getStats como el de un navegador (un Map con los objetos por id). */
function informe (local, remote) {
  return new Map([
    ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
    ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true }],
    ['L', { id: 'L', type: 'local-candidate', candidateType: local }],
    ['R', { id: 'R', type: 'remote-candidate', candidateType: remote }]
  ])
}

test('routeOf: relay en cualquier punta es TURN; si no, directo; sin datos, no se adivina', async () => {
  assert.equal(await routeOf({ getStats: async () => informe('host', 'srflx') }), 'direct')
  assert.equal(await routeOf({ getStats: async () => informe('relay', 'host') }), 'turn')
  assert.equal(await routeOf({ getStats: async () => informe('srflx', 'relay') }), 'turn')
  assert.equal(await routeOf({ getStats: async () => new Map() }), null)
  assert.equal(await routeOf({}), null)
})

test('logStats: escribe el camino real, calla si nada cambió y no deja la pubkey en el log', async () => {
  const { c } = await conectado()
  c._tokenPubkeys.set('peer-9', 'PK-SECRETA')
  c._rtc = { describe: async () => new Map([['peer-9', 'direct']]), closeAll () {} }
  c._traffic.peer('out', 'direct', { token: 'peer-9' }, 40)
  c._traffic.peer('in', 'proxy', { token: 'peer-9' }, 5)
  const lines = []
  const net = logStats({ log: (l) => lines.push(l), label: 'svc', everyMs: 3600000 })
  await net.flush()
  assert.equal(lines.length, 2, 'resumen + una conexión')
  assert.match(lines[0], /^\[net\] svc url=ws:\/\/x connected=yes webrtc=on /)
  assert.match(lines[0], /in\.proxy=5 .*out\.direct=40 .*peers=1 routes=direct=1/)
  assert.match(lines[1], /peer=peer-9 route=direct .*msgs\.in=1 msgs\.out=1/)
  assert.ok(!lines.join('\n').includes('PK-SECRETA'))
  await net.flush()
  assert.equal(lines.length, 2, 'sin cambios no se repite')
  c._traffic.peer('out', 'direct', { token: 'peer-9' }, 1)
  await net.stop()
  assert.equal(lines.length, 4, 'al parar escribe lo que cambió')
  assert.match(lines[2], /out\.direct=41/)
  c.close()
})

test('logStats: a quien solo se le mandó un ping no se le cuenta como conexión', async () => {
  const { c } = await conectado()
  c._traffic.peer('out', 'proxy', { pubkey: 'PK-APAGADO-1' }, 37)
  c._traffic.peer('out', 'proxy', { pubkey: 'PK-APAGADO-2' }, 37)
  c._traffic.peer('out', 'proxy', { token: 'peer-vivo' }, 37)
  c._traffic.peer('in', 'proxy', { token: 'peer-vivo' }, 41)
  const lines = []
  const net = logStats({ log: (l) => lines.push(l), everyMs: 3600000 })
  await net.stop()
  assert.equal(lines.length, 2, 'el resumen y UNA conexión: la que contestó')
  assert.match(lines[0], /peers=1 routes=proxy=1 unanswered=2 unanswered\.out=74$/)
  assert.match(lines[1], /peer=peer-vivo /)
  c.close()
})
