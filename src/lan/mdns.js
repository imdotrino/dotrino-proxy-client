// DESCUBRIR EN LA RED LOCAL (docs/lan.md): anunciar y buscar `{kind, data}` por mDNS / DNS-SD,
// en JS puro sobre `dgram` y sin dependencias (la bóveda es un ejecutable único y un `.node` no
// entra). Es lo mismo que el `beacon` del Bluetooth, por otro medio: no abre ningún puerto (el
// puerto 9 del SRV es de mentira, nadie escucha ahí) y solo dice lo que se le pide anunciar.

const GROUP = '224.0.0.251'
const PORT = 5353
export const SERVICE = '_dotrino._tcp.local'
const META = '_services._dns-sd._udp.local'
const FAKE_PORT = 9
const TTL = 120
const CHUNK = 200
export const MAX_DATA = 512

const T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 }

/**
 * Un registro leído: PTR trae `ptr`, TXT trae `txt` y SRV trae `port`.
 * @typedef {{ name: string, type: number, ttl: number, ptr?: string, txt?: Map<string, string>, port?: number }} DnsRecord
 */
/** @typedef {{ name: string, type: number, unicast?: boolean }} DnsQuestion */
/**
 * El socket abierto y por qué interfaces sale.
 * @typedef {{ sock: import('node:dgram').Socket, addrs: string[], queue?: Promise<void> }} LanNet
 */

// ---------- el mensaje DNS (RFC 1035 + 6762) ----------

/** @param {string} name @returns {Buffer} */
function encodeName (name) {
  const parts = name.replace(/\.$/, '').split('.')
  /** @type {Buffer[]} */
  const bufs = []
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8')
    if (b.length > 63) throw new Error(`mdns: label too long: ${p}`)
    bufs.push(Buffer.from([b.length]), b)
  }
  bufs.push(Buffer.from([0]))
  return Buffer.concat(bufs)
}

/** @param {Buffer} buf @param {number} off @returns {{ name: string, end: number }} */
function decodeName (buf, off) {
  /** @type {string[]} */
  const labels = []
  let jumped = false
  let end = off
  for (let guard = 0; guard < 128; guard++) {
    if (off >= buf.length) throw new Error('mdns: name out of bounds')
    const len = buf[off]
    if (len === 0) { if (!jumped) end = off + 1; return { name: labels.join('.'), end } }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2
      off = ((len & 0x3f) << 8) | buf[off + 1]
      jumped = true
      continue
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len))
    off += 1 + len
  }
  throw new Error('mdns: name loop')
}

/**
 * @param {{ name: string, type: number, ttl?: number, flush?: boolean, rdata: Buffer }} r
 * @returns {Buffer}
 */
function rr ({ name, type, ttl = TTL, flush = false, rdata }) {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2)
  head.writeUInt32BE(ttl, 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), head, rdata])
}

/**
 * @param {{ response: boolean, questions?: DnsQuestion[], answers?: Buffer[] }} m
 * @returns {Buffer}
 */
function message ({ response, questions = [], answers = [] }) {
  const head = Buffer.alloc(12)
  head.writeUInt16BE(response ? 0x8400 : 0, 2)
  head.writeUInt16BE(questions.length, 4)
  head.writeUInt16BE(answers.length, 6)
  const qs = questions.map(({ name, type }) => {
    const t = Buffer.alloc(4)
    t.writeUInt16BE(type, 0)
    t.writeUInt16BE(1, 2)
    return Buffer.concat([encodeName(name), t])
  })
  return Buffer.concat([head, ...qs, ...answers])
}

/**
 * TXT: cada cadena es `clave=valor`, con su byte de largo delante (RFC 6763 §6).
 * @param {string} kind
 * @param {string} data
 * @returns {Buffer[]}
 */
export function txtEntries (kind, data) {
  const bytes = Buffer.from(String(data), 'utf8')
  if (bytes.length > MAX_DATA) throw Object.assign(new Error(`lan: at most ${MAX_DATA} bytes`), { code: 'too-big' })
  // Trozos de hasta 200 bytes, cortados entre caracteres enteros: cada trozo es UTF-8 válido
  // por sí solo (no se corta antes de un byte de continuación, 10xxxxxx).
  /** @type {Buffer[]} */
  const chunks = []
  for (let i = 0; i < bytes.length;) {
    let end = Math.min(i + CHUNK, bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(i, end))
    i = end
  }
  return [
    Buffer.from('v=1'),
    Buffer.from('k=' + kind),
    Buffer.from('n=' + chunks.length),
    ...chunks.map((c, i) => Buffer.concat([Buffer.from(`d${i}=`), c])),
  ]
}

/**
 * Lo contrario de `txtEntries`: `{kind, data}` o null si falta algo.
 * @param {Map<string, string>} map
 * @returns {{ kind: string, data: string } | null}
 */
export function fromTxt (map) {
  if (map.get('v') !== '1') return null
  const kind = map.get('k')
  const n = Number(map.get('n'))
  if (!kind || !Number.isInteger(n) || n < 0 || n > Math.ceil(MAX_DATA / (CHUNK - 3))) return null
  let data = ''
  for (let i = 0; i < n; i++) {
    const d = map.get('d' + i)
    if (d == null) return null
    data += d
  }
  return { kind, data }
}

/** @param {Buffer[]} entries @returns {Buffer} */
function txtRdata (entries) {
  return Buffer.concat(entries.flatMap((/** @type {Buffer} */ e) => [Buffer.from([e.length]), e]))
}

/** @param {Buffer} rdata @returns {Map<string, string>} */
function parseTxt (rdata) {
  /** @type {Map<string, string>} */
  const map = new Map()
  let off = 0
  while (off < rdata.length) {
    const len = rdata[off]
    const s = rdata.toString('utf8', off + 1, off + 1 + len)
    off += 1 + len
    const eq = s.indexOf('=')
    if (eq > 0 && !map.has(s.slice(0, eq).toLowerCase())) map.set(s.slice(0, eq).toLowerCase(), s.slice(eq + 1))
  }
  return map
}

/**
 * Lo justo para atender y buscar: preguntas y registros PTR / TXT / SRV / A.
 * @param {Buffer} buf
 * @returns {{ response: boolean, questions: DnsQuestion[], records: DnsRecord[] }}
 */
export function parseMessage (buf) {
  if (buf.length < 12) throw new Error('mdns: short message')
  const flags = buf.readUInt16BE(2)
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o))
  let off = 12
  /** @type {DnsQuestion[]} */
  const questions = []
  for (let i = 0; i < counts[0]; i++) {
    const { name, end } = decodeName(buf, off)
    questions.push({ name: name.toLowerCase(), type: buf.readUInt16BE(end), unicast: !!(buf.readUInt16BE(end + 2) & 0x8000) })
    off = end + 4
  }
  /** @type {DnsRecord[]} */
  const records = []
  const total = counts[1] + counts[2] + counts[3]
  for (let i = 0; i < total; i++) {
    const { name, end } = decodeName(buf, off)
    const type = buf.readUInt16BE(end)
    const ttl = buf.readUInt32BE(end + 4)
    const len = buf.readUInt16BE(end + 8)
    const start = end + 10
    if (start + len > buf.length) throw new Error('mdns: record out of bounds')
    /** @type {DnsRecord} */
    const rec = { name: name.toLowerCase(), type, ttl }
    if (type === T.PTR) rec.ptr = decodeName(buf, start).name
    else if (type === T.TXT) rec.txt = parseTxt(buf.subarray(start, start + len))
    else if (type === T.SRV) rec.port = buf.readUInt16BE(start + 4)
    records.push(rec)
    off = start + len
  }
  return { response: !!(flags & 0x8000), questions, records }
}

// ---------- el socket ----------

/** @param {typeof import('node:os')} os @returns {string[]} */
function interfaces (os) {
  /** @type {string[]} */
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    // `family` es un número en Node 18.0-18.3; el tipo actual solo dice la cadena.
    for (const a of list || []) if ((a.family === 'IPv4' || /** @type {unknown} */ (a.family) === 4) && !a.internal) out.push(a.address)
  }
  return out
}

/** @param {typeof import('node:crypto')} crypto @param {number} n @returns {string} */
function randomHex (crypto, n) { return crypto.randomBytes(n).toString('hex') }

/** @returns {Promise<LanNet>} */
async function openSocket () {
  const [{ default: dgram }, { default: os }] = await Promise.all([import('node:dgram'), import('node:os')])
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise(/** @param {(v?: void) => void} resolve @param {(e: Error) => void} reject */ (resolve, reject) => {
    sock.once('error', reject)
    sock.bind(PORT, () => { sock.off('error', reject); resolve() })
  }).catch((e) => {
    try { sock.close() } catch (_) {}
    const err = /** @type {{ code?: string, message?: string }} */ (e)
    throw Object.assign(new Error(`lan: cannot listen for mDNS (${err.code || err.message})`), { code: 'no-lan' })
  })
  const addrs = interfaces(os)
  sock.setMulticastTTL(255)
  sock.setMulticastLoopback(true)
  for (const a of addrs) { try { sock.addMembership(GROUP, a) } catch (_) {} }
  if (!addrs.length) { try { sock.addMembership(GROUP) } catch (_) {} }
  sock.on('error', () => {})
  // Anunciar o buscar no mantiene vivo el proceso: lo vivo es lo que lo usa (el daemon, la app).
  // Sin esto, una invitación que nadie cerró dejaba colgado al que la abrió al irse.
  sock.unref()
  return { sock, addrs }
}

/**
 * Manda a cada interfaz; `build(addr)` arma el mensaje con la dirección de esa interfaz. De una
 * en una: `send` sale cuando sale, y cambiar de interfaz antes de su callback manda todo por la
 * última (pasó: los anuncios salían por docker0 y la Mac de al lado no veía nada).
 *
 * @param {LanNet} net
 * @param {(addr: string | null) => Buffer} build
 * @returns {Promise<void>}
 */
function sendAll (net, build) {
  const targets = net.addrs.length ? net.addrs : [null]
  net.queue = (net.queue || Promise.resolve()).then(async () => {
    for (const a of targets) {
      await new Promise(/** @param {(v?: void) => void} resolve */ (resolve) => {
        try {
          if (a) net.sock.setMulticastInterface(a)
          net.sock.send(build(a), PORT, GROUP, () => resolve())
        } catch (_) { resolve() }
      })
    }
  })
  return net.queue
}

/**
 * Anuncia `{kind, data}` en la red local hasta que se llame a lo que devuelve. Contesta a quien
 * pregunte por `_dotrino._tcp` y se anuncia solo al empezar; al parar manda la despedida (TTL 0).
 * Lanza `no-lan` si aquí no se puede usar mDNS.
 * @param {string} kind
 * @param {string} data
 * @returns {Promise<() => void>}
 */
export async function announceLan (kind, data) {
  const { default: crypto } = await import('node:crypto')
  const net = await openSocket()
  const entries = txtEntries(kind, data)
  const id = randomHex(crypto, 8)
  const instance = `dotrino-${id}.${SERVICE}`
  const host = `dotrino-${id}.local`
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(FAKE_PORT, 4)
  /** @param {string | null} addr @param {number} ttl @returns {Buffer[]} */
  const records = (addr, ttl) => [
    rr({ name: SERVICE, type: T.PTR, ttl, rdata: encodeName(instance) }),
    rr({ name: instance, type: T.SRV, ttl, flush: true, rdata: Buffer.concat([srv, encodeName(host)]) }),
    rr({ name: instance, type: T.TXT, ttl, flush: true, rdata: txtRdata(entries) }),
    ...(addr ? [rr({ name: host, type: T.A, ttl, flush: true, rdata: Buffer.from(addr.split('.').map(Number)) })] : []),
  ]
  const announce = (ttl = TTL) => sendAll(net, (a) => message({ response: true, answers: records(a, ttl) }))
  const wanted = new Set([SERVICE, instance.toLowerCase(), host.toLowerCase()])
  net.sock.on('message', (/** @type {Buffer} */ buf) => {
    let m
    try { m = parseMessage(buf) } catch (_) { return }
    if (m.response) return
    if (m.questions.some((q) => q.name === META && (q.type === T.PTR || q.type === T.ANY))) {
      sendAll(net, () => message({ response: true, answers: [rr({ name: META, type: T.PTR, rdata: encodeName(SERVICE) })] }))
    }
    if (m.questions.some((q) => wanted.has(q.name))) announce()
  })
  announce()
  const again = setTimeout(() => announce(), 1000)
  again.unref?.()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearTimeout(again)
    announce(0)
    setTimeout(() => { try { net.sock.close() } catch (_) {} }, 50)
  }
}

/**
 * Lo que anuncian en la red local los aparatos con ese `kind`, durante `timeoutMs`. `onFound`
 * avisa de cada uno según aparece (una vez por `data`). Lanza `no-lan` si aquí no hay mDNS.
 * @param {{ kind?: string, timeoutMs?: number, onFound?: (b: { kind: string, data: string }) => void }} opts
 * @returns {Promise<{kind: string, data: string}[]>}
 */
export async function discoverLan ({ kind, timeoutMs = 8000, onFound } = /** @type {any} */ ({})) {
  const net = await openSocket()
  /** @type {Map<string, { kind: string, data: string }>} */
  const seen = new Map()
  /** @type {Set<string>} */
  const asked = new Set()
  /** @type {Array<{ kind: string, data: string }>} */
  const found = []
  /** @param {DnsQuestion[]} questions */
  const query = (questions) => sendAll(net, () => message({ response: false, questions }))
  net.sock.on('message', (/** @type {Buffer} */ buf) => {
    let m
    try { m = parseMessage(buf) } catch (_) { return }
    if (!m.response) return
    for (const r of m.records) {
      if (r.type === T.PTR && r.name === SERVICE && r.ttl > 0) {
        const inst = /** @type {string} */ (r.ptr).toLowerCase()
        if (!seen.has(inst) && !asked.has(inst)) {
          asked.add(inst)
          // Si el TXT no vino en el mismo paquete, se pregunta por él.
          if (!m.records.some((x) => x.type === T.TXT && x.name === inst)) query([{ name: inst, type: T.TXT }])
        }
      }
      if (r.type === T.TXT && r.name.endsWith('.' + SERVICE) && r.ttl > 0 && !seen.has(r.name)) {
        const got = fromTxt(/** @type {Map<string, string>} */ (r.txt))
        if (!got) continue
        seen.set(r.name, got)
        if (kind && got.kind !== kind) continue
        if (found.some((f) => f.data === got.data && f.kind === got.kind)) continue
        found.push(got)
        try { onFound?.(got) } catch (_) {}
      }
    }
  })
  const ask = () => query([{ name: SERVICE, type: T.PTR }])
  ask()
  const timers = [setTimeout(ask, 1000), setTimeout(ask, 3000)]
  const every = setInterval(ask, 5000)
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  timers.forEach(clearTimeout)
  clearInterval(every)
  try { net.sock.close() } catch (_) {}
  return found
}
