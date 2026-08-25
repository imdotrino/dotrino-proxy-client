/**
 * El sobre firmado de un canal. La regla que se fija aquí es la que ya rompió
 * el descubrimiento del lobby una vez: `name` y `publickey` son AUTORITATIVOS
 * y la metadata de la app no puede pisarlos. El lobby publica con
 * `{ name: <roomName> }` como extra, y si ese `name` ganara, la sala se
 * publicaría bajo un canal distinto del que luego se lista.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import './_entorno.mjs'   // localStorage: ver la nota de ahi, no es opcional

const { buildSignedChannel, getPublicKeyJwk, signData } = await import('../src/signature.js')
const { canonicalStringify } = await import('../src/canonical.js')

test('el canal va bajo `name`, y la metadata de la app no lo pisa', async () => {
  const sobre = await buildSignedChannel('sala-42', { name: 'Mi sala bonita', nickname: 'ana' })
  assert.equal(sobre.data.name, 'sala-42', 'el extra `name` NO puede cambiar el canal')
  assert.equal(sobre.data.nickname, 'ana', 'el resto de la metadata sí viaja')
})

test('la publickey tampoco se puede suplantar desde la metadata', async () => {
  const real = await getPublicKeyJwk()
  const sobre = await buildSignedChannel('c', { publickey: '{"kty":"MENTIRA"}' })
  assert.equal(sobre.data.publickey, real)
})

test('la firma valida contra la publickey del propio sobre', async () => {
  const sobre = await buildSignedChannel('canal', { nickname: 'ana' })
  const jwk = JSON.parse(sobre.data.publickey)
  const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    pub,
    Buffer.from(sobre.signature, 'base64'),
    new TextEncoder().encode(canonicalStringify(sobre.data))
  )
  assert.equal(ok, true, 'el proxy verifica exactamente así: sobre el canonical del data')
})

test('tocar un solo campo del data invalida la firma', async () => {
  const sobre = await buildSignedChannel('canal', { nickname: 'ana' })
  const jwk = JSON.parse(sobre.data.publickey)
  const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const manipulado = { ...sobre.data, nickname: 'mallory' }
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    pub,
    Buffer.from(sobre.signature, 'base64'),
    new TextEncoder().encode(canonicalStringify(manipulado))
  )
  assert.equal(ok, false)
})

test('la llave es ECDSA P-256 y la pública NO lleva la privada', async () => {
  const jwk = JSON.parse(await getPublicKeyJwk())
  assert.equal(jwk.kty, 'EC')
  assert.equal(jwk.crv, 'P-256')
  assert.equal(jwk.d, undefined, 'un JWK público con `d` estaría publicando la llave privada')
})

test('la misma llave entre llamadas (se persiste, no se regenera)', async () => {
  assert.equal(await getPublicKeyJwk(), await getPublicKeyJwk())
})

test('firmar dos datos distintos da firmas distintas', async () => {
  assert.notEqual(await signData({ a: 1 }), await signData({ a: 2 }))
})

// --- Persistencia fuera de una página (service worker) ------------------------
//
// Sin localStorage la identidad se regeneraba en cada llamada y no se guardaba: en un
// service worker, que se duerme constantemente, el aparato cambiaba de llave todo el
// rato y cualquier peer que lo conociera por su pubkey veía un desconocido.

test('sin localStorage, la identidad PERSISTE en el almacén inyectado', async () => {
  const { getPublicKeyJwk, setKeypairStore } = await import('../src/signature.js')

  let guardado = null
  const store = {
    async get () { return guardado },
    async set (pair) { guardado = pair },
  }

  setKeypairStore(store)
  const primera = await getPublicKeyJwk()
  assert.ok(guardado, 'no guardó nada')

  // Segundo arranque: el worker despertó y la caché en memoria se perdió.
  setKeypairStore(store)
  const segunda = await getPublicKeyJwk()
  assert.equal(segunda, primera, 'la llave cambió entre arranques')
})

test('sin localStorage, la privada NO sale del almacén como JWK', async () => {
  const { getPublicKeyJwk, signData, setKeypairStore } = await import('../src/signature.js')

  let guardado = null
  setKeypairStore({ async get () { return guardado }, async set (p) { guardado = p } })
  await getPublicKeyJwk()

  assert.equal(guardado.privateKey.extractable, false)
  assert.equal(guardado.privateKey.type, 'private')
  await assert.rejects(() => crypto.subtle.exportKey('jwk', guardado.privateKey))

  // Y aun así firma, que es para lo único que se necesita.
  const signature = await signData({ op: 'test', ts: 1 })
  assert.ok(typeof signature === 'string' && signature.length > 0)

  setKeypairStore(null)
})
