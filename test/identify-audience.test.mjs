/**
 * PARA QUIÉN va el `identify`, y por qué el sobre se arma AQUÍ.
 *
 * Lo firmaban doce repos por su cuenta, cada uno con su copia de
 * `{op:'identify', publickey, token, ts}`. Añadirle el destinatario en doce sitios es
 * garantizar que uno se queda sin él — y quien escriba el trece lo copiará del que vea.
 */
import './_env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

/** Un cliente ya "conectado", sin red: se mira lo que manda. */
function client (url = 'wss://proxy.dotrino.com') {
  const c = new WebSocketProxyClient({ url, autoReconnect: false })
  const sentMsg = []
  c.token = 'TOK123'
  c._request = (msg) => { sentMsg.push(msg); return Promise.resolve({ type: 'identified' }) }
  return { c, sentMsg }
}

test('el identify dice para quién es, y sale de la URL del proxio', async () => {
  const { c, sentMsg } = client()
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  const { data, signature } = sentMsg[0]
  assert.equal(data.op, 'identify')
  assert.equal(data.aud, 'wss://proxy.dotrino.com')
  assert.equal(data.publickey, 'PK')
  assert.equal(data.token, 'TOK123', 'el token de ESTA conexión: es el reto que puso el proxio')
  assert.equal(typeof data.ts, 'number')
  assert.equal(signature, 'firma')
})

test('levantar tu propio proxio cambia el destinatario', async () => {
  const { c, sentMsg } = client('wss://proxy.miempresa.com/')
  await c.identifyAs({ publickey: 'PK', sign: async () => 'firma' })
  assert.equal(sentMsg[0].data.aud, 'wss://proxy.miempresa.com', 'sin la barra final')
})

test('acepta el paquete del vault, no solo la firma suelta', async () => {
  const { c, sentMsg } = client()
  await c.identifyAs({ publickey: 'PK', sign: async () => ({ signature: 'firma', publickey: 'PK', chain: [] }) })
  assert.equal(sentMsg[0].signature, 'firma')
})

test('sin con qué firmar, sin llave o sin conexión, no se inventa nada', async () => {
  const { c } = client()
  await assert.rejects(() => c.identifyAs({ publickey: 'PK' }), /sign/)
  await assert.rejects(() => c.identifyAs({ sign: async () => 'x' }), /publickey/)
  const noToken = new WebSocketProxyClient({ url: 'wss://x', autoReconnect: false })
  await assert.rejects(() => noToken.identifyAs({ publickey: 'PK', sign: async () => 'x' }), /token/)
})

test('una firma que no devuelve firma se para, y se distingue de un fallo de red', async () => {
  const { c } = client()
  await assert.rejects(
    () => c.identifyAs({ publickey: 'PK', sign: async () => ({ noSignature: true }) }),
    (e) => e.code === 'no-signature',
    'por el `code`: la bóveda decide con esto si su llave de comunicación sigue firmando'
  )
})
