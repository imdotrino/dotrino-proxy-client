/**
 * Lo que el paquete da por hecho del navegador y en Node no está.
 *
 * OJO con `localStorage`: Node SÍ define `globalThis.localStorage`, pero sin
 * `--localstorage-file` el objeto que devuelve no tiene `getItem`. O sea que
 * `typeof localStorage !== 'undefined'` —la comprobación que hace signature.js—
 * pasa, y luego revienta al llamarlo. Por eso se instala con defineProperty:
 * asignarlo a secas va contra el setter de Node y no lo reemplaza.
 *
 * Importar este módulo ANTES que nada de `src/`: signature.js cachea el par de
 * llaves en cuanto se usa.
 */
const memoria = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (memoria.has(k) ? memoria.get(k) : null),
    setItem: (k, v) => memoria.set(k, String(v)),
    removeItem: (k) => memoria.delete(k),
    clear: () => memoria.clear()
  }
})

/** WebSocket falso: guarda lo enviado y deja al test hacer de servidor. */
export class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static ultimo = null
  constructor (url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.enviados = []
    this._oyentes = new Map()
    FakeWebSocket.ultimo = this
    queueMicrotask(() => this._disparar('open', {}))
  }
  addEventListener (ev, fn) {
    if (!this._oyentes.has(ev)) this._oyentes.set(ev, new Set())
    this._oyentes.get(ev).add(fn)
  }
  removeEventListener (ev, fn) { this._oyentes.get(ev)?.delete(fn) }
  send (texto) { this.enviados.push(JSON.parse(texto)) }
  close () { this.readyState = FakeWebSocket.CLOSED; this._disparar('close', { code: 1000 }) }
  _disparar (ev, detalle) { for (const fn of this._oyentes.get(ev) || []) fn(detalle) }
  /** El "servidor" contesta. */
  responde (frame) { this._disparar('message', { data: JSON.stringify(frame) }) }
  /** Lo último que mandó el cliente. */
  get ultimoEnviado () { return this.enviados[this.enviados.length - 1] }
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket })
