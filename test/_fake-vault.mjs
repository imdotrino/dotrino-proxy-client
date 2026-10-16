/** Una bóveda de mentira, sharedKey por las pruebas del puente de la bóveda. */
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const subtle = globalThis.crypto.subtle

/** Una bóveda de mentira con la MISMA forma que el núcleo real: ECDH + AES-GCM. */
export async function fakeVault () {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const jwk = await subtle.exportKey('jwk', pair.publicKey)
  const encPub = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  const sharedKey = async (peerJwkStr) => {
    const pub = await subtle.importKey('jwk', JSON.parse(peerJwkStr), ECDH, false, [])
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256)
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  const id = async (encPubStr) => b64(await subtle.digest('SHA-256', new TextEncoder().encode(encPubStr))).slice(0, 16)
  return {
    encPub,
    async encrypt (recipients, plaintext) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const wrap = {}
      for (const r of recipients || []) {
        if (!r?.encryptionPubkey) continue
        // Igual que el núcleo: la llave que no se puede importar se SALTA en silencio.
        let key
        try { key = await sharedKey(r.encryptionPubkey) } catch (_) { continue }
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
        wrap[await id(r.encryptionPubkey)] = { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
      }
      return { v: 2, iv: b64(iv), ct: '', wrap }
    },
    async open (senderEncPub, envelope) {
      const key = await sharedKey(senderEncPub)
      const mine = envelope.wrap[await id(encPub)]
      if (!mine) throw new Error('this device is not among the message recipients')
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, key, unb64(mine.ct))
      return new TextDecoder().decode(pt)
    }
  }
}

