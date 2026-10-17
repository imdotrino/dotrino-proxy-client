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
const memory = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
    clear: () => memory.clear()
  }
})

/** WebSocket falso: guarda lo enviado y deja al test hacer de servidor. */
export class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static last = null
  constructor (url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.sent = []
    this._listeners = new Map()
    FakeWebSocket.last = this
    queueMicrotask(() => this._fire('open', {}))
  }
  addEventListener (ev, fn) {
    if (!this._listeners.has(ev)) this._listeners.set(ev, new Set())
    this._listeners.get(ev).add(fn)
  }
  removeEventListener (ev, fn) { this._listeners.get(ev)?.delete(fn) }
  send (text) { this.sent.push(JSON.parse(text)) }
  close () { this.readyState = FakeWebSocket.CLOSED; this._fire('close', { code: 1000 }) }
  _fire (ev, detail) { for (const fn of this._listeners.get(ev) || []) fn(detail) }
  /** El "servidor" contesta. */
  reply (frame) { this._fire('message', { data: JSON.stringify(frame) }) }
  /** Lo último que mandó el cliente. */
  get lastSent () { return this.sent[this.sent.length - 1] }
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket })
