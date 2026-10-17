/**
 * NO SE RINDE AL PRIMER REINTENTO FALLIDO.
 *
 * Es el fallo que dejó la bóveda del dueño fuera del proxio 36 HORAS, en silencio y con
 * `maxReconnectAttempts` en 100000: se cayó la red, el cliente programó UN reintento, ese
 * reintento tampoco encontró al servidor —la red seguía mal, que es lo normal a los pocos
 * segundos— y ahí se acabó. Nunca volvió a intentarlo y nunca lo dijo.
 *
 * La causa: un socket que falla al CONECTAR cierra con `_connected` en false, y el guard
 * era `wasConnected && autoReconnect`. O sea que solo se reintentaba la caída de una
 * conexión que había llegado a abrirse; el reintento fallido no contaba como nada.
 *
 * Los eventos que se veían: `disconnect reconnecting#1 disconnect` y nada más.
 */
import './_env.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'

/**
 * Un WebSocket que solo abre cuando el test lo deja. `SocketFalso.abre = false` es la red
 * caída: el socket se crea, no abre, y cierra — igual que un ECONNREFUSED.
 */
class FakeSocket {
  static OPEN = 1
  static CLOSED = 3
  static opens = true
  static created = []
  static get last () { return FakeSocket.created[FakeSocket.created.length - 1] }

  constructor (url) {
    this.url = url
    this.readyState = FakeSocket.OPEN
    this._listeners = new Map()
    FakeSocket.created.push(this)
    queueMicrotask(() => {
      if (FakeSocket.opens) {
        this.fire('open', {})
        // `connect()` no se resuelve al abrir el socket, sino con el saludo del proxio:
        // es el frame que trae el token de esta conexión.
        this.fire('message', { data: JSON.stringify({ type: 'connected', token: 'TOK' + FakeSocket.created.length }) })
        return
      }
      // Un socket que no puede conectar dispara `error` y DESPUÉS `close`, en ese orden:
      // es el `error` el que rechaza el `connect()` que esté esperando.
      this.readyState = FakeSocket.CLOSED
      this.fire('error', new Error('connection refused'))
      this.fire('close', { code: 1006, reason: 'connection refused' })
    })
  }
  addEventListener (ev, fn) {
    if (!this._listeners.has(ev)) this._listeners.set(ev, new Set())
    this._listeners.get(ev).add(fn)
  }
  removeEventListener (ev, fn) { this._listeners.get(ev)?.delete(fn) }
  send () {}
  close () { this.readyState = FakeSocket.CLOSED; this.fire('close', { code: 1000 }) }
  fire (ev, detail) { for (const fn of this._listeners.get(ev) || []) fn(detail) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function withClient (fn) {
  const antes = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket })
  FakeSocket.created = []
  FakeSocket.opens = true
  return (async () => {
    try { return await fn() }
    finally { Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: antes }) }
  })()
}

test('la red se cae un rato: el cliente sigue intentándolo hasta que vuelve', async () => {
  await withClient(async () => {
    const events = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    for (const e of ['connect', 'disconnect', 'reconnecting', 'reconnect_failed']) c.on(e, () => events.push(e))
    await c.connect()
    assert.equal(events[0], 'connect')

    // Se cae la red: el socket vivo cierra y los intentos siguientes NO abren.
    FakeSocket.opens = false
    FakeSocket.last.fire('close', { code: 1006, reason: 'network gone' })
    await wait(250)

    // Lo que fallaba: aquí había UN solo `reconnecting` y el cliente estaba muerto.
    const attempts = events.filter((e) => e === 'reconnecting').length
    assert.ok(attempts >= 3, 'dejó de intentarlo: solo ' + attempts + ' intento(s) — ' + events.join(' '))

    // Vuelve la red, y el cliente tiene que estar dentro sin que nadie lo reinicie.
    FakeSocket.opens = true
    await wait(200)
    assert.equal(c._connected, true, 'no volvió a entrar cuando la red volvió: ' + events.join(' '))
    c.close()
  })
})

test('un `connect()` inicial que falla NO deja un bucle de fondo: se rechaza y ya', async () => {
  await withClient(async () => {
    FakeSocket.opens = false
    const events = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    c.on('reconnecting', () => events.push('reconnecting'))
    await c.connect().then(() => null, () => null)
    const created = FakeSocket.created.length
    await wait(150)
    assert.equal(events.length, 0, 'se puso a reintentar una conexión que nunca existió')
    assert.equal(FakeSocket.created.length, created, 'abrió sockets por su cuenta')
    c.close()
  })
})

/**
 * Y REINTENTAR NO PUEDE DEJAR COLGADO A QUIEN NO CIERRA.
 *
 * Desde que se reintenta de verdad, el temporizador del siguiente intento basta para que un
 * programa de Node que se olvidó de cerrar el cliente no termine NUNCA. Pasó en cuanto se
 * arregló lo de arriba: la suite del vault se quedó colgada en un e2e que apaga su proxio.
 */
test('el temporizador del reintento no mantiene vivo el proceso', async () => {
  await withClient(async () => {
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 10_000, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    await c.connect()
    FakeSocket.opens = false
    FakeSocket.last.fire('close', { code: 1006, reason: 'network gone' })
    assert.ok(c._reconnectTimer, 'no programó ningún reintento')
    // En el navegador no hay `hasRef`; ahí tampoco hay proceso que colgar.
    assert.equal(c._reconnectTimer.hasRef?.(), false, 'el reintento pendiente sujeta el proceso')
    c.close()
  })
})

/**
 * EL SOCKET QUE NO ABRE NI FALLA.
 *
 * La bóveda de Dotrino se quedó fuera del proxio hora y media el 2026-10-15: el latido la
 * dio por muerta, el reintento creó un socket nuevo y ese socket no disparó nunca `open`,
 * `error` ni `close` — el saludo del upgrade no llegó. Como el siguiente reintento solo se
 * programa desde esos eventos, la cadena se paró ahí, sin una línea en el log.
 */
test('un reintento que se queda colgado al abrir se abandona y se vuelve a intentar', async () => {
  await withClient(async () => {
    const events = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false, connectTimeout: 60
    })
    for (const e of ['connect', 'reconnecting']) c.on(e, () => events.push(e))
    c.on('error', (e) => events.push('error:' + e.type))
    await c.connect()

    // El siguiente socket se crea y no hace NADA: ni abre ni falla.
    let hang = true
    class HangingSocket {
      static OPEN = 1
      constructor () { this.readyState = 0; FakeSocket.created.push(this) }
      addEventListener () {}
      close () {}
    }
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: new Proxy(FakeSocket, { construct: (T, args) => hang ? new HangingSocket() : new T(...args) })
    })
    FakeSocket.last.fire('close', { code: 1006, reason: 'network gone' })
    await wait(40)
    assert.equal(c._connected, false)

    // Ese socket colgado se abandona por tiempo, y el siguiente intento ya abre.
    hang = false
    await wait(250)
    assert.ok(events.includes('error:connect_timeout'), 'no abandonó el socket colgado: ' + events.join(' '))
    assert.equal(c._connected, true, 'se quedó esperando al socket colgado: ' + events.join(' '))
    c.close()
  })
})

test('un `connect()` inicial colgado se rechaza con CONNECT_TIMEOUT y no reintenta', async () => {
  await withClient(async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class { static OPEN = 1; constructor () { this.readyState = 0 } addEventListener () {} close () {} }
    })
    const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, enableHeartbeat: false, connectTimeout: 30, reconnectDelay: 10 })
    let retries = 0
    c.on('reconnecting', () => retries++)
    // El tope va con `unref` (es mantenimiento de fondo) y el socket falso no tiene handle
    // de red: sin algo que mantenga vivo el proceso, el runner se va antes de que salte.
    const alive = setInterval(() => {}, 1000)
    const err = await c.connect().then(() => null, (e) => e).finally(() => clearInterval(alive))
    assert.equal(err?.code, 'CONNECT_TIMEOUT')
    await wait(80)
    assert.equal(retries, 0)
    c.close()
  })
})
