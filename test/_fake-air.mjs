// Aire falso para probar el escalón del Bluetooth sin radio: varios adaptadores que se ven
// entre sí y cumplen el contrato de `src/ble/manager.js`.
import { HELLO_UUID, BEACON_UUID } from '../src/ble/wire.js'

export class FakeAir {
  /** `broadcast`: cada notificación llega a TODOS los centrales suscritos, como en BlueZ. */
  /** `slowStop`: parar una búsqueda tarda, y empezar otra mientras tanto falla como en BlueZ (`InProgress`). */
  constructor ({ mtu = 23, broadcast = false, slowStop = 0 } = {}) {
    this.mtu = mtu
    this.broadcast = broadcast
    this.slowStop = slowStop
    this.devices = new Map()
    this.scanners = new Set()
  }

  adapter (id) { return new FakeAdapter(this, id) }
}

class FakeAdapter {
  constructor (air, id) {
    this.air = air
    this.id = id
    this.server = null
    this.links = new Map()   // centralId -> link (lado periférico)
    this.nextLink = 0
  }

  async start (server) {
    this.server = server
    this.air.devices.set(this.id, this)
    for (const s of this.air.scanners) if (s.owner !== this) setTimeout(() => s.onFound({ id: this.id }), 1)
  }

  async stop () {
    this.air.devices.delete(this.id)
    for (const [cid, l] of [...this.links]) await l.close()
  }

  chunkFor () { return this.air.mtu - 3 }

  async drop (centralId) { await this.links.get(centralId)?.close() }

  async notify (centralId, bytes) {
    const l = this.links.get(centralId)
    if (!l) throw new Error('fake: no such central')
    await Promise.resolve()
    for (const to of this.air.broadcast ? [...this.links.values()] : [l]) to.onValue?.(new Uint8Array(bytes))
  }

  async scan (onFound) {
    if (this.stopping) throw Object.assign(new Error('org.bluez.Error.InProgress: Operation already in progress'), { code: 'dbus-error' })
    const s = { owner: this, onFound }
    this.air.scanners.add(s)
    for (const d of this.air.devices.values()) if (d !== this) setTimeout(() => onFound({ id: d.id }), 1)
    return async () => {
      this.air.scanners.delete(s)
      if (!this.air.slowStop) return
      this.stopping = true
      await new Promise((resolve) => setTimeout(resolve, this.air.slowStop))
      this.stopping = false
    }
  }

  async connect (dev) {
    const target = this.air.devices.get(dev.id)
    if (!target) throw new Error('fake: device gone')
    const centralId = `${this.id}#${this.nextLink++}`
    let closed = false
    const link = {
      chunk: this.air.mtu - 3,
      onValue: null,
      _onClose: null,
      read: async (uuid) => uuid === HELLO_UUID ? target.server.hello() : uuid === BEACON_UUID ? target.server.beacon() : new Uint8Array(0),
      write: async (bytes) => {
        if (closed) throw new Error('fake: link closed')
        await Promise.resolve()
        target.server.onWrite(centralId, new Uint8Array(bytes))
      },
      subscribe: async (cb) => { link.onValue = cb },
      close: async () => {
        if (closed) return
        closed = true
        target.links.delete(centralId)
        target.server.onDisconnect(centralId)
        link._onClose?.()
      },
      onClose: (cb) => { link._onClose = cb },
    }
    target.links.set(centralId, link)
    return link
  }
}
