// La red local (docs/lan.md): el TXT de ida y vuelta, el mensaje DNS, y un anuncio de verdad
// por multicast que este mismo proceso descubre (el kernel lo entrega en loopback).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { txtEntries, fromTxt, parseMessage, announceLan, discoverLan, MAX_DATA } from '../src/lan/mdns.js'
import { WebSocketProxyClient } from '../src/index.js'

const toMap = (entries) => new Map(entries.map((b) => {
  const s = b.toString('utf8')
  return [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]
}))

test('el TXT lleva kind y data en trozos, y vuelve igual', () => {
  const data = 'c' + 'é'.repeat(200)
  const entries = txtEntries('pair', data)
  assert.ok(entries.every((e) => e.length <= 255))
  assert.deepEqual(fromTxt(toMap(entries)), { kind: 'pair', data })
})

test('más de 512 bytes no se anuncia', () => {
  assert.throws(() => txtEntries('pair', 'x'.repeat(MAX_DATA + 1)), { code: 'too-big' })
})

test('un TXT incompleto no se entiende', () => {
  const m = toMap(txtEntries('pair', 'x'.repeat(300)))
  m.delete('d1')
  assert.equal(fromTxt(m), null)
  assert.equal(fromTxt(new Map([['k', 'pair'], ['n', '0']])), null)
})

test('un nombre comprimido y una pregunta se leen', () => {
  // Pregunta PTR por _dotrino._tcp.local, como la manda iOS.
  const q = Buffer.from('000000000001000000000000' + '085f646f7472696e6f045f746370056c6f63616c00' + '000c0001', 'hex')
  const m = parseMessage(q)
  assert.equal(m.response, false)
  assert.deepEqual(m.questions, [{ name: '_dotrino._tcp.local', type: 12, unicast: false }])
})

test('lo que se anuncia en la red local se descubre', async (t) => {
  let stop
  try { stop = await announceLan('contact', 'to=abc&nick=Prueba%20%C3%B1') } catch (e) {
    if (e.code === 'no-lan') return t.skip('no mDNS here')
    throw e
  }
  try {
    const got = await discoverLan({ kind: 'contact', timeoutMs: 2500 })
    assert.ok(got.some((g) => g.data === 'to=abc&nick=Prueba%20%C3%B1'), JSON.stringify(got))
    const other = await discoverLan({ kind: 'pair', timeoutMs: 1500 })
    assert.ok(!other.some((g) => g.data.startsWith('to=abc')))
  } finally { stop() }
})

test('el cliente anuncia y busca cerca por la red local, y sin medios dice no-nearby', async () => {
  const a = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1', lan: true })
  const b = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1', lan: true })
  const stop = await a.announceNearby('pair', 'cNEARBY')
  try {
    const got = await b.discoverNearby({ kind: 'pair', timeoutMs: 2500 })
    assert.deepEqual(got.filter((g) => g.data === 'cNEARBY'), [{ kind: 'pair', data: 'cNEARBY', via: 'lan' }])
  } finally { stop() }
  const none = new WebSocketProxyClient({ url: 'ws://127.0.0.1:1' })
  await assert.rejects(none.announceNearby('pair', 'x'), { code: 'no-nearby' })
  await assert.rejects(none.discoverNearby({ kind: 'pair', timeoutMs: 10 }), { code: 'no-nearby' })
})

test('un anuncio que nadie cerró no deja colgado al proceso', async () => {
  const { spawnSync } = await import('node:child_process')
  const mod = new URL('../src/lan/mdns.js', import.meta.url).href
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { announceLan } from '${mod}'; await announceLan('pair', 'cX').catch(() => {})`], { timeout: 8000 })
  assert.equal(r.signal, null, 'se fue solo, sin que hubiera que matarlo')
  assert.equal(r.status, 0)
})
