import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair } from '../src/sealing.js'

setSealingPrimitives(await import('@dotrino/identity/content'))

/** Un cliente con el cable pinchado: lo enviado queda a mano y el "servidor" es el test. */
function client (opts = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c.sent = []
  c._sendRaw = (frame) => { c.sent.push(frame) }
  c.ws = { readyState: 1 }
  c.token = opts.token || 'MIO'
  return c
}

/** Lo que el cliente mandó al token `to`, ya parseado. */
function directed (c, to) {
  return c.sent
    .filter((f) => Array.isArray(f.to) && f.to.includes(to))
    .map((f) => JSON.parse(f.message))
}

test('sin saludo no se sella por token: para y lo dice con su code', async () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  await assert.rejects(
    () => c.sendSealedTo('DEL-OTRO', { text: 'hola' }),
    (e) => e.code === 'no-peer-identity')
  assert.equal(c.sent.length, 0, 'no salió nada al cable')
})

test('el saludo dice quién soy y qué entiendo, y nada más', () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c.helloTo('OTRO')
  const [greeting] = directed(c, 'OTRO')
  assert.deepEqual(greeting, { t: '__cc_hello__', publickey: 'PK-MIA', speaks: ['binary'] })
})

test('saludar sin identificarse no sale: un saludo sin identidad no dice nada', () => {
  const c = client({ requireSealed: true })
  assert.throws(() => c.helloTo('OTRO'), (e) => e.code === 'not-identified')
})

test('el saludo que llega se apunta, se contesta UNA vez y avisa a la app', () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const seen = []
  c.on('peer_identity', (token, pk) => seen.push([token, pk]))

  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO')
  assert.deepEqual(seen, [['OTRO', 'PK-OTRO']])
  assert.equal(directed(c, 'OTRO').length, 1, 'contestó el saludo')

  // Repetirlo no vuelve a contestar: el saludo no rebota para siempre.
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(directed(c, 'OTRO').length, 1)
})

test('el saludo NO sube a la app: `requireSealed` no lo ve y no lo llama texto en claro', () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const messages = []
  const errores = []
  c.on('message', (...a) => messages.push(a))
  c.on('error', (e) => errores.push(e))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.deepEqual(messages, [])
  assert.deepEqual(errores, [])
})

test('un token no cambia de dueño: el segundo saludo con otra identidad se descarta', () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const errores = []
  c.on('error', (e) => errores.push(e))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-IMPOSTOR' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO', 'manda el primero')
  assert.equal(errores.at(-1)?.code, 'hello-conflict')
})

test('con el saludo hecho, sellar por token ya no necesita que la app diga nada', async () => {
  const theirKey = await makeEncKeypair()
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  c._encPubs.set('PK-OTRO', theirKey.encPub)   // como si ya se hubiera preguntado al proxio

  await c.sendSealedTo('OTRO', { text: 'esto es del usuario' })
  const outgoing = directed(c, 'OTRO')
  const envelope = outgoing.at(-1)
  assert.ok(envelope.sealed, 'salió sellado')
  assert.ok(!JSON.stringify(envelope).includes('esto es del usuario'), 'el contenido viajó legible')
})

test('quien se va se olvida: su token deja de valer para sellar', () => {
  const c = client({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO')
  c._handleFrame(JSON.stringify({ type: 'disconnected', token: 'OTRO' }))
  assert.equal(c.pubkeyOfToken('OTRO'), null)
})
