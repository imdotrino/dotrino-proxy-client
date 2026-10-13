// El relevo, fijado a IPv4 fuera del navegador (`pinTurnToIPv4`).
//
// La implementación de Node abre el socket UDP hacia el relevo solo en IPv4 y resuelve el
// nombre sin pedir familia: con el nombre, en una máquina con IPv4 e IPv6, cada negociación
// esperaba 6,4 s antes de caer a TCP. Aquí se comprueba qué se reescribe y qué no.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinTurnToIPv4 } from '../src/webrtc.js'

const CF = [{
  urls: [
    'stun:stun.cloudflare.com:3478',
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp'
  ],
  username: 'u',
  credential: 'c'
}]

test('rewrites only the turn: urls, and keeps the credentials', async () => {
  const asked = []
  const out = await pinTurnToIPv4(CF, { native: false, lookup: async (h) => { asked.push(h); return '192.0.2.7' } })
  assert.deepEqual(out[0].urls, [
    'stun:stun.cloudflare.com:3478',
    'turn:192.0.2.7:3478?transport=udp',
    'turn:192.0.2.7:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp'
  ])
  assert.equal(out[0].username, 'u')
  assert.equal(out[0].credential, 'c')
  assert.deepEqual(asked, ['turn.cloudflare.com'], 'one lookup per host')
  assert.equal(CF[0].urls[1], 'turn:turn.cloudflare.com:3478?transport=udp', 'the input is not mutated')
})

test('a browser gets the list untouched, and nothing is resolved', async () => {
  const out = await pinTurnToIPv4(CF, { native: true, lookup: async () => { throw new Error('must not resolve') } })
  assert.equal(out, CF)
})

test('a single url string, a bare host and an address already written', async () => {
  const lookup = async () => '192.0.2.7'
  const out = await pinTurnToIPv4([
    { urls: 'turn:relay.example', username: 'u', credential: 'c' },
    { urls: 'turn:198.51.100.4:3478?transport=udp', username: 'u', credential: 'c' },
    { urls: 'turn:[2001:db8::1]:3478', username: 'u', credential: 'c' },
    { urls: 'stun:stun.l.google.com:19302' }
  ], { native: false, lookup })
  assert.deepEqual(out.map((s) => s.urls), [
    'turn:192.0.2.7',
    'turn:198.51.100.4:3478?transport=udp',
    'turn:[2001:db8::1]:3478',
    'stun:stun.l.google.com:19302'
  ])
})

test('a host with no IPv4 address keeps its name (TCP can still reach it)', async () => {
  const out = await pinTurnToIPv4(CF, { native: false, lookup: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) } })
  assert.deepEqual(out[0].urls, CF[0].urls)
})

test('without an injected lookup it asks the system for the IPv4 address', async () => {
  const out = await pinTurnToIPv4([{ urls: 'turn:localhost:3478', username: 'u', credential: 'c' }], { native: false })
  assert.equal(out[0].urls, 'turn:127.0.0.1:3478')
})
