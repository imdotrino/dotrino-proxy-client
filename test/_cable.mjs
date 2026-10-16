/**
 * Leer lo que el cliente dejó en el cable (0.37.0: todo dirigido va empaquetado y lo sellado
 * con el sobre binario). Las pruebas miran el mensaje como objeto, sea cual sea el formato.
 */
import { unpack } from '../src/binpack.js'
import { open, isBinSealed, decryptBytes } from '../src/sealing.js'

/** El objeto que viaja: desempaquetado si es binario, parseado si es texto. */
export function leer (message) {
  return message instanceof Uint8Array ? unpack(message) : JSON.parse(message)
}

/** ¿Es un sobre sellado en binario? */
export function esSobre (message) {
  return message instanceof Uint8Array && isBinSealed(unpack(message))
}

/**
 * Abrir un sobre binario: la llave del mensaje con `abrirLlave` (por defecto, el sellado propio
 * con `encPrivateKey`) y el paquete con ella.
 */
export async function abrir (message, encPrivateKey, abrirLlave = (k) => open(k, encPrivateKey)) {
  const env = unpack(message)
  if (!isBinSealed(env)) throw new Error('not a binary sealed envelope')
  const { cek } = await abrirLlave(env.k)
  return unpack(await decryptBytes(cek, env))
}
