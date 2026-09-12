/**
 * AVERIGUAR LA LLAVE DE CIFRADO DE ALGUIEN CON QUIEN NO TE HAS EMPAREJADO NUNCA.
 *
 * Hasta ahora `sendSealed` exigía `peerEncPub` y el pilar no daba ninguna forma de
 * conseguirla, así que sellar solo servía entre dos puntas que se la habían intercambiado
 * a mano. Una sala de desconocidos no puede hacer eso, y por eso seis apps del ecosistema
 * siguen mandando en claro por un VPS alquilado.
 *
 * Lo que se prueba aquí, por orden de importancia:
 *   1. la llave llega ATADA a una identidad verificada (firma sobre el cuerpo canónico);
 *   2. una llave que NO firmó esa identidad se rechaza — es el caso del proxio hostil,
 *      que cambiaría la llave por la suya para poder leer;
 *   3. sin llave no sale NADA, ni siquiera en claro;
 *   4. dos partes que no se han emparejado nunca acaban sellándose la una a la otra.
 */
import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/client.js'
import { makeEncKeypair, setSealingPrimitives, open, isSealed } from '../src/sealing.js'
import { buildEncPubStatement, readEncPubStatement, ENCPUB_AUD } from '../src/encpub.js'
import { verifyData, samePubkey, canonicalStringify } from '../src/index.js'

setSealingPrimitives(await import('@dotrino/identity/content'))
const { makeDeviceKey, signWithDevice, verifyDeviceSig } = await import('@dotrino/identity/capabilities')

/** Una identidad completa: llave de firma (la del cable) + llave de cifrado. */
async function identidad () {
  const firma = await makeDeviceKey()
  const cifrado = await makeEncKeypair()
  return {
    publickey: firma.publickey,
    encPub: cifrado.encPub,
    encPrivateKey: cifrado.privateKey,
    sign: (data) => signWithDevice({ privateJwk: firma.privateJwk, publickey: firma.publickey, data })
  }
}

// ---------------------------------------------------------------------------
// 1. La llave queda atada a la identidad
// ---------------------------------------------------------------------------

test('el anuncio ata la llave de cifrado a la identidad que lo firma', async () => {
  const ana = await identidad()
  const statement = await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign })

  assert.equal(statement.data.aud, ENCPUB_AUD)
  assert.equal(statement.data.publickey, ana.publickey)
  assert.equal(await readEncPubStatement(statement, { publickey: ana.publickey }), ana.encPub)
})

test('una llave NO atada se rechaza: firmada por otro', async () => {
  const ana = await identidad()
  const ladron = await identidad()

  // El cuerpo dice «la llave de ana es la del ladrón» y lo firma el ladrón. Es exactamente
  // lo que haría quien quiere leer: poner su llave donde va la del otro.
  const data = { v: 1, op: 'encpub', aud: ENCPUB_AUD, publickey: ana.publickey, encpub: ladron.encPub, ts: Date.now() }
  const { signature } = await ladron.sign(data)

  await assert.rejects(
    () => readEncPubStatement({ data, signature }, { publickey: ana.publickey }),
    (e) => e.code === 'encpub-unverified')
})

test('un anuncio de OTRA identidad no vale aunque esté bien firmado', async () => {
  const ana = await identidad()
  const beto = await identidad()
  const suyo = await buildEncPubStatement({ publickey: beto.publickey, encPub: beto.encPub, sign: beto.sign })

  // Firma impecable… de beto. Preguntábamos por ana.
  await assert.rejects(
    () => readEncPubStatement(suyo, { publickey: ana.publickey }),
    (e) => e.code === 'encpub-unverified')
})

test('un anuncio con el destinatario cambiado no vale', async () => {
  const ana = await identidad()
  const data = { v: 1, op: 'encpub', aud: 'otra-cosa', publickey: ana.publickey, encpub: ana.encPub, ts: Date.now() }
  const { signature } = await ana.sign(data)
  await assert.rejects(
    () => readEncPubStatement({ data, signature }, { publickey: ana.publickey }),
    (e) => e.code === 'encpub-unverified')
})

// ---------------------------------------------------------------------------
// La verificación local y la del pilar tienen que decir LO MISMO
// ---------------------------------------------------------------------------

test('verifyData y el verificador de @dotrino/identity coinciden, en los dos sentidos', async () => {
  const d = await makeDeviceKey()
  const data = { z: 1, a: { b: [2, 'x'] }, m: null }
  const { signature } = await signWithDevice({ privateJwk: d.privateJwk, publickey: d.publickey, data })

  // Firmado por el pilar, verificado aquí.
  assert.equal(await verifyData(d.publickey, data, signature), true)
  // Y lo mismo al revés: si alguno cambiara de canonicalización o de algoritmo, esto se
  // pone rojo el mismo día en vez de dejar dos piezas que no se entienden.
  assert.equal(await verifyDeviceSig({ publickey: d.publickey, data, signature }), true)
  assert.equal(await verifyData(d.publickey, { ...data, z: 2 }, signature), false)
})

test('samePubkey: la misma llave escrita de otra forma sigue siendo la misma', async () => {
  const d = await makeDeviceKey()
  const j = JSON.parse(d.publickey)
  const alReves = JSON.stringify({ y: j.y, x: j.x, crv: j.crv, kty: j.kty })
  assert.notEqual(alReves, d.publickey, 'el test no prueba nada si los strings ya son iguales')
  assert.equal(samePubkey(d.publickey, alReves), true)

  const otra = await makeDeviceKey()
  assert.equal(samePubkey(d.publickey, otra.publickey), false)
  assert.equal(samePubkey(d.publickey, 'no-es-json'), false)
})

test('un anuncio se lee aunque la pubkey venga escrita de otra forma', async () => {
  const ana = await identidad()
  const statement = await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign })
  const j = JSON.parse(ana.publickey)
  const alReves = JSON.stringify({ y: j.y, x: j.x, crv: j.crv, kty: j.kty })
  assert.equal(await readEncPubStatement(statement, { publickey: alReves }), ana.encPub)
})

// ---------------------------------------------------------------------------
// Un proxio de mentira, que contesta lo que le digamos
// ---------------------------------------------------------------------------

/**
 * Cliente con el socket simulado: lo enviado se guarda y el test hace de servidor.
 * `directorio` es lo que ese proxio sabe de las llaves ajenas.
 */
function cliente ({ directorio = new Map(), caps = ['encpub'], ...opts } = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c.caps = caps
  c.enviados = []
  c._sendRaw = (msg) => {
    c.enviados.push(msg)
    if (msg.type === 'enc-lookup') {
      const keys = []
      const missing = []
      for (const pk of msg.publickeys) {
        const s = directorio.get(pk)
        if (s) keys.push(s); else missing.push(pk)
      }
      queueMicrotask(() => c._handleFrame(JSON.stringify({ type: 'enc-lookup', id: msg.id, keys, missing })))
    }
    if (msg.type === 'encpub') {
      directorio.set(msg.data.publickey, { data: msg.data, signature: msg.signature })
      queueMicrotask(() => c._handleFrame(JSON.stringify({ type: 'encpub-announced', id: msg.id, stored: true })))
    }
  }
  return c
}

const conContenido = (c) => c.enviados.filter((m) => m.message !== undefined)

test('sendSealed sin peerEncPub la averigua, la verifica y sella', async () => {
  const ana = await identidad()
  const directorio = new Map()
  directorio.set(ana.publickey,
    await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))

  const c = cliente({ directorio })
  await c.sendSealed([ana.publickey], { secreto: 'hunter2' })

  const salidos = conContenido(c)
  assert.equal(salidos.length, 1)
  assert.ok(!JSON.stringify(salidos[0]).includes('hunter2'), 'salió en claro')
  // Y lo abre ella, nadie más.
  assert.deepEqual(await open(JSON.parse(salidos[0].message), ana.encPrivateKey), { secreto: 'hunter2' })
})

test('UN PROXIO HOSTIL no puede colar su llave: se rechaza y no sale nada', async () => {
  const ana = await identidad()
  const proxioMalo = await identidad()
  const directorio = new Map()
  // El proxio contesta a «¿cuál es la llave de ana?» con la suya, bien firmada… por él.
  const data = { v: 1, op: 'encpub', aud: ENCPUB_AUD, publickey: ana.publickey, encpub: proxioMalo.encPub, ts: Date.now() }
  const { signature } = await proxioMalo.sign(data)
  directorio.set(ana.publickey, { data, signature })

  const c = cliente({ directorio })
  await assert.rejects(
    () => c.sendSealed([ana.publickey], { secreto: 'hunter2' }),
    (e) => e.code === 'encpub-unverified')
  assert.equal(conContenido(c).length, 0, 'mandó algo igual')
})

test('sin llave conocida NO se manda nada, ni en claro', async () => {
  const ana = await identidad()
  const c = cliente({ directorio: new Map() })
  await assert.rejects(
    () => c.sendSealed([ana.publickey], { secreto: 'hunter2' }),
    (e) => e.code === 'no-encpub')
  assert.equal(conContenido(c).length, 0)
})

test('un proxio que no sabe de esto lo dice con su código, no con un timeout', async () => {
  const ana = await identidad()
  const c = cliente({ directorio: new Map(), caps: ['channels'] })
  await assert.rejects(
    () => c.sendSealed([ana.publickey], { x: 1 }),
    (e) => e.code === 'no-encpub-support')
  assert.equal(conContenido(c).length, 0)
})

test('a varios destinatarios va UNA envoltura por cada uno, y si falta una no sale ninguna', async () => {
  const ana = await identidad()
  const beto = await identidad()
  const directorio = new Map()
  directorio.set(ana.publickey, await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))

  const c = cliente({ directorio })
  // Falta la de beto: no sale NADA, tampoco lo de ana. Mandar a medias dejaría a la app
  // creyendo que el mensaje llegó, sin saber a quién le falta.
  await assert.rejects(
    () => c.sendSealed([ana.publickey, beto.publickey], { x: 1 }),
    (e) => e.code === 'no-encpub')
  assert.equal(conContenido(c).length, 0)

  directorio.set(beto.publickey, await buildEncPubStatement({ publickey: beto.publickey, encPub: beto.encPub, sign: beto.sign }))
  await c.sendSealed([ana.publickey, beto.publickey], { x: 1 })
  const salidos = conContenido(c)
  assert.equal(salidos.length, 2, 'una envoltura por destinatario')
  assert.deepEqual(await open(JSON.parse(salidos[0].message), ana.encPrivateKey), { x: 1 })
  assert.deepEqual(await open(JSON.parse(salidos[1].message), beto.encPrivateKey), { x: 1 })
})

test('solo se pregunta UNA vez por llave, aunque se mande varias veces', async () => {
  const ana = await identidad()
  const directorio = new Map()
  directorio.set(ana.publickey, await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))
  const c = cliente({ directorio })

  await Promise.all([
    c.sendSealed([ana.publickey], { n: 1 }),
    c.sendSealed([ana.publickey], { n: 2 })
  ])
  await c.sendSealed([ana.publickey], { n: 3 })
  assert.equal(c.enviados.filter((m) => m.type === 'enc-lookup').length, 1)
})

// ---------------------------------------------------------------------------
// Por token: la app dice de quién es el token, el pilar sella a esa identidad
// ---------------------------------------------------------------------------

test('sendSealedTo sella a la identidad que la app dice que hay detrás del token', async () => {
  const ana = await identidad()
  const directorio = new Map()
  directorio.set(ana.publickey, await buildEncPubStatement({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))

  const c = cliente({ directorio })
  await c.sendSealedTo('TOKEN-DE-ANA', { jugada: 'e4' }, { peerPubkey: ana.publickey })

  const salidos = conContenido(c)
  assert.deepEqual(salidos[0].to, ['TOKEN-DE-ANA'], 'siguió yendo por token')
  assert.ok(!JSON.stringify(salidos[0]).includes('e4'), 'salió en claro')
  assert.deepEqual(await open(JSON.parse(salidos[0].message), ana.encPrivateKey), { jugada: 'e4' })
})

test('sendSealedTo sin decir de quién es el token no manda nada', async () => {
  const c = cliente()
  // `no-peer-identity` y no `unsealed`: no es que se intentara mandar en claro, es que
  // nadie ha dicho de quién es ese token. Se arregla saludando, no sellando.
  await assert.rejects(
    () => c.sendSealedTo('TOKEN', { x: 1 }, {}),
    (e) => e.code === 'no-peer-identity')
  assert.equal(conContenido(c).length, 0)
})

test('requireSealed también corta el `send` por token, no solo el de pubkey', async () => {
  const c = cliente({ requireSealed: true })
  assert.throws(() => c.send('TOKEN', { secreto: 'hunter2' }), (e) => e.code === 'unsealed')
  assert.equal(conContenido(c).length, 0)
})

// ---------------------------------------------------------------------------
// El acta manda: quien ya sabe la llave no pregunta
// ---------------------------------------------------------------------------

test('con encPubResolver no se le pregunta al proxio', async () => {
  const ana = await identidad()
  const c = cliente({
    directorio: new Map(),           // el proxio no sabe nada
    encPubResolver: (pub) => (pub === ana.publickey ? ana.encPub : null)
  })
  await c.sendSealed([ana.publickey], { x: 1 })
  assert.equal(c.enviados.filter((m) => m.type === 'enc-lookup').length, 0)
  assert.deepEqual(await open(JSON.parse(conContenido(c)[0].message), ana.encPrivateKey), { x: 1 })
})

test('un encPubResolver que devuelve basura no pasa', async () => {
  const ana = await identidad()
  const c = cliente({ directorio: new Map(), encPubResolver: () => 'no-soy-un-jwk' })
  await assert.rejects(
    () => c.sendSealed([ana.publickey], { x: 1 }),
    (e) => e.code === 'encpub-unverified')
  assert.equal(conContenido(c).length, 0)
})

// ---------------------------------------------------------------------------
// EL CASO DIFÍCIL: dos que no se han emparejado nunca
// ---------------------------------------------------------------------------

test('DOS DESCONOCIDOS SE SELLAN: nunca se emparejaron y ninguno tenía la llave del otro', async () => {
  const ana = await identidad()
  const beto = await identidad()

  // Un solo proxio de mentira para los dos, con su directorio compartido. Lo único que
  // sabe cada uno del otro es su PUBKEY —lo que da un canal público, una invitación o el
  // saludo de una sala—. Ni contactos, ni cita, ni llave intercambiada.
  const directorio = new Map()
  const cAna = cliente({ directorio, requireSealed: true, myEncPrivateKey: ana.encPrivateKey })
  const cBeto = cliente({ directorio, requireSealed: true, myEncPrivateKey: beto.encPrivateKey })

  await cAna.announceEncPub({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign })
  await cBeto.announceEncPub({ publickey: beto.publickey, encPub: beto.encPub, sign: beto.sign })

  // Ana le escribe a beto sin haber hablado nunca con él.
  await cAna.sendSealed([beto.publickey], { texto: 'nos vemos a las 8' })
  const cable = conContenido(cAna).at(-1)
  assert.ok(!JSON.stringify(cable).includes('nos vemos'), 'el proxio lo habría leído')
  assert.ok(isSealed(JSON.parse(cable.message)))

  // Y llega: se lo metemos a beto por donde se lo metería el proxio.
  const recibidos = []
  cBeto.on('message', (from, payload, meta) => recibidos.push({ payload, meta }))
  cBeto._handleFrame(JSON.stringify({
    type: 'message', from: 'TOKEN-ANA', from_publickey: ana.publickey, message: cable.message
  }))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(recibidos[0].payload, { texto: 'nos vemos a las 8' })
  assert.equal(recibidos[0].meta.sealed, true)

  // Y contesta igual, en el otro sentido.
  await cBeto.sendSealed([ana.publickey], { texto: 'ahí estaré' })
  const vuelta = conContenido(cBeto).at(-1)
  assert.ok(!JSON.stringify(vuelta).includes('ahí estaré'))
  assert.deepEqual(await open(JSON.parse(vuelta.message), ana.encPrivateKey), { texto: 'ahí estaré' })
})
