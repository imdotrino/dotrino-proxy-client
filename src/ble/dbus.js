/**
 * UN CLIENTE D-BUS MÍNIMO, sin dependencias, para hablar con BlueZ (`bluez.js`).
 *
 * Por qué uno propio: los de npm arrastran dependencias viejas (`event-stream`, que ya tuvo
 * un ataque de cadena de suministro) o tienen releases recientes y sin explicar tras años
 * quietos. Y la bóveda se distribuye como un ejecutable único (SEA): un módulo nativo no
 * entra. D-Bus no es un protocolo del ecosistema; esto no reimplementa nada nuestro.
 *
 * Lo justo para BlueZ: autenticación EXTERNAL, llamadas, respuestas, errores, señales,
 * exportar objetos (BlueZ nos llama para el GATT) y los tipos que BlueZ usa. Solo
 * little-endian al escribir; al leer, los dos.
 */

const TYPE_CALL = 1
const TYPE_RETURN = 2
const TYPE_ERROR = 3
const TYPE_SIGNAL = 4
const FLAG_NO_REPLY = 1

const F_PATH = 1
const F_INTERFACE = 2
const F_MEMBER = 3
const F_ERROR = 4
const F_REPLY_SERIAL = 5
const F_DESTINATION = 6
const F_SENDER = 7
const F_SIGNATURE = 8

/** Un valor con su tipo, para los `v` (variante). */
export class Variant {
  constructor (sig, value) { this.sig = sig; this.value = value }
}
export const variant = (sig, value) => new Variant(sig, value)

export class DBusError extends Error {
  constructor (name, message) { super(`${name}: ${message || ''}`); this.name = 'DBusError'; this.dbusName = name; this.code = 'dbus-error' }
}

// ---------- firmas ----------

/** Parte una firma en tipos completos: 'sa{sv}as' → ['s', 'a{sv}', 'as']. */
export function splitSig (sig) {
  const out = []
  let i = 0
  while (i < sig.length) { const end = typeEnd(sig, i); out.push(sig.slice(i, end)); i = end }
  return out
}

function typeEnd (sig, i) {
  const c = sig[i]
  if (c === 'a') return typeEnd(sig, i + 1)
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}'
    let depth = 0
    for (let j = i; j < sig.length; j++) {
      if (sig[j] === c) depth++
      else if (sig[j] === close && --depth === 0) return j + 1
    }
    throw new Error('dbus: bad signature ' + sig)
  }
  return i + 1
}

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1, h: 4 }

// ---------- escribir ----------

class Writer {
  constructor () { this.buf = new Uint8Array(256); this.view = new DataView(this.buf.buffer); this.pos = 0 }
  room (n) {
    if (this.pos + n <= this.buf.length) return
    let len = this.buf.length * 2
    while (len < this.pos + n) len *= 2
    const b = new Uint8Array(len); b.set(this.buf); this.buf = b; this.view = new DataView(b.buffer)
  }
  align (n) { const p = (n - (this.pos % n)) % n; this.room(p); this.pos += p }
  u8 (v) { this.room(1); this.buf[this.pos++] = v }
  u16 (v) { this.align(2); this.room(2); this.view.setUint16(this.pos, v, true); this.pos += 2 }
  i16 (v) { this.align(2); this.room(2); this.view.setInt16(this.pos, v, true); this.pos += 2 }
  u32 (v) { this.align(4); this.room(4); this.view.setUint32(this.pos, v, true); this.pos += 4 }
  i32 (v) { this.align(4); this.room(4); this.view.setInt32(this.pos, v, true); this.pos += 4 }
  u64 (v) { this.align(8); this.room(8); this.view.setBigUint64(this.pos, BigInt(v), true); this.pos += 8 }
  i64 (v) { this.align(8); this.room(8); this.view.setBigInt64(this.pos, BigInt(v), true); this.pos += 8 }
  f64 (v) { this.align(8); this.room(8); this.view.setFloat64(this.pos, v, true); this.pos += 8 }
  bytes (b) { this.room(b.length); this.buf.set(b, this.pos); this.pos += b.length }
  str (s) { const b = new TextEncoder().encode(s); this.u32(b.length); this.bytes(b); this.u8(0) }
  sig (s) { const b = new TextEncoder().encode(s); this.u8(b.length); this.bytes(b); this.u8(0) }
  result () { return this.buf.slice(0, this.pos) }

  write (sig, v) {
    const c = sig[0]
    switch (c) {
      case 'y': return this.u8(v)
      case 'b': return this.u32(v ? 1 : 0)
      case 'n': return this.i16(v)
      case 'q': return this.u16(v)
      case 'i': return this.i32(v)
      case 'u': case 'h': return this.u32(v)
      case 'x': return this.i64(v)
      case 't': return this.u64(v)
      case 'd': return this.f64(v)
      case 's': case 'o': return this.str(String(v))
      case 'g': return this.sig(String(v))
      case 'v': {
        if (!(v instanceof Variant)) throw new Error('dbus: a variant needs variant(sig, value)')
        this.sig(v.sig)
        return this.write(v.sig, v.value)
      }
      case '(': {
        this.align(8)
        const inner = splitSig(sig.slice(1, -1))
        inner.forEach((t, k) => this.write(t, v[k]))
        return
      }
      case 'a': {
        const elem = sig.slice(1)
        this.u32(0)
        const lenAt = this.pos - 4
        this.align(ALIGN[elem[0]])
        const start = this.pos
        if (elem === 'y') {
          this.bytes(v instanceof Uint8Array ? v : Uint8Array.from(v))
        } else if (elem[0] === '{') {
          const [kt, vt] = splitSig(elem.slice(1, -1))
          const entries = v instanceof Map ? [...v] : Object.entries(v)
          for (const [k, val] of entries) { this.align(8); this.write(kt, k); this.write(vt, val) }
        } else {
          for (const item of v) this.write(elem, item)
        }
        this.view.setUint32(lenAt, this.pos - start, true)
        return
      }
      default: throw new Error('dbus: type not supported: ' + c)
    }
  }
}

// ---------- leer ----------

class Reader {
  constructor (bytes, little, base = 0) {
    this.buf = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.le = little; this.pos = base
  }
  align (n) { this.pos += (n - (this.pos % n)) % n }
  u8 () { return this.buf[this.pos++] }
  read (sig) {
    const c = sig[0]
    const v = this.view
    switch (c) {
      case 'y': return this.u8()
      case 'b': this.align(4); this.pos += 4; return v.getUint32(this.pos - 4, this.le) !== 0
      case 'n': this.align(2); this.pos += 2; return v.getInt16(this.pos - 2, this.le)
      case 'q': this.align(2); this.pos += 2; return v.getUint16(this.pos - 2, this.le)
      case 'i': this.align(4); this.pos += 4; return v.getInt32(this.pos - 4, this.le)
      case 'u': case 'h': this.align(4); this.pos += 4; return v.getUint32(this.pos - 4, this.le)
      case 'x': this.align(8); this.pos += 8; return Number(v.getBigInt64(this.pos - 8, this.le))
      case 't': this.align(8); this.pos += 8; return Number(v.getBigUint64(this.pos - 8, this.le))
      case 'd': this.align(8); this.pos += 8; return v.getFloat64(this.pos - 8, this.le)
      case 's': case 'o': {
        this.align(4)
        const len = v.getUint32(this.pos, this.le); this.pos += 4
        const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len)); this.pos += len + 1
        return s
      }
      case 'g': {
        const len = this.u8()
        const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len)); this.pos += len + 1
        return s
      }
      case 'v': { const s = this.read('g'); return new Variant(s, this.read(s)) }
      case '(': { this.align(8); return splitSig(sig.slice(1, -1)).map((t) => this.read(t)) }
      case 'a': {
        this.align(4)
        const len = v.getUint32(this.pos, this.le); this.pos += 4
        const elem = sig.slice(1)
        this.align(ALIGN[elem[0]])
        const end = this.pos + len
        if (elem === 'y') { const b = this.buf.slice(this.pos, end); this.pos = end; return b }
        if (elem[0] === '{') {
          const [kt, vt] = splitSig(elem.slice(1, -1))
          const out = {}
          while (this.pos < end) { this.align(8); const k = this.read(kt); out[k] = this.read(vt) }
          return out
        }
        const out = []
        while (this.pos < end) out.push(this.read(elem))
        return out
      }
      default: throw new Error('dbus: type not supported: ' + c)
    }
  }
}

/** Saca el valor de las variantes, recursivo: lo que BlueZ manda en a{sv} queda en plano. */
export function plain (v) {
  if (v instanceof Variant) return plain(v.value)
  if (v instanceof Uint8Array) return v
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o }
  return v
}

// ---------- mensajes ----------

export function encodeMessage ({ type, flags = 0, serial, path, iface, member, error, replySerial, destination, signature = '', body = [] }) {
  const bw = new Writer()
  const types = signature ? splitSig(signature) : []
  types.forEach((t, k) => bw.write(t, body[k]))
  const bodyBytes = bw.result()
  const fields = []
  if (path) fields.push([F_PATH, variant('o', path)])
  if (iface) fields.push([F_INTERFACE, variant('s', iface)])
  if (member) fields.push([F_MEMBER, variant('s', member)])
  if (error) fields.push([F_ERROR, variant('s', error)])
  if (replySerial != null) fields.push([F_REPLY_SERIAL, variant('u', replySerial)])
  if (destination) fields.push([F_DESTINATION, variant('s', destination)])
  if (signature) fields.push([F_SIGNATURE, variant('g', signature)])
  const hw = new Writer()
  hw.u8(0x6c); hw.u8(type); hw.u8(flags); hw.u8(1)
  hw.u32(bodyBytes.length); hw.u32(serial)
  hw.write('a(yv)', fields)
  hw.align(8)
  const head = hw.result()
  const out = new Uint8Array(head.length + bodyBytes.length)
  out.set(head); out.set(bodyBytes, head.length)
  return out
}

/** Lee un mensaje completo del principio de `buf`. Devuelve `{ msg, size }` o null si falta. */
export function decodeMessage (buf) {
  if (buf.length < 16) return null
  const little = buf[0] === 0x6c
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const bodyLen = view.getUint32(4, little)
  const fieldsLen = view.getUint32(12, little)
  const headEnd = 16 + fieldsLen
  const bodyStart = headEnd + ((8 - (headEnd % 8)) % 8)
  const size = bodyStart + bodyLen
  if (buf.length < size) return null
  const r = new Reader(buf.subarray(0, size), little, 12)
  const fields = r.read('a(yv)')
  const f = {}
  for (const [code, v] of fields) f[code] = v.value
  const msg = {
    type: buf[1], flags: buf[2], serial: view.getUint32(8, little),
    path: f[F_PATH], iface: f[F_INTERFACE], member: f[F_MEMBER], error: f[F_ERROR],
    replySerial: f[F_REPLY_SERIAL], destination: f[F_DESTINATION], sender: f[F_SENDER],
    signature: f[F_SIGNATURE] || '', body: [],
  }
  if (msg.signature) {
    const br = new Reader(buf.subarray(bodyStart, size), little, 0)
    msg.body = splitSig(msg.signature).map((t) => br.read(t))
  }
  return { msg, size }
}

// ---------- conexión ----------

export class DBusConnection {
  /** @param {any} socket  un socket de `node:net` ya conectado al bus */
  constructor (socket) {
    this.socket = socket
    /** @type {string|null} el nombre único en el bus (`Hello`) */
    this.name = null
    this.serial = 1
    this.pending = new Map()
    this.objects = new Map()      // path -> { iface -> { method(args, msg) -> { signature, body } } }
    this.signalHandlers = new Set()
    this.buf = new Uint8Array(0)
    this.closed = false
    this.onClose = null
    socket.on('data', (d) => this._data(d))
    socket.on('close', () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new DBusError('org.freedesktop.DBus.Error.Disconnected', 'bus closed'))
      this.pending.clear()
      this.onClose?.()
    })
  }

  /** Llama a un método y espera su respuesta. Devuelve el cuerpo (array). */
  call ({ destination, path, iface, member, signature = '', body = [] }) {
    const serial = this.serial++
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject })
      this._send({ type: TYPE_CALL, serial, destination, path, iface, member, signature, body })
    })
  }

  signal ({ path, iface, member, signature = '', body = [] }) {
    this._send({ type: TYPE_SIGNAL, serial: this.serial++, path, iface, member, signature, body })
  }

  /** Exporta un objeto: `handlers[iface][member] = async (args, msg) => ({ signature, body })`. */
  export (path, handlers) { this.objects.set(path, handlers) }
  unexport (path) { this.objects.delete(path) }

  onSignal (fn) { this.signalHandlers.add(fn); return () => this.signalHandlers.delete(fn) }

  async addMatch (rule) {
    await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] })
  }

  close () { try { this.socket.end() } catch (_) {} }

  _send (m) {
    if (this.closed) throw new DBusError('org.freedesktop.DBus.Error.Disconnected', 'bus closed')
    this.socket.write(encodeMessage(m))
  }

  _data (chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length)
    b.set(this.buf); b.set(chunk, this.buf.length)
    this.buf = b
    for (;;) {
      const r = decodeMessage(this.buf)
      if (!r) break
      this.buf = this.buf.slice(r.size)
      this._dispatch(r.msg)
    }
  }

  _dispatch (msg) {
    if (msg.type === TYPE_RETURN || msg.type === TYPE_ERROR) {
      const p = this.pending.get(msg.replySerial)
      if (!p) return
      this.pending.delete(msg.replySerial)
      if (msg.type === TYPE_RETURN) p.resolve(msg.body)
      else p.reject(new DBusError(msg.error, msg.body[0]))
      return
    }
    if (msg.type === TYPE_SIGNAL) { for (const h of this.signalHandlers) { try { h(msg) } catch (_) {} } return }
    if (msg.type === TYPE_CALL) this._incomingCall(msg)
  }

  async _incomingCall (msg) {
    const reply = (m) => { if (!(msg.flags & FLAG_NO_REPLY)) this._send({ ...m, serial: this.serial++, replySerial: msg.serial, destination: msg.sender }) }
    const obj = this.objects.get(msg.path)
    const fn = obj?.[msg.iface]?.[msg.member]
    if (!fn) {
      return reply({ type: TYPE_ERROR, error: 'org.freedesktop.DBus.Error.UnknownMethod', signature: 's', body: [`no ${msg.iface}.${msg.member} at ${msg.path}`] })
    }
    try {
      const r = (await fn(msg.body, msg)) || {}
      reply({ type: TYPE_RETURN, signature: r.signature || '', body: r.body || [] })
    } catch (e) {
      reply({ type: TYPE_ERROR, error: e.dbusName || 'org.bluez.Error.Failed', signature: 's', body: [String(e.message || e)] })
    }
  }
}

/**
 * Abre el bus del SISTEMA (donde vive BlueZ). `null` si no hay bus en esta máquina: eso no es
 * un fallo, es una máquina sin BlueZ. Si hay bus y no deja entrar, lanza.
 */
export async function openSystemBus () {
  const netMod = 'node:net'
  const fsMod = 'node:fs'
  const net = await import(netMod)
  const fs = await import(fsMod)
  const addr = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/var/run/dbus/system_bus_socket'
  const m = /unix:path=([^,;]+)/.exec(addr)
  if (!m || !fs.existsSync(m[1])) return null
  const socket = net.createConnection(m[1])
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const uid = String(process.getuid())
  const hex = [...uid].map((c) => c.charCodeAt(0).toString(16)).join('')
  const line = await new Promise((resolve, reject) => {
    let got = ''
    const onData = (d) => {
      got += d.toString('latin1')
      if (got.includes('\r\n')) { socket.off('data', onData); resolve(got) }
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.write('\0AUTH EXTERNAL ' + hex + '\r\n')
  })
  if (!line.startsWith('OK')) { socket.destroy(); throw new DBusError('org.freedesktop.DBus.Error.AuthFailed', line.trim()) }
  socket.write('BEGIN\r\n')
  const conn = new DBusConnection(socket)
  const [name] = await conn.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'Hello' })
  conn.name = name
  return conn
}
