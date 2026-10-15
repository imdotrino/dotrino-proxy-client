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
import './_entorno.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketProxyClient } from '../src/index.js'

/**
 * Un WebSocket que solo abre cuando el test lo deja. `SocketFalso.abre = false` es la red
 * caída: el socket se crea, no abre, y cierra — igual que un ECONNREFUSED.
 */
class SocketFalso {
  static OPEN = 1
  static CLOSED = 3
  static abre = true
  static creados = []
  static get ultimo () { return SocketFalso.creados[SocketFalso.creados.length - 1] }

  constructor (url) {
    this.url = url
    this.readyState = SocketFalso.OPEN
    this._oyentes = new Map()
    SocketFalso.creados.push(this)
    queueMicrotask(() => {
      if (SocketFalso.abre) {
        this.disparar('open', {})
        // `connect()` no se resuelve al abrir el socket, sino con el saludo del proxio:
        // es el frame que trae el token de esta conexión.
        this.disparar('message', { data: JSON.stringify({ type: 'connected', token: 'TOK' + SocketFalso.creados.length }) })
        return
      }
      // Un socket que no puede conectar dispara `error` y DESPUÉS `close`, en ese orden:
      // es el `error` el que rechaza el `connect()` que esté esperando.
      this.readyState = SocketFalso.CLOSED
      this.disparar('error', new Error('connection refused'))
      this.disparar('close', { code: 1006, reason: 'connection refused' })
    })
  }
  addEventListener (ev, fn) {
    if (!this._oyentes.has(ev)) this._oyentes.set(ev, new Set())
    this._oyentes.get(ev).add(fn)
  }
  removeEventListener (ev, fn) { this._oyentes.get(ev)?.delete(fn) }
  send () {}
  close () { this.readyState = SocketFalso.CLOSED; this.disparar('close', { code: 1000 }) }
  disparar (ev, detalle) { for (const fn of this._oyentes.get(ev) || []) fn(detalle) }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

function conCliente (fn) {
  const antes = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: SocketFalso })
  SocketFalso.creados = []
  SocketFalso.abre = true
  return (async () => {
    try { return await fn() }
    finally { Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: antes }) }
  })()
}

test('la red se cae un rato: el cliente sigue intentándolo hasta que vuelve', async () => {
  await conCliente(async () => {
    const eventos = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    for (const e of ['connect', 'disconnect', 'reconnecting', 'reconnect_failed']) c.on(e, () => eventos.push(e))
    await c.connect()
    assert.equal(eventos[0], 'connect')

    // Se cae la red: el socket vivo cierra y los intentos siguientes NO abren.
    SocketFalso.abre = false
    SocketFalso.ultimo.disparar('close', { code: 1006, reason: 'network gone' })
    await esperar(250)

    // Lo que fallaba: aquí había UN solo `reconnecting` y el cliente estaba muerto.
    const intentos = eventos.filter((e) => e === 'reconnecting').length
    assert.ok(intentos >= 3, 'dejó de intentarlo: solo ' + intentos + ' intento(s) — ' + eventos.join(' '))

    // Vuelve la red, y el cliente tiene que estar dentro sin que nadie lo reinicie.
    SocketFalso.abre = true
    await esperar(200)
    assert.equal(c._connected, true, 'no volvió a entrar cuando la red volvió: ' + eventos.join(' '))
    c.close()
  })
})

test('un `connect()` inicial que falla NO deja un bucle de fondo: se rechaza y ya', async () => {
  await conCliente(async () => {
    SocketFalso.abre = false
    const eventos = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    c.on('reconnecting', () => eventos.push('reconnecting'))
    await c.connect().then(() => null, () => null)
    const creados = SocketFalso.creados.length
    await esperar(150)
    assert.equal(eventos.length, 0, 'se puso a reintentar una conexión que nunca existió')
    assert.equal(SocketFalso.creados.length, creados, 'abrió sockets por su cuenta')
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
  await conCliente(async () => {
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 10_000, maxReconnectAttempts: 50, enableHeartbeat: false
    })
    await c.connect()
    SocketFalso.abre = false
    SocketFalso.ultimo.disparar('close', { code: 1006, reason: 'network gone' })
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
  await conCliente(async () => {
    const eventos = []
    const c = new WebSocketProxyClient({
      url: 'wss://x', enableWebRTC: false, autoReconnect: true,
      reconnectDelay: 20, maxReconnectAttempts: 50, enableHeartbeat: false, connectTimeout: 60
    })
    for (const e of ['connect', 'reconnecting']) c.on(e, () => eventos.push(e))
    c.on('error', (e) => eventos.push('error:' + e.type))
    await c.connect()

    // El siguiente socket se crea y no hace NADA: ni abre ni falla.
    let colgar = true
    class SocketColgado {
      static OPEN = 1
      constructor () { this.readyState = 0; SocketFalso.creados.push(this) }
      addEventListener () {}
      close () {}
    }
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: new Proxy(SocketFalso, { construct: (T, args) => colgar ? new SocketColgado() : new T(...args) })
    })
    SocketFalso.ultimo.disparar('close', { code: 1006, reason: 'network gone' })
    await esperar(40)
    assert.equal(c._connected, false)

    // Ese socket colgado se abandona por tiempo, y el siguiente intento ya abre.
    colgar = false
    await esperar(250)
    assert.ok(eventos.includes('error:connect_timeout'), 'no abandonó el socket colgado: ' + eventos.join(' '))
    assert.equal(c._connected, true, 'se quedó esperando al socket colgado: ' + eventos.join(' '))
    c.close()
  })
})

test('un `connect()` inicial colgado se rechaza con CONNECT_TIMEOUT y no reintenta', async () => {
  await conCliente(async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class { static OPEN = 1; constructor () { this.readyState = 0 } addEventListener () {} close () {} }
    })
    const c = new WebSocketProxyClient({ url: 'wss://x', enableWebRTC: false, enableHeartbeat: false, connectTimeout: 30, reconnectDelay: 10 })
    let reintentos = 0
    c.on('reconnecting', () => reintentos++)
    // El tope va con `unref` (es mantenimiento de fondo) y el socket falso no tiene handle
    // de red: sin algo que mantenga vivo el proceso, el runner se va antes de que salte.
    const vivo = setInterval(() => {}, 1000)
    const err = await c.connect().then(() => null, (e) => e).finally(() => clearInterval(vivo))
    assert.equal(err?.code, 'CONNECT_TIMEOUT')
    await esperar(80)
    assert.equal(reintentos, 0)
    c.close()
  })
})
