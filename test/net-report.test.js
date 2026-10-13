/** El informe de red de texto: las mismas líneas que el modal del topbar y las apps nativas. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { netReport, splitPeers } from '../src/index.js'

const z = { proxy: 0, direct: 0, turn: 0, webrtc: 0 }
const stats = {
  url: 'wss://proxy.example', app: 'terminal', node: 'p1', connected: true, since: 0,
  proxy: { bytesIn: 2048, bytesOut: 100, framesIn: 3, framesOut: 2 },
  peers: [
    { token: 'p1-abc', pubkey: 'KEY-A', route: 'direct', bytesIn: { ...z, direct: 3 * 1024 * 1024 }, bytesOut: { ...z, proxy: 10, direct: 500 }, msgsIn: 4, msgsOut: 6 },
    { token: 'p1-off', pubkey: 'KEY-B', route: 'proxy', bytesIn: { ...z }, bytesOut: { ...z, proxy: 80 }, msgsIn: 0, msgsOut: 2 },
    { token: 'p1-who', pubkey: null, route: 'proxy', bytesIn: { ...z, proxy: 40 }, bytesOut: { ...z }, msgsIn: 1, msgsOut: 0 }
  ]
}

test('splitPeers: solo cuenta como conexión quien contestó', () => {
  const { talking, silent, unknown } = splitPeers(stats.peers)
  assert.deepEqual(talking.map((p) => p.token), ['p1-abc'])
  assert.deepEqual(silent, { count: 1, bytesOut: 80, msgsOut: 2 })
  assert.deepEqual(unknown, { count: 1, bytesIn: 40, msgsIn: 1 })
})

test('netReport: nombra al aparato con `label`, y dice por dónde fue cada byte', async () => {
  const out = await netReport([stats, { url: 'wss://otro', error: 'boom' }], { label: (k) => (k === 'KEY-A' ? 'AB12-CD34' : null), now: new Date(Date.UTC(2026, 9, 13, 12, 0, 0)) })
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], 'Dotrino network stats · 2026-10-13T12:00:00Z')
  assert.match(lines[1], /^Proxy wss:\/\/proxy\.example \| app=terminal \| node=p1 \| connected \| since \d\d:\d\d:\d\d$/)
  assert.equal(lines[2], '  proxy total: in 2.0 KB / out 100 B (frames 3/2)')
  assert.equal(lines[3], '  peers: 1')
  assert.equal(lines[4], '  - AB12-CD34 (token p1-abc) | route=direct | in: direct 3.00 MB | out: proxy 10 B, direct 500 B | 10 msgs')
  assert.equal(lines[5], '  no answer: 1 (out 80 B, 2 msgs)')
  assert.equal(lines[6], '  unknown senders: 1 (in 40 B, 1 msgs)')
  assert.equal(lines[7], 'Proxy wss://otro | error: boom')
})

test('netReport: sin `label` (o si falla) sale «?», nunca un trozo de la llave', async () => {
  assert.match(await netReport([stats]), /  - \? \(token p1-abc\)/)
  assert.match(await netReport([stats], { label: () => { throw new Error('x') } }), /  - \? \(token p1-abc\)/)
  assert.match(await netReport([]), /\(no transports\)/)
})
