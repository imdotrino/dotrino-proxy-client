/**
 * canonicalStringify es la base de TODAS las firmas del transporte: el proxy
 * verifica sobre esta serialización exacta. Si dos implementaciones ordenan
 * distinto, no falla nada visible — simplemente las firmas dejan de validar,
 * que es el peor modo de romperse. De ahí que se fije aquí carácter a carácter.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalStringify } from '../src/canonical.js'

test('ordena las claves, no las deja como vengan', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(
    canonicalStringify({ b: 1, a: 2 }),
    canonicalStringify({ a: 2, b: 1 }),
    'dos objetos con las mismas claves en distinto orden deben dar la MISMA cadena'
  )
})

test('ordena en profundidad, no solo el primer nivel', () => {
  assert.equal(
    canonicalStringify({ z: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] }),
    '{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}'
  )
})

test('el orden de un array SÍ se respeta (es dato, no clave)', () => {
  assert.equal(canonicalStringify([3, 1, 2]), '[3,1,2]')
  assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]))
})

test('primitivos y null como JSON.stringify', () => {
  assert.equal(canonicalStringify(null), 'null')
  assert.equal(canonicalStringify(42), '42')
  assert.equal(canonicalStringify('hola'), '"hola"')
  assert.equal(canonicalStringify(true), 'true')
})

test('escapa las claves, no las concatena a pelo', () => {
  assert.equal(canonicalStringify({ 'a"b': 1 }), '{"a\\"b":1}')
  assert.equal(canonicalStringify({ 'con espacio': 1 }), '{"con espacio":1}')
})

test('acentos y no-ASCII sobreviven intactos', () => {
  // El proxy compara bytes: si esto se normalizara o escapara distinto en un
  // extremo, un nick con tilde rompería la firma y nadie sabría por qué.
  assert.equal(canonicalStringify({ nick: 'Ramón' }), '{"nick":"Ramón"}')
})

test('null NO se confunde con objeto (typeof null === "object")', () => {
  assert.equal(canonicalStringify({ a: null }), '{"a":null}')
})
