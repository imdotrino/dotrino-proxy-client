/**
 * SIEMPRE EL CAMINO MÁS DIRECTO, PERO SIN PAGAR POR ÉL (dueño, 2026-09-03).
 *
 * El enrutado ya prefería el canal directo cuando estaba abierto; lo que faltaba era
 * ABRIRLO SOLO. Ahora el primer mensaje a alguien sale por el proxio —que es lo que hay en
 * ese momento— y en paralelo se intenta subir a directo; del segundo en adelante el propio
 * `trySend` lo prefiere.
 *
 * Las dos propiedades que esto fija, y que son fáciles de romper sin querer:
 *
 *   1. **El primer mensaje NO espera** a la negociación. Bloquearlo haría más lento justo
 *      el arranque, que es lo que se quería arreglar.
 *   2. **Un intento por destinatario**, no uno por mensaje. No poder ir directo es el caso
 *      NORMAL en internet (dos NAT que no se dejan), y reintentarlo en cada mensaje sería
 *      quemar señalización para nada.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '../src/client.js'

/** Un cliente con el transporte y el WebRTC falsos: se mira a quién se le manda qué. */
function cliente () {
  const c = new WebSocketProxyClient({ url: 'ws://x', enableWebRTC: true, autoReconnect: false })
  const porProxio = []
  const intentos = []
  const abiertos = new Set()
  c._sendRaw = (env) => porProxio.push(env)
  c._rtc = {
    trySend: (t) => abiertos.has(t),
    isOpen: (t) => abiertos.has(t),
    connect: async (t) => { intentos.push(t); abiertos.add(t) },
    closeAll () {}
  }
  return { c, porProxio, intentos, abiertos }
}

test('el primer mensaje sale por el proxio y NO espera al canal directo', async () => {
  const { c, porProxio, intentos } = cliente()
  c.send('peer-1', { hola: 1 })
  // Ya salió, sin haber esperado nada.
  assert.equal(porProxio.length, 1)
  assert.deepEqual(porProxio[0].to, ['peer-1'])
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(intentos, ['peer-1'], 'y de paso se pidió el canal directo, por detrás')
})

test('del segundo en adelante va directo, sin tocar el proxio', async () => {
  const { c, porProxio, intentos } = cliente()
  c.send('peer-1', { n: 1 })
  await new Promise((r) => setImmediate(r))
  c.send('peer-1', { n: 2 })
  assert.equal(porProxio.length, 1, 'el segundo ya no pasó por el proxio')
  assert.equal(intentos.length, 1, 'y no se volvió a negociar')
})

test('si no se puede ir directo, se intenta UNA vez y se sigue por el proxio', async () => {
  const { c, porProxio, intentos } = cliente()
  c._rtc.connect = async (t) => { intentos.push(t); throw new Error('dos NAT que no se dejan') }
  for (let i = 0; i < 5; i++) { c.send('peer-1', { n: i }); await new Promise((r) => setImmediate(r)) }
  assert.equal(porProxio.length, 5, 'los cinco llegaron')
  assert.equal(intentos.length, 1, 'y solo se intentó negociar una vez')
})

test('si el canal se cae, se vuelve a intentar: el intento único no es una condena', async () => {
  const { c, intentos, abiertos } = cliente()
  c.send('peer-1', { n: 1 })
  await new Promise((r) => setImmediate(r))
  assert.equal(intentos.length, 1)

  abiertos.delete('peer-1')
  c._emit = () => {}                     // el cliente real ya lo tiene; aquí solo importa el efecto
  c._rtcTried.delete('peer-1')           // lo que hace el manejador de `webrtc_close`
  c.send('peer-1', { n: 2 })
  await new Promise((r) => setImmediate(r))
  assert.equal(intentos.length, 2, 'una desconexión no puede dejarlo en el proxio para siempre')
})
