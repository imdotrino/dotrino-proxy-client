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
import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/client.js'
import { makeEncKeypair, setSealingPrimitives, open, isSealed } from '../src/sealing.js'
import { buildEncPubStatement, readEncPubStatement, ENCPUB_AUD } from '../src/encpub.js'
import { verifyData, samePubkey, canonicalStringify } from '../src/index.js'

setSealingPrimitives(await import('@dotrino/identity/content'))
const { makeDeviceKey, signWithDevice, verifyDeviceSig } = await import('@dotrino/identity/capabilities')

/** Una identidad completa: llave de firma (la del cable) + llave de cifrado. */
async function identity () {
  const signingKey = await makeDeviceKey()
  const encKeys = await makeEncKeypair()
  return {
    publickey: signingKey.publickey,
    encPub: encKeys.encPub,
    encPrivateKey: encKeys.privateKey,
    sign: (data) => signWithDevice({ privateJwk: signingKey.privateJwk, publickey: signingKey.publickey, data })
  }
}

// ---------------------------------------------------------------------------
// 1. La llave queda atada a la identidad
// ---------------------------------------------------------------------------

test('el anuncio ata la llave de cifrado a la identidad que lo firma', async () => {
  const alice = await identity()
  const statement = await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign })

  assert.equal(statement.data.aud, ENCPUB_AUD)
  assert.equal(statement.data.publickey, alice.publickey)
  assert.equal(await readEncPubStatement(statement, { publickey: alice.publickey }), alice.encPub)
})

test('una llave NO atada se rechaza: firmada por otro', async () => {
  const alice = await identity()
  const thief = await identity()

  // El cuerpo dice «la llave de ana es la del ladrón» y lo firma el ladrón. Es exactamente
  // lo que haría quien quiere leer: poner su llave donde va la del otro.
  const data = { v: 1, op: 'encpub', aud: ENCPUB_AUD, publickey: alice.publickey, encpub: thief.encPub, ts: Date.now() }
  const { signature } = await thief.sign(data)

  await assert.rejects(
    () => readEncPubStatement({ data, signature }, { publickey: alice.publickey }),
    (e) => e.code === 'encpub-unverified')
})

test('un anuncio de OTRA identidad no vale aunque esté bien firmado', async () => {
  const alice = await identity()
  const bob = await identity()
  const theirs = await buildEncPubStatement({ publickey: bob.publickey, encPub: bob.encPub, sign: bob.sign })

  // Firma impecable… de beto. Preguntábamos por ana.
  await assert.rejects(
    () => readEncPubStatement(theirs, { publickey: alice.publickey }),
    (e) => e.code === 'encpub-unverified')
})

test('un anuncio con el destinatario cambiado no vale', async () => {
  const alice = await identity()
  const data = { v: 1, op: 'encpub', aud: 'otra-cosa', publickey: alice.publickey, encpub: alice.encPub, ts: Date.now() }
  const { signature } = await alice.sign(data)
  await assert.rejects(
    () => readEncPubStatement({ data, signature }, { publickey: alice.publickey }),
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

  const another = await makeDeviceKey()
  assert.equal(samePubkey(d.publickey, another.publickey), false)
  assert.equal(samePubkey(d.publickey, 'no-es-json'), false)
})

test('un anuncio se lee aunque la pubkey venga escrita de otra forma', async () => {
  const alice = await identity()
  const statement = await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign })
  const j = JSON.parse(alice.publickey)
  const alReves = JSON.stringify({ y: j.y, x: j.x, crv: j.crv, kty: j.kty })
  assert.equal(await readEncPubStatement(statement, { publickey: alReves }), alice.encPub)
})

// ---------------------------------------------------------------------------
// Un proxio de mentira, que contesta lo que le digamos
// ---------------------------------------------------------------------------

/**
 * Cliente con el socket simulado: lo enviado se guarda y el test hace de servidor.
 * `directorio` es lo que ese proxio sabe de las llaves ajenas.
 */
function client ({ directory = new Map(), caps = ['encpub'], ...opts } = {}) {
  const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, ...opts })
  c.caps = caps
  c.sent = []
  c._sendRaw = (msg) => {
    c.sent.push(msg)
    if (msg.type === 'enc-lookup') {
      const keys = []
      const missing = []
      for (const pk of msg.publickeys) {
        const s = directory.get(pk)
        if (s) keys.push(s); else missing.push(pk)
      }
      queueMicrotask(() => c._handleFrame(JSON.stringify({ type: 'enc-lookup', id: msg.id, keys, missing })))
    }
    if (msg.type === 'encpub') {
      directory.set(msg.data.publickey, { data: msg.data, signature: msg.signature })
      queueMicrotask(() => c._handleFrame(JSON.stringify({ type: 'encpub-announced', id: msg.id, stored: true })))
    }
  }
  return c
}

const withContent = (c) => c.sent.filter((m) => m.message !== undefined)

test('sendSealed sin peerEncPub la averigua, la verifica y sella', async () => {
  const alice = await identity()
  const directory = new Map()
  directory.set(alice.publickey,
    await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign }))

  const c = client({ directory })
  await c.sendSealed([alice.publickey], { secret: 'hunter2' })

  const outgoing = withContent(c)
  assert.equal(outgoing.length, 1)
  assert.ok(!JSON.stringify(outgoing[0]).includes('hunter2'), 'salió en claro')
  // Y lo abre ella, nadie más.
  assert.deepEqual(await open(JSON.parse(outgoing[0].message), alice.encPrivateKey), { secret: 'hunter2' })
})

test('UN PROXIO HOSTIL no puede colar su llave: se rechaza y no sale nada', async () => {
  const alice = await identity()
  const badProxy = await identity()
  const directory = new Map()
  // El proxio contesta a «¿cuál es la llave de ana?» con la suya, bien firmada… por él.
  const data = { v: 1, op: 'encpub', aud: ENCPUB_AUD, publickey: alice.publickey, encpub: badProxy.encPub, ts: Date.now() }
  const { signature } = await badProxy.sign(data)
  directory.set(alice.publickey, { data, signature })

  const c = client({ directory })
  await assert.rejects(
    () => c.sendSealed([alice.publickey], { secret: 'hunter2' }),
    (e) => e.code === 'encpub-unverified')
  assert.equal(withContent(c).length, 0, 'mandó algo igual')
})

test('sin llave conocida NO se manda nada, ni en claro', async () => {
  const alice = await identity()
  const c = client({ directory: new Map() })
  await assert.rejects(
    () => c.sendSealed([alice.publickey], { secret: 'hunter2' }),
    (e) => e.code === 'no-encpub')
  assert.equal(withContent(c).length, 0)
})

test('un proxio que no sabe de esto lo dice con su código, no con un timeout', async () => {
  const alice = await identity()
  const c = client({ directory: new Map(), caps: ['channels'] })
  await assert.rejects(
    () => c.sendSealed([alice.publickey], { x: 1 }),
    (e) => e.code === 'no-encpub-support')
  assert.equal(withContent(c).length, 0)
})

test('a varios destinatarios va UNA envoltura por cada uno, y si falta una no sale ninguna', async () => {
  const alice = await identity()
  const bob = await identity()
  const directory = new Map()
  directory.set(alice.publickey, await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign }))

  const c = client({ directory })
  // Falta la de beto: no sale NADA, tampoco lo de ana. Mandar a medias dejaría a la app
  // creyendo que el mensaje llegó, sin saber a quién le falta.
  await assert.rejects(
    () => c.sendSealed([alice.publickey, bob.publickey], { x: 1 }),
    (e) => e.code === 'no-encpub')
  assert.equal(withContent(c).length, 0)

  directory.set(bob.publickey, await buildEncPubStatement({ publickey: bob.publickey, encPub: bob.encPub, sign: bob.sign }))
  await c.sendSealed([alice.publickey, bob.publickey], { x: 1 })
  const outgoing = withContent(c)
  assert.equal(outgoing.length, 2, 'una envoltura por destinatario')
  assert.deepEqual(await open(JSON.parse(outgoing[0].message), alice.encPrivateKey), { x: 1 })
  assert.deepEqual(await open(JSON.parse(outgoing[1].message), bob.encPrivateKey), { x: 1 })
})

test('solo se pregunta UNA vez por llave, aunque se mande varias veces', async () => {
  const alice = await identity()
  const directory = new Map()
  directory.set(alice.publickey, await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign }))
  const c = client({ directory })

  await Promise.all([
    c.sendSealed([alice.publickey], { n: 1 }),
    c.sendSealed([alice.publickey], { n: 2 })
  ])
  await c.sendSealed([alice.publickey], { n: 3 })
  assert.equal(c.sent.filter((m) => m.type === 'enc-lookup').length, 1)
})

// ---------------------------------------------------------------------------
// Por token: la app dice de quién es el token, el pilar sella a esa identidad
// ---------------------------------------------------------------------------

test('sendSealedTo sella a la identidad que la app dice que hay detrás del token', async () => {
  const alice = await identity()
  const directory = new Map()
  directory.set(alice.publickey, await buildEncPubStatement({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign }))

  const c = client({ directory })
  // Un marcador largo: con «e4» a secas la prueba fallaba al azar, porque el texto cifrado
  // también contiene «e4» de vez en cuando.
  const move = { move: 'e4-jugada-en-claro' }
  await c.sendSealedTo('TOKEN-DE-ANA', move, { peerPubkey: alice.publickey })

  const outgoing = withContent(c)
  assert.deepEqual(outgoing[0].to, ['TOKEN-DE-ANA'], 'siguió yendo por token')
  assert.ok(!JSON.stringify(outgoing[0]).includes('jugada-en-claro'), 'salió en claro')
  assert.deepEqual(await open(JSON.parse(outgoing[0].message), alice.encPrivateKey), move)
})

test('sendSealedTo sin decir de quién es el token no manda nada', async () => {
  const c = client()
  // `no-peer-identity` y no `unsealed`: no es que se intentara mandar en claro, es que
  // nadie ha dicho de quién es ese token. Se arregla saludando, no sellando.
  await assert.rejects(
    () => c.sendSealedTo('TOKEN', { x: 1 }, {}),
    (e) => e.code === 'no-peer-identity')
  assert.equal(withContent(c).length, 0)
})

test('requireSealed también corta el `send` por token, no solo el de pubkey', async () => {
  const c = client({ requireSealed: true })
  assert.throws(() => c.send('TOKEN', { secret: 'hunter2' }), (e) => e.code === 'unsealed')
  assert.equal(withContent(c).length, 0)
})

// ---------------------------------------------------------------------------
// El acta manda: quien ya sabe la llave no pregunta
// ---------------------------------------------------------------------------

test('con encPubResolver no se le pregunta al proxio', async () => {
  const alice = await identity()
  const c = client({
    directory: new Map(),           // el proxio no sabe nada
    encPubResolver: (pub) => (pub === alice.publickey ? alice.encPub : null)
  })
  await c.sendSealed([alice.publickey], { x: 1 })
  assert.equal(c.sent.filter((m) => m.type === 'enc-lookup').length, 0)
  assert.deepEqual(await open(JSON.parse(withContent(c)[0].message), alice.encPrivateKey), { x: 1 })
})

test('un encPubResolver que devuelve basura no pasa', async () => {
  const alice = await identity()
  const c = client({ directory: new Map(), encPubResolver: () => 'no-soy-un-jwk' })
  await assert.rejects(
    () => c.sendSealed([alice.publickey], { x: 1 }),
    (e) => e.code === 'encpub-unverified')
  assert.equal(withContent(c).length, 0)
})

// ---------------------------------------------------------------------------
// EL CASO DIFÍCIL: dos que no se han emparejado nunca
// ---------------------------------------------------------------------------

test('DOS DESCONOCIDOS SE SELLAN: nunca se emparejaron y ninguno tenía la llave del otro', async () => {
  const alice = await identity()
  const bob = await identity()

  // Un solo proxio de mentira para los dos, con su directorio compartido. Lo único que
  // sabe cada uno del otro es su PUBKEY —lo que da un canal público, una invitación o el
  // saludo de una sala—. Ni contactos, ni cita, ni llave intercambiada.
  const directory = new Map()
  const cAlice = client({ directory, requireSealed: true, myEncPrivateKey: alice.encPrivateKey })
  const cBob = client({ directory, requireSealed: true, myEncPrivateKey: bob.encPrivateKey })

  await cAlice.announceEncPub({ publickey: alice.publickey, encPub: alice.encPub, sign: alice.sign })
  await cBob.announceEncPub({ publickey: bob.publickey, encPub: bob.encPub, sign: bob.sign })

  // Ana le escribe a beto sin haber hablado nunca con él.
  await cAlice.sendSealed([bob.publickey], { text: 'nos vemos a las 8' })
  const cable = withContent(cAlice).at(-1)
  assert.ok(!JSON.stringify(cable).includes('nos vemos'), 'el proxio lo habría leído')
  assert.ok(isSealed(JSON.parse(cable.message)))

  // Y llega: se lo metemos a beto por donde se lo metería el proxio.
  const received = []
  cBob.on('message', (from, payload, meta) => received.push({ payload, meta }))
  cBob._handleFrame(JSON.stringify({
    type: 'message', from: 'TOKEN-ANA', from_publickey: alice.publickey, message: cable.message
  }))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(received[0].payload, { text: 'nos vemos a las 8' })
  assert.equal(received[0].meta.sealed, true)

  // Y contesta igual, en el otro sentido.
  await cBob.sendSealed([alice.publickey], { text: 'ahí estaré' })
  const roundTrip = withContent(cBob).at(-1)
  assert.ok(!JSON.stringify(roundTrip).includes('ahí estaré'))
  assert.deepEqual(await open(JSON.parse(roundTrip.message), alice.encPrivateKey), { text: 'ahí estaré' })
})
