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
