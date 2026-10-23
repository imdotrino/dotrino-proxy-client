/**
 * EL ADAPTADOR DE LINUX: el contrato de `manager.js` sobre BlueZ, por D-Bus (`dbus.js`), sin
 * módulos nativos. Hace las dos cosas: periférico (anuncia y sirve el GATT de
 * docs/bluetooth.md §3) y central (busca, se conecta, lee, escribe y se suscribe).
 *
 * `openBluez()` devuelve null cuando aquí no hay Bluetooth (otro sistema, sin bus, sin
 * BlueZ, adaptador apagado): es el caso normal y no se dice. Si lo hay y falla, lanza.
 */

import { openSystemBus, variant, plain } from './dbus.js'
import { SERVICE_UUID, HELLO_UUID, BEACON_UUID, RX_UUID, TX_UUID } from './wire.js'

const BLUEZ = 'org.bluez'
const OM = 'org.freedesktop.DBus.ObjectManager'
const PROPS = 'org.freedesktop.DBus.Properties'
const GATT_SVC = 'org.bluez.GattService1'
const GATT_CHR = 'org.bluez.GattCharacteristic1'
const DEVICE = 'org.bluez.Device1'
const ADAPTER = 'org.bluez.Adapter1'
const ADV_IFACE = 'org.bluez.LEAdvertisement1'

const APP = '/com/dotrino/ble'
const SVC = APP + '/service0'
const CHR = {
  [HELLO_UUID]: SVC + '/char0',
  [BEACON_UUID]: SVC + '/char1',
  [RX_UUID]: SVC + '/char2',
  [TX_UUID]: SVC + '/char3',
}
const FLAGS = {
  [HELLO_UUID]: ['read'],
  [BEACON_UUID]: ['read'],
  [RX_UUID]: ['write', 'write-without-response'],
  [TX_UUID]: ['notify'],
}
const ADV = APP + '/adv0'
/**
 * DIRECCIONES FIJAS EN LA TABLA GATT. iOS guarda en caché la tabla de un aparato que ya vio; si
 * BlueZ reparte direcciones nuevas al volver a registrar el servicio (otro arranque, el
 * Bluetooth reiniciado), el iPhone lee por las viejas y recibe «The handle is invalid». Con el
 * servicio en una dirección fija y las características detrás, siempre en el mismo orden, la
 * tabla es la misma en cada arranque. Lejos del principio, donde van los servicios del sistema.
 */
const SVC_HANDLE = 0x0400
const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_MTU = 23

const lower = (u) => String(u).toLowerCase()

/**
 * UN SOLO DUEÑO POR PROCESO. BlueZ deja registrar varias aplicaciones con el mismo servicio,
 * pero quien se conecta solo ve la primera: un segundo cliente anunciaría y nadie lo
 * encontraría. Así que el primero que abre se lo queda, y los demás siguen sin Bluetooth
 * (`bluetoothAvailable` en false), que es lo que de verdad tienen. La bóveda con varios
 * perfiles en un proceso lo nota: el Bluetooth es del primero que arrancó.
 */
let owner = null

export async function openBluez () {
  if (typeof process === 'undefined' || process.platform !== 'linux') return null
  if (owner) return null
  const bus = await openSystemBus()
  if (!bus) return null
  let objs
  try {
    [objs] = await bus.call({ destination: BLUEZ, path: '/', iface: OM, member: 'GetManagedObjects' })
  } catch (e) {
    bus.close()
    // Sin el servicio de BlueZ no hay Bluetooth: normal.
    if (e.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') return null
    throw e
  }
  const path = Object.keys(objs).find((p) => {
    const ifs = objs[p]
    return ifs[ADAPTER] && ifs['org.bluez.GattManager1'] && ifs['org.bluez.LEAdvertisingManager1'] && plain(ifs[ADAPTER]).Powered
  })
  if (!path) { bus.close(); return null }
  if (owner) { bus.close(); return null }
  owner = new BluezAdapter(bus, path, objs)
  return owner
}

class BluezAdapter {
  constructor (bus, adapterPath, objs) {
    this.bus = bus
    this.adapterPath = adapterPath
    this.server = null
    this.mtu = new Map()          // device -> MTU que dijo al escribirnos
    this.subscribed = false
    this.devices = new Map()      // device -> { ours: bool } (lo que sabemos de los vistos)
    this.valueHandlers = new Map() // ruta de la característica remota -> fn(bytes)
    this.closeHandlers = new Map() // device -> Set(fn)
    this.onFound = null
    this.registered = false
    for (const [p, ifs] of Object.entries(objs)) if (ifs[DEVICE]) this._learn(p, plain(ifs[DEVICE]))
    this._signals = bus.onSignal((m) => this._onSignal(m))
  }

  // ---------- periférico ----------

  async start (server) {
    this.server = server
    await this.bus.addMatch(`type='signal',sender='${BLUEZ}'`)
    const chr = (uuid) => ({
      [GATT_CHR]: {
        ReadValue: ([opts]) => {
          const o = plain(opts)
          const all = uuid === HELLO_UUID ? server.hello() : uuid === BEACON_UUID ? server.beacon() : new Uint8Array(0)
          return { signature: 'ay', body: [all.subarray(o.offset || 0)] }
        },
        WriteValue: ([value, opts]) => {
          if (uuid !== RX_UUID) throw Object.assign(new Error('not writable'), { dbusName: 'org.bluez.Error.NotPermitted' })
          const o = plain(opts)
          if (o.device && o.mtu) this.mtu.set(o.device, o.mtu)
          server.onWrite(o.device || 'unknown', value)
          return {}
        },
        StartNotify: () => { if (uuid === TX_UUID) this.subscribed = true; return {} },
        StopNotify: () => { if (uuid === TX_UUID) this.subscribed = false; return {} },
      },
    })
    this.bus.export(APP, { [OM]: { GetManagedObjects: () => ({ signature: 'a{oa{sa{sv}}}', body: [this._managed()] }) } })
    // BlueZ avisa por `Properties.Set` de la dirección que asignó: ya la sabemos, no hay nada que guardar.
    const props = { [PROPS]: { Set: () => ({}) } }
    this.bus.export(SVC, props)
    for (const uuid of Object.keys(CHR)) this.bus.export(CHR[uuid], { ...chr(uuid), ...props })
    this.bus.export(ADV, {
      [ADV_IFACE]: { Release: () => ({}) },
      [PROPS]: {
        GetAll: () => ({ signature: 'a{sv}', body: [this._advProps()] }),
        Get: ([, name]) => ({ signature: 'v', body: [this._advProps()[name]] }),
      },
    })
    await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: 'org.bluez.GattManager1', member: 'RegisterApplication', signature: 'oa{sv}', body: [APP, {}] })
    await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: 'org.bluez.LEAdvertisingManager1', member: 'RegisterAdvertisement', signature: 'oa{sv}', body: [ADV, {}] })
    this.registered = true
  }

  _managed () {
    /** @type {Record<string, any>} */
    const out = { [SVC]: { [GATT_SVC]: { UUID: variant('s', SERVICE_UUID), Primary: variant('b', true), Handle: variant('q', SVC_HANDLE) } } }
    // Cada característica ocupa dos direcciones (la declaración y el valor), y la que notifica una
    // más (su descriptor de suscripción): el valor de la n-ésima cae en un sitio fijo.
    let h = SVC_HANDLE
    for (const uuid of Object.keys(CHR)) {
      h += 2
      out[CHR[uuid]] = { [GATT_CHR]: { UUID: variant('s', uuid), Service: variant('o', SVC), Flags: variant('as', FLAGS[uuid]), Handle: variant('q', h) } }
      if (FLAGS[uuid].includes('notify')) h += 1
    }
    return out
  }

  /**
   * `Discoverable` pone la bandera LE General Discoverable en el anuncio. Sin ella BlueZ anuncia
   * igual, pero iOS no lo enseña a ninguna app: el iPhone tenía el PC al lado y no lo veía.
   */
  _advProps () {
    return { Type: variant('s', 'peripheral'), ServiceUUIDs: variant('as', [SERVICE_UUID]), Discoverable: variant('b', true) }
  }

  /**
   * BlueZ notifica a TODOS los suscritos (por eso la etiqueta de docs §5), así que el trozo
   * tiene que caber en el MTU del más pequeño.
   */
  chunkFor () {
    const mtus = [...this.mtu.values()]
    return (mtus.length ? Math.min(...mtus) : DEFAULT_MTU) - 3
  }

  async notify (_device, bytes) {
    if (!this.subscribed) throw new Error('bluez: nobody is subscribed to tx')
    this.bus.signal({ path: CHR[TX_UUID], iface: PROPS, member: 'PropertiesChanged', signature: 'sa{sv}as', body: [GATT_CHR, { Value: variant('ay', bytes) }, []] })
    // Sin acuse en una notificación: se deja respirar al bus entre trozos.
    await new Promise((r) => setImmediate(r))
  }

  async drop (device) {
    await this.bus.call({ destination: BLUEZ, path: device, iface: DEVICE, member: 'Disconnect' }).catch(() => {})
  }

  // ---------- central ----------

  async scan (onFound) {
    this.onFound = onFound
    await this.bus.call({
      destination: BLUEZ, path: this.adapterPath, iface: ADAPTER, member: 'SetDiscoveryFilter', signature: 'a{sv}',
      body: [{ UUIDs: variant('as', [SERVICE_UUID]), Transport: variant('s', 'le'), DuplicateData: variant('b', false) }],
    })
    await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: ADAPTER, member: 'StartDiscovery' })
    return async () => {
      this.onFound = null
      await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: ADAPTER, member: 'StopDiscovery' }).catch(() => {})
    }
  }

  async connect (dev) {
    const path = dev.id
    const call = (member, iface = DEVICE, p = path, signature = '', body = []) =>
      this.bus.call({ destination: BLUEZ, path: p, iface, member, signature, body })
    const getProp = async (iface, name, p = path) => plain((await call('Get', PROPS, p, 'ss', [iface, name]))[0])

    // Si ya estábamos conectados (el otro es central de nosotros), el enlace es el mismo:
    // al terminar no se corta, o se le cortaría su canal.
    const wasConnected = await getProp(DEVICE, 'Connected').catch(() => false)
    if (!wasConnected) await withTimeout(call('Connect'), CONNECT_TIMEOUT_MS, () => call('Disconnect').catch(() => {}))
    if (!await getProp(DEVICE, 'ServicesResolved').catch(() => false)) {
      await withTimeout(this._waitResolved(path), CONNECT_TIMEOUT_MS, () => wasConnected ? null : call('Disconnect').catch(() => {}))
    }
    const [objs] = await this.bus.call({ destination: BLUEZ, path: '/', iface: OM, member: 'GetManagedObjects' })
    const svc = Object.keys(objs).find((p) => p.startsWith(path + '/') && objs[p][GATT_SVC] && lower(plain(objs[p][GATT_SVC]).UUID) === SERVICE_UUID)
    if (!svc) {
      if (!wasConnected) await call('Disconnect').catch(() => {})
      throw new Error('bluez: that device has no Dotrino service')
    }
    const chars = {}
    let mtu = DEFAULT_MTU
    for (const p of Object.keys(objs)) {
      const c = objs[p][GATT_CHR]
      if (!p.startsWith(svc + '/') || !c) continue
      const cp = plain(c)
      chars[lower(cp.UUID)] = p
      if (cp.MTU) mtu = cp.MTU
    }

    let closed = false
    const closeCbs = new Set()
    const fireClose = () => {
      if (closed) return
      closed = true
      this.valueHandlers.delete(chars[TX_UUID])
      this.closeHandlers.get(path)?.delete(fireClose)
      for (const cb of closeCbs) { try { cb() } catch (_) {} }
    }
    if (!this.closeHandlers.has(path)) this.closeHandlers.set(path, new Set())
    this.closeHandlers.get(path).add(fireClose)

    const charPath = (uuid) => {
      const p = chars[uuid]
      if (!p) throw new Error('bluez: missing characteristic ' + uuid)
      return p
    }
    return {
      chunk: mtu - 3,
      read: async (uuid) => (await call('ReadValue', GATT_CHR, charPath(uuid), 'a{sv}', [{}]))[0],
      write: async (bytes) => {
        if (closed) throw new Error('bluez: link closed')
        await call('WriteValue', GATT_CHR, charPath(RX_UUID), 'aya{sv}', [bytes, { type: variant('s', 'request') }])
      },
      subscribe: async (cb) => {
        this.valueHandlers.set(charPath(TX_UUID), cb)
        await call('StartNotify', GATT_CHR, charPath(TX_UUID))
      },
      close: async () => {
        if (closed) return
        if (chars[TX_UUID] && this.valueHandlers.has(chars[TX_UUID])) await call('StopNotify', GATT_CHR, chars[TX_UUID]).catch(() => {})
        if (!wasConnected) await call('Disconnect').catch(() => {})
        fireClose()
      },
      onClose: (cb) => closeCbs.add(cb),
    }
  }

  _waitResolved (path) {
    return new Promise((resolve) => {
      const off = this.bus.onSignal((m) => {
        if (m.path === path && m.member === 'PropertiesChanged' && m.body[0] === DEVICE && plain(m.body[1]).ServicesResolved) { off(); resolve() }
      })
    })
  }

  // ---------- señales ----------

  _learn (path, props) {
    const d = this.devices.get(path) || { ours: false }
    if (Array.isArray(props.UUIDs)) d.ours = props.UUIDs.map(lower).includes(SERVICE_UUID)
    this.devices.set(path, d)
    return d
  }

  _onSignal (m) {
    if (m.member === 'InterfacesAdded') {
      const [path, ifs] = m.body
      if (!ifs[DEVICE]) return
      const d = this._learn(path, plain(ifs[DEVICE]))
      if (d.ours && plain(ifs[DEVICE]).RSSI != null) this.onFound?.({ id: path })
      return
    }
    if (m.member === 'InterfacesRemoved') { this.devices.delete(m.body[0]); return }
    if (m.member !== 'PropertiesChanged') return
    const [iface, changed] = m.body
    const ch = plain(changed)
    if (iface === GATT_CHR && ch.Value) {
      this.valueHandlers.get(m.path)?.(ch.Value)
      return
    }
    if (iface !== DEVICE) return
    const d = this._learn(m.path, ch)
    if (ch.Connected === false) {
      this.mtu.delete(m.path)
      this.server?.onDisconnect(m.path)
      for (const cb of [...(this.closeHandlers.get(m.path) || [])]) cb()
    }
    if (d.ours && ch.RSSI != null) this.onFound?.({ id: m.path })
  }

  async stop () {
    this._signals()
    if (this.registered) {
      await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: 'org.bluez.LEAdvertisingManager1', member: 'UnregisterAdvertisement', signature: 'o', body: [ADV] }).catch(() => {})
      await this.bus.call({ destination: BLUEZ, path: this.adapterPath, iface: 'org.bluez.GattManager1', member: 'UnregisterApplication', signature: 'o', body: [APP] }).catch(() => {})
    }
    this.bus.close()
    if (owner === this) owner = null
  }
}

function withTimeout (p, ms, onTimeout) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((resolve, reject) => {
      t = setTimeout(() => { Promise.resolve(onTimeout?.()).finally(() => reject(Object.assign(new Error('bluez: timed out'), { code: 'bluetooth-timeout' }))) }, ms)
      t.unref?.()
    }),
  ])
}
