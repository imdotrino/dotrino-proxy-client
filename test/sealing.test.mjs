import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { seal, makeEncKeypair, isSealed, setSealingPrimitives } from '../src/sealing.js'

// `@dotrino/identity` es peer dependency: en este repo no está instalada, así que se
// inyectan las primitivas desde la copia del ecosistema. Es exactamente el hueco que
// `setSealingPrimitives` existe para cubrir.
setSealingPrimitives(await import('../../dotrino-identity/vault/content.js'))

function clienteFalso (opts = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c._sendRaw = (msg) => { c._enviado = msg }
  return c
}

test('sellar y abrir: ida y vuelta, y otro no lo abre', async () => {
  const yo = await makeEncKeypair()
  const otro = await makeEncKeypair()
  const sobre = await seal({ op: 'find', url: 'https://banco.com.ec/' }, yo.encPub)

  assert.ok(isSealed(sobre))
  const texto = JSON.stringify(sobre)
  assert.ok(!texto.includes('banco.com.ec'), 'el sitio viajó legible')
  assert.ok(!texto.includes('find'), 'la operación viajó legible')

  const { open } = await import('../src/sealing.js')
  assert.deepEqual(await open(sobre, yo.privateKey), { op: 'find', url: 'https://banco.com.ec/' })
  await assert.rejects(() => open(sobre, otro.privateKey))
})

test('sendSealed manda el sobre; el contenido no va por el cable', async () => {
  const peer = await makeEncKeypair()
  const c = clienteFalso()
  await c.sendSealed(['PEER'], { secreto: 'hunter2' }, { peerEncPub: peer.encPub })

  assert.ok(!JSON.stringify(c._enviado).includes('hunter2'), 'salió en claro')
  assert.ok(isSealed(JSON.parse(c._enviado.message)))
})

test('sendSealed sin la llave del otro lado no manda nada', async () => {
  const c = clienteFalso()
  await assert.rejects(
    () => c.sendSealed(['PEER'], { x: 1 }, {}),
    e => e.code === 'unsealed')
  assert.equal(c._enviado, undefined)
})

test('requireSealed: sendByPubkey en claro LANZA en vez de enviar', async () => {
  const c = clienteFalso({ requireSealed: true })
  assert.throws(() => c.sendByPubkey(['PEER'], { secreto: 'hunter2' }), e => e.code === 'unsealed')
  assert.equal(c._enviado, undefined, 'lo mandó igual')

  // Y con el sobre puesto, sale sin quejarse.
  const peer = await makeEncKeypair()
  await c.sendSealed(['PEER'], { secreto: 'hunter2' }, { peerEncPub: peer.encPub })
  assert.ok(c._enviado)
})

test('requireSealed: lo que llega en claro se descarta y se avisa', async () => {
  const c = clienteFalso({ requireSealed: true })
  const recibidos = []
  const errores = []
  c.on('message', (from, payload) => recibidos.push(payload))
  c.on('error', e => errores.push(e))

  await c._deliver('PEER', { type: 'algo', secreto: 'colado' }, {})

  assert.equal(recibidos.length, 0, 'entregó un mensaje sin cifrar a la app')
  assert.equal(errores[0]?.type, 'unsealed')
  assert.equal(errores[0]?.reason, 'plaintext_rejected')
})

test('lo sellado a mí llega abierto, y marcado como sellado', async () => {
  const yo = await makeEncKeypair()
  const c = clienteFalso({ requireSealed: true, myEncPrivateKey: yo.privateKey })
  const recibidos = []
  c.on('message', (from, payload, meta) => recibidos.push({ payload, meta }))

  await c._deliver('PEER', await seal({ hola: 'mundo' }, yo.encPub), { via: 'proxy' })

  assert.deepEqual(recibidos[0].payload, { hola: 'mundo' })
  assert.equal(recibidos[0].meta.sealed, true)
})

test('lo sellado a OTRO no llega a la app, y no se confunde con un fallo de red', async () => {
  const yo = await makeEncKeypair()
  const otro = await makeEncKeypair()
  const c = clienteFalso({ requireSealed: true, myEncPrivateKey: yo.privateKey })
  const recibidos = []
  const errores = []
  c.on('message', (f, p) => recibidos.push(p))
  c.on('error', e => errores.push(e))

  await c._deliver('PEER', await seal({ x: 1 }, otro.encPub), {})

  assert.equal(recibidos.length, 0)
  assert.equal(errores[0]?.type, 'undecipherable')
})

test('sin requireSealed nada cambia: las apps de hoy siguen funcionando', async () => {
  const c = clienteFalso()
  const recibidos = []
  c.on('message', (f, p, meta) => recibidos.push({ p, meta }))

  c.sendByPubkey(['PEER'], { hola: 1 })
  assert.ok(c._enviado, 'no dejó enviar en claro sin pedirlo')

  await c._deliver('PEER', { hola: 2 }, {})
  assert.deepEqual(recibidos[0].p, { hola: 2 })
  assert.equal(recibidos[0].meta.sealed, false)
})

// --- El otro mundo: la app de navegador no tiene la llave ---------------------
//
// En una app web la privada de cifrado vive en el VAULT, no en la app: se delega en
// `identity.encrypt`/`identity.decrypt`. Sin esto, `requireSealed` solo servía para
// aparatos headless — es decir, para casi ninguna app del ecosistema.

test('sellado delegado: la app no toca ninguna llave', async () => {
  const bovedaFalsa = {
    async encrypt (destinatarios, texto) { return { v: 9, wrap: 'x', ct: btoa(texto) } },
    async decrypt (env) { return atob(env.ct) },
  }
  const sealing = {
    async seal (msg, peerEncPub) { return bovedaFalsa.encrypt([peerEncPub], JSON.stringify(msg)) },
    async open (env) { return JSON.parse(await bovedaFalsa.decrypt(env)) },
    isSealed (m) { return m?.v === 9 && !!m.ct },
  }

  const c = clienteFalso({ requireSealed: true, sealing })
  const recibidos = []
  const errores = []
  c.on('message', (f, p, meta) => recibidos.push({ p, sealed: meta.sealed }))
  c.on('error', e => errores.push(e))

  await c.sendSealed(['PEER'], { secreto: 'hunter2' }, { peerEncPub: 'PEER-ENC' })
  assert.ok(!JSON.stringify(c._enviado).includes('hunter2'), 'salió en claro')

  // Lo que llega en ese formato se abre; lo que llega en claro sigue rechazándose.
  await c._deliver('PEER', JSON.parse(c._enviado.message), {})
  assert.deepEqual(recibidos[0].p, { secreto: 'hunter2' })
  assert.equal(recibidos[0].sealed, true)

  await c._deliver('PEER', { hola: 'en claro' }, {})
  assert.equal(recibidos.length, 1, 'coló un mensaje sin cifrar')
  assert.equal(errores.at(-1)?.reason, 'plaintext_rejected')
})

test('sellado delegado: enviar en claro sigue estando prohibido', async () => {
  const sealing = { async seal (m) { return { v: 9, ct: 'x' } }, async open () { return {} }, isSealed: m => m?.v === 9 }
  const c = clienteFalso({ requireSealed: true, sealing })
  assert.throws(() => c.sendByPubkey(['PEER'], { hola: 1 }), e => e.code === 'unsealed')
})

test('el singleton no pierde la exigencia: updateConfig la aplica, y no la apaga', async () => {
  const { getWebSocketProxyClient } = await import('../src/index.js')

  // Primer módulo de la app: pide el cliente sin decir nada de sellado.
  const primero = getWebSocketProxyClient({ url: 'wss://x', enableWebRTC: false })
  assert.equal(primero.requireSealed, false)

  // Segundo módulo: el que sí sabe que esto lleva datos del usuario.
  const sealing = { async seal () { return { v: 9, ct: 'x' } }, async open () { return {} }, isSealed: m => m?.v === 9 }
  const segundo = getWebSocketProxyClient({ requireSealed: true, sealing })
  assert.equal(segundo, primero, 'no es el mismo singleton: el test no prueba nada')
  assert.equal(segundo.requireSealed, true, 'la exigencia se perdió en silencio')
  assert.equal(segundo.sealing, sealing)

  // Y no se puede bajar después.
  getWebSocketProxyClient({ requireSealed: false })
  assert.equal(primero.requireSealed, true, 'se pudo apagar la exigencia en caliente')
})

test('un localStorage que EXISTE pero no funciona no rompe la identidad', async () => {
  const { getPublicKeyJwk, setKeypairStore } = await import('../src/signature.js')

  // Node >= 22 expone un localStorage que lanza sin `--localstorage-file`. Comprobar
  // solo que esté definido mandaba la llave por ese camino y reventaba: cualquier app
  // headless sin shim se caía en vez de caer al respaldo.
  // `localStorage` es de solo lectura en globalThis: se redefine con la descriptora.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem () { throw new Error('no localstorage file') },
      setItem () { throw new Error('no localstorage file') },
      removeItem () { throw new Error('no localstorage file') },
    },
  })

  let guardado = null
  setKeypairStore({ async get () { return guardado }, async set (p) { guardado = p } })

  try {
    const jwk = JSON.parse(await getPublicKeyJwk())
    assert.equal(jwk.crv, 'P-256')
    assert.ok(guardado, 'no usó el respaldo')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
    setKeypairStore(null)
  }
})
