/**
 * LAS DOS BÓVEDAS A LA VEZ (0.47.0): una bóveda que vive dentro de una app (la extensión de
 * contraseñas) sella lo de la app con `sealing` y TAMBIÉN tiene que abrir lo que el
 * ecosistema le sella a su llave de transporte con el sobre del pilar — las peticiones de
 * sus aparatos (`dotrino-vault/docs/sealed-requests.md`). Y contestarlas con ese sobre.
 */
import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient, identitySealing, makeEncKeypair, seal, open, isSealed } from '../src/index.js'
import { fakeVault } from './_fake-vault.mjs'

const dialect = (v) => ({
  getEncryptionPubkey: async () => v.encPub,
  encrypt: (recipients, plaintext) => v.encrypt(recipients, plaintext),
  decrypt: async (from, _token, envelope) => ({ plaintext: await v.open(from, envelope) })
})

async function both () {
  const appVault = await fakeVault()
  const transport = await makeEncKeypair()
  const client = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1', autoReconnect: false, sealing: identitySealing(dialect(appVault), { app: 'prueba' }), myEncPrivateKey: transport.privateKey })
  const got = []
  client.on('message', (from, payload, meta) => got.push({ from, payload, meta }))
  return { client, appVault, transport, got }
}

test('con sealing y llave del pilar, abre los DOS sobres', async () => {
  const { client, appVault, transport, got } = await both()
  const other = await fakeVault()
  const appEnv = await identitySealing(dialect(other), { app: 'prueba' }).seal({ op: 'app' }, appVault.encPub)
  const pilarEnv = await seal({ type: 'vault.secrets', data: { ns: 'secreto' } }, transport.encPub)
  await client._deliver('t1', appEnv, {})
  await client._deliver('t2', pilarEnv, {})
  assert.deepEqual(got.map((g) => [g.from, g.payload, g.meta.sealed]), [
    ['t1', { op: 'app' }, true],
    ['t2', { type: 'vault.secrets', data: { ns: 'secreto' } }, true]
  ])
})

test('`pilar: true` sella con el sobre del pilar aunque haya sealing', async () => {
  const { client } = await both()
  const peer = await makeEncKeypair()
  const env = await client._seal({ type: 'vault.secrets.result', body: { ns: 'x' } }, peer.encPub, undefined, true)
  assert.ok(isSealed(env), 'sobre del pilar')
  assert.ok(!JSON.stringify(env).includes('vault.secrets.result'), 'nada en claro')
  assert.deepEqual(await open(env, peer.privateKey), { type: 'vault.secrets.result', body: { ns: 'x' } })
  const appEnv = await client._seal({ op: 'app' }, (await fakeVault()).encPub)
  assert.equal(isSealed(appEnv), false, 'sin `pilar`, el de la app, como siempre')
})

test('solo con sealing, un sobre del pilar no se abre: pasa tal cual, como antes', async () => {
  const appVault = await fakeVault()
  const client = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1', autoReconnect: false, sealing: identitySealing(dialect(appVault), { app: 'prueba' }) })
  const got = []
  const errors = []
  client.on('message', (_f, p) => got.push(p))
  client.on('error', (e) => errors.push(e))
  const t = await makeEncKeypair()
  await client._deliver('t', await seal({ a: 1 }, t.encPub), {})
  assert.equal(got.length, 1, 'como antes: no es suyo, pasa tal cual (sin abrir) y la app no lo reconoce')
  assert.equal(got[0].v, 1)
  assert.equal(errors.length, 0)
})
