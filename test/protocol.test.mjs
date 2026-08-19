/**
 * El protocolo pedido/respuesta contra un WebSocket falso.
 *
 * El test que importa es el primero, y sale de un fallo real: la 0.9.1 arregló
 * que «las respuestas de pair-code y pair-redeem no resolvían». La causa es
 * estructural: `_request(frame, expectedType)` deja la promesa colgada hasta que
 * llega un frame de ESE tipo, y los tipos que se despachan viven en un `switch`
 * de casos escritos a mano. Añadir una operación nueva y olvidar su `case` no
 * rompe nada visible — la promesa se queda esperando y muere de timeout a los
 * 10 s. Aquí se cruzan las dos listas para que no vuelva a pasar.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FakeWebSocket } from './_entorno.mjs'

const FUENTE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('todo expectedType de _request tiene su case en el despacho', () => {
  // Los tipos que alguien ESPERA: `_request(..., 'algo')`.
  const esperados = new Set(
    [...FUENTE.matchAll(/_request\([^)]*?,\s*'([^']+)'/gs)].map((m) => m[1])
  )
  // Los tipos que el switch SABE resolver.
  const cuerpo = FUENTE.slice(FUENTE.indexOf('_handleFrame'))
  const despachados = new Set(
    [...cuerpo.matchAll(/case '([^']+)':/g)].map((m) => m[1])
  )
  assert.ok(esperados.size >= 10, `se esperaban muchos tipos, se leyeron ${esperados.size}`)
  const huerfanos = [...esperados].filter((t) => !despachados.has(t))
  assert.deepEqual(
    huerfanos, [],
    `estas peticiones esperan una respuesta que el switch de _handleFrame no despacha, ` +
    `asi que su promesa nunca resuelve y muere de timeout a los 10 s: ${huerfanos.join(', ')}`
  )
})


const { WebSocketProxyClient } = await import('../src/client.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * Espera a que el cliente haya mandado un frame de este tipo, y lo devuelve.
 *
 * Un tick fijo no vale: publish/list/watch firman el canal antes de mandarlo, y
 * la PRIMERA firma ademas genera el par de llaves. Eso son varios turnos y algo
 * de criptografia de verdad, asi que el frame puede tardar. Un `await tick()` a
 * secas hacia que el test fallara solo la primera vez de cada proceso.
 */
async function esperaFrame (ws, tipo, ms = 3000) {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    const f = [...ws.enviados].reverse().find((x) => x.type === tipo)
    if (f) return f
    await tick()
  }
  throw new Error(`el cliente nunca mando un frame '${tipo}' (mando: ${ws.enviados.map((x) => x.type).join(', ') || 'nada'})`)
}

/** Cliente conectado a un socket falso, sin WebRTC ni heartbeat de por medio. */
async function conectado () {
  const c = new WebSocketProxyClient({
    url: 'wss://falso',
    enableWebRTC: false,
    enableHeartbeat: false,
    autoReconnect: false
  })
  const p = c.connect()
  await new Promise((r) => setTimeout(r, 0))
  FakeWebSocket.ultimo.responde({ type: 'connected', token: 'TOK1' })
  await p
  return { c, ws: FakeWebSocket.ultimo }
}

test('connect resuelve con el token que da el proxy', async () => {
  const { c } = await conectado()
  assert.equal(c.token, 'TOK1')
  assert.equal(c.isConnected, true)
  c.close()
})

test('cada peticion lleva su id y la respuesta resuelve por ese id', async () => {
  const { c, ws } = await conectado()
  const p = c.publish('sala-1', { nickname: 'ana' })
  const enviado = await esperaFrame(ws, 'publish')
  assert.equal(enviado.type, 'publish')
  assert.ok(enviado.id, 'sin id, la respuesta no se puede emparejar')
  ws.responde({ type: 'published', id: enviado.id })
  await p
  c.close()
})

test('una respuesta con OTRO id no resuelve la peticion', async () => {
  const { c, ws } = await conectado()
  let resuelta = false
  c.publish('sala-1').then(() => { resuelta = true }, () => {})
  await esperaFrame(ws, 'publish')
  ws.responde({ type: 'published', id: 'req_9999' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(resuelta, false, 'emparejar por tipo y no por id mezclaria peticiones concurrentes')
  c.close()
})

test('dos peticiones a la vez resuelven cada una la suya', async () => {
  const { c, ws } = await conectado()
  const a = c.publish('sala-a')
  const idA = (await esperaFrame(ws, 'publish')).id
  const b = c.publish('sala-b')
  await tick()
  const idB = ws.enviados.filter((x) => x.type === 'publish').at(-1).id
  assert.notEqual(idA, idB)
  ws.responde({ type: 'published', id: idB, channel: 'sala-b' })
  ws.responde({ type: 'published', id: idA, channel: 'sala-a' })
  assert.equal((await a).channel, 'sala-a')
  assert.equal((await b).channel, 'sala-b')
  c.close()
})

test('pair-code y pair-redeem resuelven (el fallo de la 0.9.1)', async () => {
  const { c, ws } = await conectado()
  const p1 = c.requestPairingCode({ ttlMs: 60000 })
  assert.equal(ws.ultimoEnviado.type, 'pair-code')
  assert.equal(ws.ultimoEnviado.ttlMs, 60000)
  ws.responde({ type: 'pair-code', id: ws.ultimoEnviado.id, code: 'C5AB12', expiresAt: 1, node: 'C5' })
  assert.equal((await p1).code, 'C5AB12')

  const p2 = c.redeemPairingCode('c5ab12')
  assert.equal(ws.ultimoEnviado.type, 'pair-redeem')
  ws.responde({ type: 'pair-redeem', id: ws.ultimoEnviado.id, ok: true, instance: 'X' })
  assert.equal((await p2).ok, true)
  c.close()
})

test('un frame de error rechaza la peticion, no la deja colgada', async () => {
  const { c, ws } = await conectado()
  const p = c.publish('sala-1')
  const enviado = await esperaFrame(ws, 'publish')
  ws.responde({ type: 'error', id: enviado.id, error: 'no autorizado' })
  await assert.rejects(p, /no autorizado/)
  c.close()
})

test('identify exige el sobre firmado', async () => {
  const { c, ws } = await conectado()
  assert.throws(() => c.identify({ data: { op: 'x' } }), /identify requires/)
  const p = c.identify({ data: { op: 'identify' }, signature: 'firma', cert: 'C', acta: 'A' })
  const m = ws.ultimoEnviado
  assert.equal(m.type, 'identify')
  assert.equal(m.cert, 'C')
  assert.equal(m.acta, 'A')
  ws.responde({ type: 'identified', id: m.id, queued_delivered: 3 })
  assert.equal((await p).queued_delivered, 3)
  c.close()
})

test('sendByPubkey solo marca ephemeral cuando se pide', async () => {
  const { c, ws } = await conectado()
  // Marcar de más manda a la cola offline de 24 h lo que caduca (una jugada,
  // una señalización WebRTC); marcar de menos descarta un chat que sí esperaba.
  c.sendByPubkey('PUB1', { hola: 1 })
  assert.equal(ws.ultimoEnviado.ephemeral, undefined)
  assert.deepEqual(ws.ultimoEnviado.to_publickey, ['PUB1'], 'una sola pubkey se normaliza a lista')

  c.sendByPubkey(['PUB1', 'PUB2'], { jugada: 'e4' }, { ephemeral: true })
  assert.equal(ws.ultimoEnviado.ephemeral, true)
  assert.deepEqual(ws.ultimoEnviado.to_publickey, ['PUB1', 'PUB2'])
  c.close()
})

test('sendByPubkey serializa el payload a texto, y no re-serializa una cadena', async () => {
  const { c, ws } = await conectado()
  c.sendByPubkey('PUB1', { a: 1 })
  assert.equal(ws.ultimoEnviado.message, '{"a":1}')
  c.sendByPubkey('PUB1', 'ya-es-texto')
  assert.equal(ws.ultimoEnviado.message, 'ya-es-texto')
  c.close()
})

test('sin conexion, una peticion rechaza en vez de quedarse esperando', async () => {
  const c = new WebSocketProxyClient({ url: 'wss://falso', enableWebRTC: false, enableHeartbeat: false, autoReconnect: false })
  await assert.rejects(c.publish('sala'), /not connected/i)
})

test('list devuelve los tokens, y una lista vacia si el proxy no manda ninguno', async () => {
  const { c, ws } = await conectado()
  const p = c.list('salas')
  const enviado = await esperaFrame(ws, 'list')
  assert.equal(enviado.channel.data.name, 'salas', 'el canal va firmado, no en claro')
  ws.responde({ type: 'channel_list', id: enviado.id, tokens: ['T1', 'T2'] })
  assert.deepEqual(await p, ['T1', 'T2'])

  // Un canal sin nadie debe dar [], no undefined: quien llama hace .map/.length
  // encima sin preguntar.
  const p2 = c.list('vacio')
  await tick()
  ws.responde({ type: 'channel_list', id: ws.enviados.filter((x) => x.type === 'list').at(-1).id })
  assert.deepEqual(await p2, [])
  c.close()
})

test('los handlers de on() no se pisan entre si ni rompen el cliente', async () => {
  const { c, ws } = await conectado()
  const vistos = []
  c.on('message', () => { throw new Error('un handler de app que revienta') })
  c.on('message', (from, msg) => vistos.push([from, msg]))
  ws.responde({ type: 'message', from: 'T9', message: JSON.stringify({ hola: 1 }) })
  await tick()
  assert.equal(vistos.length, 1, 'que un handler lance no puede dejar sin evento a los demas')
  assert.equal(vistos[0][0], 'T9')
  c.close()
})

test('close corta en seco lo que estaba en vuelo (no lo deja 10 s colgado)', async () => {
  const { c, ws } = await conectado()
  const p = c.publish('sala-1')
  await esperaFrame(ws, 'publish')
  c.close()
  // Sin esto, quien esperaba se comia los 10 s completos del timeout para
  // enterarse de algo que ya se sabia al cerrar; y en Node el temporizador
  // mantenia vivo el proceso ese rato.
  const e = await p.then(() => null, (err) => err)
  assert.ok(e, 'la promesa tiene que rechazar, no quedarse pendiente')
  assert.equal(e.code, 'CONNECTION_CLOSED')
})

test('los errores llevan `code`, que es por donde se comprueban', async () => {
  // Emparejar por la frase cruza procesos y se rompe en silencio al traducirla
  // o al reescribirla. El contrato es el `code`.
  const suelto = new WebSocketProxyClient({ url: 'wss://falso', enableWebRTC: false, enableHeartbeat: false, autoReconnect: false })
  const e1 = await suelto.publish('x').then(() => null, (err) => err)
  assert.equal(e1.code, 'NOT_CONNECTED')

  const { c, ws } = await conectado()
  const p = c.publish('sala-lenta')
  await esperaFrame(ws, 'publish')
  c.close()
  assert.equal((await p.then(() => null, (err) => err)).code, 'CONNECTION_CLOSED')
})
