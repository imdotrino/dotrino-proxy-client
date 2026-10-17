import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'
import { seal, makeEncKeypair, isSealed, setSealingPrimitives } from '../src/sealing.js'

// `@dotrino/identity` es peer dependency: en este repo no está instalada, así que se
// inyectan las primitivas desde la copia del ecosistema. Es exactamente el hueco que
// `setSealingPrimitives` existe para cubrir.
// POR EL NOMBRE DEL PAQUETE, no por una ruta al monorepo: con `../../dotrino-identity`
// esta prueba solo corría en la máquina de quien tiene el ecosistema clonado al lado, y en
// CI se caía por módulo no encontrado — o sea que no probaba nada donde importa.
setSealingPrimitives(await import('@dotrino/identity/content'))

function fakeClient (opts = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c._sendRaw = (msg) => { c._sent = msg }
  return c
}

test('sellar y abrir: ida y vuelta, y otro no lo abre', async () => {
  const yo = await makeEncKeypair()
  const other = await makeEncKeypair()
  const envelope = await seal({ op: 'find', url: 'https://banco.com.ec/' }, yo.encPub)

  assert.ok(isSealed(envelope))
  const text = JSON.stringify(envelope)
  assert.ok(!text.includes('banco.com.ec'), 'el sitio viajó legible')
  assert.ok(!text.includes('find'), 'la operación viajó legible')

  const { open } = await import('../src/sealing.js')
  assert.deepEqual(await open(envelope, yo.privateKey), { op: 'find', url: 'https://banco.com.ec/' })
  await assert.rejects(() => open(envelope, other.privateKey))
})

test('sendSealed manda el sobre; el contenido no va por el cable', async () => {
  const peer = await makeEncKeypair()
  const c = fakeClient()
  await c.sendSealed(['PEER'], { secret: 'hunter2' }, { peerEncPub: peer.encPub })

  assert.ok(!JSON.stringify(c._sent).includes('hunter2'), 'salió en claro')
  assert.ok(isSealed(JSON.parse(c._sent.message)))
})

// Antes esto afirmaba que sin `peerEncPub` se lanzaba `unsealed` y punto. Desde
// 0.20.0 el pilar SABE AVERIGUARLA (`enc-lookup`, ver `test/encpub.test.mjs`), así que
// ya no falla por no traerla: falla porque nadie la tiene, que es otra cosa y se
// distingue por el `code`. Lo que no cambió, y es lo que aquí importa: no sale nada.
test('sendSealed sin llave y sin quien la sepa no manda nada', async () => {
  const c = fakeClient()
  c.caps = ['channels']   // un proxio que no sirve el directorio: contesta al instante
  await assert.rejects(
    () => c.sendSealed(['PEER'], { x: 1 }, {}),
    e => e.code === 'no-encpub-support')
  assert.equal(c._sent, undefined)
})

test('requireSealed: sendByPubkey en claro LANZA en vez de enviar', async () => {
  const c = fakeClient({ requireSealed: true })
  assert.throws(() => c.sendByPubkey(['PEER'], { secret: 'hunter2' }), e => e.code === 'unsealed')
  assert.equal(c._sent, undefined, 'lo mandó igual')

  // Y con el sobre puesto, sale sin quejarse.
  const peer = await makeEncKeypair()
  await c.sendSealed(['PEER'], { secret: 'hunter2' }, { peerEncPub: peer.encPub })
  assert.ok(c._sent)
})

test('requireSealed: lo que llega en claro se descarta y se avisa', async () => {
  const c = fakeClient({ requireSealed: true })
  const received = []
  const errores = []
  c.on('message', (from, payload) => received.push(payload))
  c.on('error', e => errores.push(e))

  await c._deliver('PEER', { type: 'algo', secret: 'colado' }, {})

  assert.equal(received.length, 0, 'entregó un mensaje sin cifrar a la app')
  assert.equal(errores[0]?.type, 'unsealed')
  assert.equal(errores[0]?.reason, 'plaintext_rejected')
})

test('lo sellado a mí llega abierto, y marcado como sellado', async () => {
  const yo = await makeEncKeypair()
  const c = fakeClient({ requireSealed: true, myEncPrivateKey: yo.privateKey })
  const received = []
  c.on('message', (from, payload, meta) => received.push({ payload, meta }))

  await c._deliver('PEER', await seal({ hello: 'mundo' }, yo.encPub), { via: 'proxy' })

  assert.deepEqual(received[0].payload, { hello: 'mundo' })
  assert.equal(received[0].meta.sealed, true)
})

test('lo sellado a OTRO no llega a la app, y no se confunde con un fallo de red', async () => {
  const yo = await makeEncKeypair()
  const other = await makeEncKeypair()
  const c = fakeClient({ requireSealed: true, myEncPrivateKey: yo.privateKey })
  const received = []
  const errores = []
  c.on('message', (f, p) => received.push(p))
  c.on('error', e => errores.push(e))

  await c._deliver('PEER', await seal({ x: 1 }, other.encPub), {})

  assert.equal(received.length, 0)
  assert.equal(errores[0]?.type, 'undecipherable')
})

test('sin requireSealed nada cambia: las apps de hoy siguen funcionando', async () => {
  const c = fakeClient()
  const received = []
  c.on('message', (f, p, meta) => received.push({ p, meta }))

  c.sendByPubkey(['PEER'], { hello: 1 })
  assert.ok(c._sent, 'no dejó enviar en claro sin pedirlo')

  await c._deliver('PEER', { hello: 2 }, {})
  assert.deepEqual(received[0].p, { hello: 2 })
  assert.equal(received[0].meta.sealed, false)
})

// --- El otro mundo: la app de navegador no tiene la llave ---------------------
//
// En una app web la privada de cifrado vive en el VAULT, no en la app: se delega en
// `identity.encrypt`/`identity.decrypt`. Sin esto, `requireSealed` solo servía para
// aparatos headless — es decir, para casi ninguna app del ecosistema.

test('sellado delegado: la app no toca ninguna llave', async () => {
  const fakeVaultImpl = {
    async encrypt (recipients, text) { return { v: 9, wrap: 'x', ct: btoa(text) } },
    async decrypt (env) { return atob(env.ct) },
  }
  const sealing = {
    async seal (msg, peerEncPub) { return fakeVaultImpl.encrypt([peerEncPub], JSON.stringify(msg)) },
    async open (env) { return JSON.parse(await fakeVaultImpl.decrypt(env)) },
    isSealed (m) { return m?.v === 9 && !!m.ct },
  }

  const c = fakeClient({ requireSealed: true, sealing })
  const received = []
  const errores = []
  c.on('message', (f, p, meta) => received.push({ p, sealed: meta.sealed }))
  c.on('error', e => errores.push(e))

  await c.sendSealed(['PEER'], { secret: 'hunter2' }, { peerEncPub: 'PEER-ENC' })
  assert.ok(!JSON.stringify(c._sent).includes('hunter2'), 'salió en claro')

  // Lo que llega en ese formato se abre; lo que llega en claro sigue rechazándose.
  await c._deliver('PEER', JSON.parse(c._sent.message), {})
  assert.deepEqual(received[0].p, { secret: 'hunter2' })
  assert.equal(received[0].sealed, true)

  await c._deliver('PEER', { hello: 'en claro' }, {})
  assert.equal(received.length, 1, 'coló un mensaje sin cifrar')
  assert.equal(errores.at(-1)?.reason, 'plaintext_rejected')
})

test('sellado delegado: enviar en claro sigue estando prohibido', async () => {
  const sealing = { async seal (m) { return { v: 9, ct: 'x' } }, async open () { return {} }, isSealed: m => m?.v === 9 }
  const c = fakeClient({ requireSealed: true, sealing })
  assert.throws(() => c.sendByPubkey(['PEER'], { hello: 1 }), e => e.code === 'unsealed')
})

test('el singleton no pierde la exigencia: updateConfig la aplica, y no la apaga', async () => {
  const { getWebSocketProxyClient } = await import('../src/index.js')

  // Primer módulo de la app: pide el cliente sin decir nada de sellado.
  const first = getWebSocketProxyClient({ url: 'wss://x', enableWebRTC: false })
  assert.equal(first.requireSealed, false)

  // Segundo módulo: el que sí sabe que esto lleva datos del usuario.
  const sealing = { async seal () { return { v: 9, ct: 'x' } }, async open () { return {} }, isSealed: m => m?.v === 9 }
  const segundo = getWebSocketProxyClient({ requireSealed: true, sealing })
  assert.equal(segundo, first, 'no es el mismo singleton: el test no prueba nada')
  assert.equal(segundo.requireSealed, true, 'la exigencia se perdió en silencio')
  assert.equal(segundo.sealing, sealing)

  // Y no se puede bajar después.
  getWebSocketProxyClient({ requireSealed: false })
  assert.equal(first.requireSealed, true, 'se pudo apagar la exigencia en caliente')
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

  let saved = null
  setKeypairStore({ async get () { return saved }, async set (p) { saved = p } })

  try {
    const jwk = JSON.parse(await getPublicKeyJwk())
    assert.equal(jwk.crv, 'P-256')
    assert.ok(saved, 'no usó el respaldo')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
    setKeypairStore(null)
  }
})
