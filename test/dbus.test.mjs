// El cliente D-Bus mínimo (src/ble/dbus.js): lo que escribe se lee igual, con los tipos que
// usa BlueZ, y un mensaje partido en dos trozos de red se rearma.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessage, splitSig, variant, plain, DBusConnection } from '../src/ble/dbus.js'
import { EventEmitter } from 'node:events'

test('firmas: tipos completos', () => {
  assert.deepEqual(splitSig('sa{sv}as'), ['s', 'a{sv}', 'as'])
  assert.deepEqual(splitSig('a{oa{sa{sv}}}'), ['a{oa{sa{sv}}}'])
  assert.deepEqual(splitSig('(yv)ayb'), ['(yv)', 'ay', 'b'])
})

test('un mensaje con los tipos de BlueZ hace el viaje de vuelta', () => {
  const body = [
    '/com/dotrino/ble',
    { 'org.bluez.GattCharacteristic1': { UUID: variant('s', 'abc'), Flags: variant('as', ['read', 'notify']), Value: variant('ay', Uint8Array.of(1, 2, 3)), MTU: variant('q', 517), Primary: variant('b', true) } },
    [7, 8],
  ]
  const bytes = encodeMessage({ type: 1, serial: 42, path: '/org/bluez/hci0', iface: 'org.bluez.GattManager1', member: 'RegisterApplication', destination: 'org.bluez', signature: 'oa{sa{sv}}au', body })
  const { msg, size } = decodeMessage(bytes)
  assert.equal(size, bytes.length)
  assert.equal(msg.serial, 42)
  assert.equal(msg.member, 'RegisterApplication')
  assert.equal(msg.path, '/org/bluez/hci0')
  assert.equal(msg.body[0], '/com/dotrino/ble')
  const c = plain(msg.body[1])['org.bluez.GattCharacteristic1']
  assert.deepEqual(c, { UUID: 'abc', Flags: ['read', 'notify'], Value: Uint8Array.of(1, 2, 3), MTU: 517, Primary: true })
  assert.deepEqual(msg.body[2], [7, 8])
  assert.equal(decodeMessage(bytes.subarray(0, bytes.length - 1)), null, 'incompleto: espera más')
})

test('la conexión rearma tramas partidas, contesta llamadas y resuelve respuestas', async () => {
  const sock = new EventEmitter()
  const written = []
  sock.write = (b) => written.push(b)
  const conn = new DBusConnection(sock)
  conn.export('/x', { 'a.B': { Ping: ([s]) => ({ signature: 's', body: ['pong:' + s] }) } })
  const call = encodeMessage({ type: 1, serial: 5, path: '/x', iface: 'a.B', member: 'Ping', signature: 's', body: ['hola'] })
  sock.emit('data', Buffer.from(call.subarray(0, 10)))
  sock.emit('data', Buffer.from(call.subarray(10)))
  await new Promise((r) => setImmediate(r))
  const reply = decodeMessage(written[0]).msg
  assert.equal(reply.type, 2)
  assert.equal(reply.replySerial, 5)
  assert.deepEqual(reply.body, ['pong:hola'])

  const p = conn.call({ destination: 'd', path: '/y', iface: 'a.B', member: 'Get' })
  const sent = decodeMessage(written[1]).msg
  sock.emit('data', Buffer.from(encodeMessage({ type: 3, serial: 9, replySerial: sent.serial, error: 'org.bluez.Error.Failed', signature: 's', body: ['nope'] })))
  await assert.rejects(p, (e) => e.dbusName === 'org.bluez.Error.Failed')
})
