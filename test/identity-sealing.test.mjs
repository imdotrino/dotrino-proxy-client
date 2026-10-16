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

import { fakeVault } from './_fake-vault.mjs'

/** Dialecto de la clase `Identity` (la que habla con el iframe). */
function dialectoIframe (v) {
  return {
    getEncryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: async (from, _token, sobre) => ({ plaintext: await v.open(from, sobre) })
  }
}

/** Dialecto del núcleo (dentro de un service worker). */
function dialectoNucleo (v) {
  return {
    encryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: (from, sobre) => v.open(from, sobre)
  }
}

test('lo sellado no lleva el mensaje en claro y vuelve entero', async () => {
  const ana = await fakeVault()
  const beto = await fakeVault()
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
  const ana = await fakeVault()
  const beto = await fakeVault()
  const desdeIframe = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  const desdeNucleo = identitySealing(dialectoNucleo(beto), { app: 'prueba' })

  assert.deepEqual(await desdeNucleo.open(await desdeIframe.seal({ a: 1 }, beto.encPub)), { a: 1 })
  assert.deepEqual(await desdeIframe.open(await desdeNucleo.seal({ b: 2 }, ana.encPub)), { b: 2 })
})

test('un sobre envuelto PARA NADIE no sale: se lanza con code', async () => {
  const ana = await fakeVault()
  const sellado = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  // Una llave que la bóveda no puede importar: `encrypt` la salta y devuelve el llavero
  // vacío. Cifrado de verdad, y que no abre nadie.
  await assert.rejects(
    () => sellado.seal({ a: 1 }, '{"kty":"EC","crv":"P-256","x":"no","y":"vale"}'),
    (e) => e.code === 'unsealed')
})

test('sin llave del otro lado no se sella', async () => {
  const ana = await fakeVault()
  const sellado = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  await assert.rejects(() => sellado.seal({ a: 1 }, null), (e) => e.code === 'unsealed')
})

test('la marca del sobre separa lo mío de lo ajeno', async () => {
  const ana = await fakeVault()
  const beto = await fakeVault()
  const mio = identitySealing(dialectoIframe(ana), { app: 'mundial' })
  const ajeno = identitySealing(dialectoIframe(beto), { app: 'passmanager' })
  const sobre = await ajeno.seal({ a: 1 }, ana.encPub)
  assert.equal(mio.isSealed(sobre), false)
})

test('una identidad que no habla ninguno de los dos dialectos revienta con nombre', () => {
  assert.throws(() => identitySealing({}), /getEncryptionPubkey|encryptionPubkey/)
  assert.throws(() => identitySealing({ getEncryptionPubkey: () => {} }), /encrypt\(\)\/decrypt\(\)/)
})

test('con la pubkey del destinatario, el sobre llega a TODOS sus aparatos (tarjeta)', async () => {
  const ana = await fakeVault()
  const recibidos = []
  const id = {
    getEncryptionPubkey: async () => ana.encPub,
    encrypt: async (recipients, pt) => { recibidos.push(...recipients); return ana.encrypt(recipients, pt) },
    decrypt: async () => ({ plaintext: '{}' })
  }
  const beto = await fakeVault()
  await identitySealing(id, { app: 'prueba' }).seal({ a: 1 }, beto.encPub, { publickey: 'PUB-BETO' })
  // La bóveda expande por la tarjeta, y la tarjeta se busca por `publickey`: sin ella,
  // solo abría el aparato que anunció la llave.
  assert.deepEqual(recibidos, [{ publickey: 'PUB-BETO', encryptionPubkey: beto.encPub }])
})

test('senderOf dice quién selló: la llave de cifrado de quien armó el sobre', async () => {
  const ana = await fakeVault()
  const beto = await fakeVault()
  const sellado = identitySealing(dialectoIframe(ana), { app: 'prueba' })
  const sobre = await sellado.seal({ a: 1 }, beto.encPub)
  assert.equal(sellado.senderOf(sobre), ana.encPub)
  assert.equal(sellado.senderOf({}), null)
})
