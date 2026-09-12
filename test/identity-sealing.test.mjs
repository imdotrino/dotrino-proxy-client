/**
 * EL PUENTE DE LA BÓVEDA, que es como sella una app de NAVEGADOR.
 *
 * En el navegador la privada de cifrado no está en la app: vive dentro del iframe de la
 * bóveda y no sale. Así que sellar y abrir se delegan en `@dotrino/identity`, y este
 * módulo es el sobre que se pasan las dos puntas. Estaba escrito en el gestor de
 * contraseñas y subió al pilar porque dos copias del mismo sobre son una que se queda
 * atrás — y ese fallo es MUDO: la petición sale, al otro lado «no es para mí».
 *
 * Lo que se prueba:
 *   1. lo sellado no lleva el mensaje en claro, y vuelve entero al abrirlo;
 *   2. los DOS dialectos de identidad (iframe y núcleo) hablan el mismo sobre;
 *   3. un sobre envuelto PARA NADIE no se manda: se lanza con `code`;
 *   4. la marca del sobre (`app`) separa lo mío de lo ajeno.
 */
import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { identitySealing } from '../src/sealing.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const subtle = globalThis.crypto.subtle

/** Una bóveda de mentira con la MISMA forma que el núcleo real: ECDH + AES-GCM. */
async function boveda () {
  const par = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const jwk = await subtle.exportKey('jwk', par.publicKey)
  const encPub = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  const compartida = async (peerJwkStr) => {
    const pub = await subtle.importKey('jwk', JSON.parse(peerJwkStr), ECDH, false, [])
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, par.privateKey, 256)
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  const id = async (encPubStr) => b64(await subtle.digest('SHA-256', new TextEncoder().encode(encPubStr))).slice(0, 16)
  return {
    encPub,
    async encrypt (recipients, plaintext) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const wrap = {}
      for (const r of recipients || []) {
        if (!r?.encryptionPubkey) continue
        // Igual que el núcleo: la llave que no se puede importar se SALTA en silencio.
        let key
        try { key = await compartida(r.encryptionPubkey) } catch (_) { continue }
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
        wrap[await id(r.encryptionPubkey)] = { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
      }
      return { v: 2, iv: b64(iv), ct: '', wrap }
    },
    async abrir (remitenteEncPub, sobre) {
      const key = await compartida(remitenteEncPub)
      const mio = sobre.wrap[await id(encPub)]
      if (!mio) throw new Error('this device is not among the message recipients')
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mio.iv) }, key, unb64(mio.ct))
      return new TextDecoder().decode(pt)
    }
  }
}

/** Dialecto de la clase `Identity` (la que habla con el iframe). */
function dialectoIframe (v) {
  return {
    getEncryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: async (from, _token, sobre) => ({ plaintext: await v.abrir(from, sobre) })
  }
}

/** Dialecto del núcleo (dentro de un service worker). */
function dialectoNucleo (v) {
  return {
    encryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: (from, sobre) => v.abrir(from, sobre)
  }
}

test('lo sellado no lleva el mensaje en claro y vuelve entero', async () => {
  const ana = await boveda()
  const beto = await boveda()
  const selladoAna = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  const selladoBeto = identitySealing(dialectoIframe(beto), { app: 'prueba' })

  const mensaje = { type: 'ROOM_PREDICTION', env: 'BRASIL-CAMPEON' }
  const sobre = await selladoAna.seal(mensaje, beto.encPub)

  assert.ok(!JSON.stringify(sobre).includes('BRASIL-CAMPEON'), 'el sobre no puede llevar el contenido')
  assert.ok(!JSON.stringify(sobre).includes('ROOM_PREDICTION'), 'ni el tipo del mensaje')
  assert.equal(selladoBeto.isSealed(sobre), true)
  assert.deepEqual(await selladoBeto.open(sobre), mensaje)
})

test('los dos dialectos se abren el uno al otro', async () => {
  const ana = await boveda()
  const beto = await boveda()
  const desdeIframe = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  const desdeNucleo = identitySealing(dialectoNucleo(beto), { app: 'prueba' })

  assert.deepEqual(await desdeNucleo.open(await desdeIframe.seal({ a: 1 }, beto.encPub)), { a: 1 })
  assert.deepEqual(await desdeIframe.open(await desdeNucleo.seal({ b: 2 }, ana.encPub)), { b: 2 })
})

test('un sobre envuelto PARA NADIE no sale: se lanza con code', async () => {
  const ana = await boveda()
  const sellado = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  // Una llave que la bóveda no puede importar: `encrypt` la salta y devuelve el llavero
  // vacío. Cifrado de verdad, y que no abre nadie.
  await assert.rejects(
    () => sellado.seal({ a: 1 }, '{"kty":"EC","crv":"P-256","x":"no","y":"vale"}'),
    (e) => e.code === 'unsealed')
})

test('sin llave del otro lado no se sella', async () => {
  const ana = await boveda()
  const sellado = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  await assert.rejects(() => sellado.seal({ a: 1 }, null), (e) => e.code === 'unsealed')
})

test('la marca del sobre separa lo mío de lo ajeno', async () => {
  const ana = await boveda()
  const beto = await boveda()
  const mio = identitySealing(dialectoIframe(ana), { app: 'mundial' })
  const ajeno = identitySealing(dialectoIframe(beto), { app: 'passmanager' })
  const sobre = await ajeno.seal({ a: 1 }, ana.encPub)
  assert.equal(mio.isSealed(sobre), false)
})

test('una identidad que no habla ninguno de los dos dialectos revienta con nombre', () => {
  assert.throws(() => identitySealing({}), /getEncryptionPubkey|encryptionPubkey/)
  assert.throws(() => identitySealing({ getEncryptionPubkey: () => {} }), /encrypt\(\)\/decrypt\(\)/)
})
