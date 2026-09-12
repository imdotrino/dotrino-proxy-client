import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { setSealingPrimitives, makeEncKeypair } from '../src/sealing.js'

setSealingPrimitives(await import('@dotrino/identity/content'))

/** Un cliente con el cable pinchado: lo enviado queda a mano y el "servidor" es el test. */
function cliente (opts = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c.enviados = []
  c._sendRaw = (frame) => { c.enviados.push(frame) }
  c.ws = { readyState: 1 }
  c.token = opts.token || 'MIO'
  return c
}

/** Lo que el cliente mandó al token `to`, ya parseado. */
function dirigidos (c, to) {
  return c.enviados
    .filter((f) => Array.isArray(f.to) && f.to.includes(to))
    .map((f) => JSON.parse(f.message))
}

test('sin saludo no se sella por token: para y lo dice con su code', async () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  await assert.rejects(
    () => c.sendSealedTo('DEL-OTRO', { texto: 'hola' }),
    (e) => e.code === 'no-peer-identity')
  assert.equal(c.enviados.length, 0, 'no salió nada al cable')
})

test('el saludo dice quién soy y no lleva nada más', () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c.helloTo('OTRO')
  const [saludo] = dirigidos(c, 'OTRO')
  assert.deepEqual(saludo, { t: '__cc_hello__', publickey: 'PK-MIA' })
})

test('saludar sin identificarse no sale: un saludo sin identidad no dice nada', () => {
  const c = cliente({ requireSealed: true })
  assert.throws(() => c.helloTo('OTRO'), (e) => e.code === 'not-identified')
})

test('el saludo que llega se apunta, se contesta UNA vez y avisa a la app', () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const vistos = []
  c.on('peer_identity', (token, pk) => vistos.push([token, pk]))

  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO')
  assert.deepEqual(vistos, [['OTRO', 'PK-OTRO']])
  assert.equal(dirigidos(c, 'OTRO').length, 1, 'contestó el saludo')

  // Repetirlo no vuelve a contestar: el saludo no rebota para siempre.
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(dirigidos(c, 'OTRO').length, 1)
})

test('el saludo NO sube a la app: `requireSealed` no lo ve y no lo llama texto en claro', () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const mensajes = []
  const errores = []
  c.on('message', (...a) => mensajes.push(a))
  c.on('error', (e) => errores.push(e))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.deepEqual(mensajes, [])
  assert.deepEqual(errores, [])
})

test('un token no cambia de dueño: el segundo saludo con otra identidad se descarta', () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  const errores = []
  c.on('error', (e) => errores.push(e))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-IMPOSTOR' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO', 'manda el primero')
  assert.equal(errores.at(-1)?.code, 'hello-conflict')
})

test('con el saludo hecho, sellar por token ya no necesita que la app diga nada', async () => {
  const suya = await makeEncKeypair()
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  c._encPubs.set('PK-OTRO', suya.encPub)   // como si ya se hubiera preguntado al proxio

  await c.sendSealedTo('OTRO', { texto: 'esto es del usuario' })
  const salidos = dirigidos(c, 'OTRO')
  const sobre = salidos.at(-1)
  assert.ok(sobre.sealed, 'salió sellado')
  assert.ok(!JSON.stringify(sobre).includes('esto es del usuario'), 'el contenido viajó legible')
})

test('quien se va se olvida: su token deja de valer para sellar', () => {
  const c = cliente({ requireSealed: true })
  c.myPublickey = 'PK-MIA'
  c._handleFrame(JSON.stringify({ type: 'message', from: 'OTRO', message: JSON.stringify({ t: '__cc_hello__', publickey: 'PK-OTRO' }) }))
  assert.equal(c.pubkeyOfToken('OTRO'), 'PK-OTRO')
  c._handleFrame(JSON.stringify({ type: 'disconnected', token: 'OTRO' }))
  assert.equal(c.pubkeyOfToken('OTRO'), null)
})
