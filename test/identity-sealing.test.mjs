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
import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { identitySealing } from '../src/sealing.js'

import { fakeVault } from './_fake-vault.mjs'

/** Dialecto de la clase `Identity` (la que habla con el iframe). */
function iframeDialect (v) {
  return {
    getEncryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: async (from, _token, envelope) => ({ plaintext: await v.open(from, envelope) })
  }
}

/** Dialecto del núcleo (dentro de un service worker). */
function coreDialect (v) {
  return {
    encryptionPubkey: async () => v.encPub,
    encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
    decrypt: (from, envelope) => v.open(from, envelope)
  }
}

test('lo sellado no lleva el mensaje en claro y vuelve entero', async () => {
  const alice = await fakeVault()
  const bob = await fakeVault()
  const sealedAlice = identitySealing(iframeDialect(alice), { app: 'prueba' })
  const sealedBob = identitySealing(iframeDialect(bob), { app: 'prueba' })

  const msgText = { type: 'ROOM_PREDICTION', env: 'BRASIL-CAMPEON' }
  const envelope = await sealedAlice.seal(msgText, bob.encPub)

  assert.ok(!JSON.stringify(envelope).includes('BRASIL-CAMPEON'), 'el sobre no puede llevar el contenido')
  assert.ok(!JSON.stringify(envelope).includes('ROOM_PREDICTION'), 'ni el tipo del mensaje')
  assert.equal(sealedBob.isSealed(envelope), true)
  assert.deepEqual(await sealedBob.open(envelope), msgText)
})

test('los dos dialectos se abren el uno al otro', async () => {
  const alice = await fakeVault()
  const bob = await fakeVault()
  const fromIframe = identitySealing(iframeDialect(alice), { app: 'prueba' })
  const fromCore = identitySealing(coreDialect(bob), { app: 'prueba' })

  assert.deepEqual(await fromCore.open(await fromIframe.seal({ a: 1 }, bob.encPub)), { a: 1 })
  assert.deepEqual(await fromIframe.open(await fromCore.seal({ b: 2 }, alice.encPub)), { b: 2 })
})

test('un sobre envuelto PARA NADIE no sale: se lanza con code', async () => {
  const alice = await fakeVault()
  const sealed = identitySealing(iframeDialect(alice), { app: 'prueba' })
  // Una llave que la bóveda no puede importar: `encrypt` la salta y devuelve el llavero
  // vacío. Cifrado de verdad, y que no abre nadie.
  await assert.rejects(
    () => sealed.seal({ a: 1 }, '{"kty":"EC","crv":"P-256","x":"no","y":"vale"}'),
    (e) => e.code === 'unsealed')
})

test('sin llave del otro lado no se sella', async () => {
  const alice = await fakeVault()
  const sealed = identitySealing(iframeDialect(alice), { app: 'prueba' })
  await assert.rejects(() => sealed.seal({ a: 1 }, null), (e) => e.code === 'unsealed')
})

test('la marca del sobre separa lo mío de lo ajeno', async () => {
  const alice = await fakeVault()
  const bob = await fakeVault()
  const mine = identitySealing(iframeDialect(alice), { app: 'mundial' })
  const foreign = identitySealing(iframeDialect(bob), { app: 'passmanager' })
  const envelope = await foreign.seal({ a: 1 }, alice.encPub)
  assert.equal(mine.isSealed(envelope), false)
})

test('una identidad que no habla ninguno de los dos dialectos revienta con nombre', () => {
  assert.throws(() => identitySealing({}), /getEncryptionPubkey|encryptionPubkey/)
  assert.throws(() => identitySealing({ getEncryptionPubkey: () => {} }), /encrypt\(\)\/decrypt\(\)/)
})

test('con la pubkey del destinatario, el sobre llega a TODOS sus aparatos (tarjeta)', async () => {
  const alice = await fakeVault()
  const received = []
  const id = {
    getEncryptionPubkey: async () => alice.encPub,
    encrypt: async (recipients, pt) => { received.push(...recipients); return alice.encrypt(recipients, pt) },
    decrypt: async () => ({ plaintext: '{}' })
  }
  const bob = await fakeVault()
  await identitySealing(id, { app: 'prueba' }).seal({ a: 1 }, bob.encPub, { publickey: 'PUB-BETO' })
  // La bóveda expande por la tarjeta, y la tarjeta se busca por `publickey`: sin ella,
  // solo abría el aparato que anunció la llave.
  assert.deepEqual(received, [{ publickey: 'PUB-BETO', encryptionPubkey: bob.encPub }])
})

test('senderOf dice quién selló: la llave de cifrado de quien armó el sobre', async () => {
  const alice = await fakeVault()
  const bob = await fakeVault()
  const sealed = identitySealing(iframeDialect(alice), { app: 'prueba' })
  const envelope = await sealed.seal({ a: 1 }, bob.encPub)
  assert.equal(sealed.senderOf(envelope), alice.encPub)
  assert.equal(sealed.senderOf({}), null)
})
