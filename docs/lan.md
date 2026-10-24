# La red local: anunciar y descubrir por mDNS

> Desde la 0.43.0. Es el `beacon` del Bluetooth (`bluetooth.md` §3 y §6) por otro medio: lo que se
> anuncia es lo mismo (`{kind, data}`) y sirve para lo mismo (la invitación de emparejar y la
> tarjeta de contacto). Lo cumplen igual JS (`src/lan/mdns.js`), Kotlin y Swift (`dotrino-native`).

Es solo para **anunciar y descubrir**. El canal no va por aquí: en la misma red, WebRTC ya sale
directo (escalón 2), y por eso no se abre ningún puerto.

## 1. Dónde existe

| Entorno | Anuncia | Busca |
|---|---|---|
| Node (Linux, macOS, Windows) | sí, `dgram` en JS puro, sin dependencias | sí |
| Android (`dotrino-native`) | sí, `NsdManager` | sí |
| iOS (`dotrino-native`) | sí, Bonjour (`dns_sd`), con el permiso de red local | sí |
| Navegador | no (desde JS no hay UDP) | no |

En Node se enciende a propósito, como el Bluetooth: `new WebSocketProxyClient({ lan: true })`.
Anunciar le dice a la red que aquí hay algo, y eso lo decide quien monta el cliente.

## 2. El anuncio

DNS-SD sobre mDNS (RFC 6762 y 6763), en IPv4 (`224.0.0.251:5353`).

| Registro | Valor |
|---|---|
| tipo de servicio | `_dotrino._tcp.local` |
| instancia | `dotrino-<16 hex al azar>`, nueva en cada anuncio |
| SRV | puerto **9**, de mentira: nadie escucha ahí. NSD y Bonjour exigen un puerto |
| TXT | `v=1`, `k=<kind>`, `n=<trozos>`, `d0=…`, `d1=…` |
| TTL | 120 s; al parar se manda la despedida (TTL 0) |

**Los trozos.** `data` (UTF-8, como mucho **512 bytes**) se parte en trozos de hasta 200 bytes,
cortando solo entre caracteres enteros: cada trozo es UTF-8 válido por sí solo. Se juntan en orden
`d0…d{n-1}`. Un TXT al que le falta un trozo, o sin `v=1`, no se entiende y se ignora.

Ejemplo, una tarjeta de contacto:

```
dotrino-085083627aaf09b2._dotrino._tcp.local.  SRV 0 0 9 dotrino-085083627aaf09b2.local.
                                               TXT "v=1" "k=contact" "n=1" "d0=to=…&nick=Prueba%20%C3%B1"
```

## 3. Buscar

1. Se pregunta `PTR _dotrino._tcp.local` al empezar, al segundo, a los tres y luego cada cinco,
   durante el tiempo pedido.
2. De cada instancia se lee el TXT. Si no vino en la misma respuesta, se pregunta por él.
3. Se devuelve cada `{kind, data}` con el `kind` pedido, una vez por `data`.

## 4. En el cliente

```js
const client = new WebSocketProxyClient({ url, bluetooth: true, lan: true })

// Por cada medio que haya (Bluetooth y red local), hasta que se llame a stop().
const stop = await client.announceNearby('pair', invitation)

// Por los dos a la vez; lo visto por los dos sale una vez, con `via`.
const found = await client.discoverNearby({ kind: 'contact', timeoutMs: 6000 })
// → [{ kind: 'contact', data: 'to=…&nick=…', via: 'lan' }]
```

Un medio que falla no tumba al otro (`error` con `type: 'lan_unavailable'`). Si no queda ninguno,
`no-nearby`. Sin cliente, para un comando que solo busca: `import { discoverLan } from
'@dotrino/proxy-client/lan'`.

## 5. Seguridad

Lo mismo que en `bluetooth.md` §7, con un alcance distinto: lo oye toda la red local, no solo quien
está a unos metros. **La red local se considera ambiente seguro** (dueño, 2026-10-23), y por eso la
bóveda anuncia aquí su invitación con la ventana de emparejar abierta (`dotrino-vault/docs/
pairing-protocol.md` §1.6). Una tarjeta de contacto lleva tu llave pública y tu apodo: solo se
anuncia con la pantalla de añadir abierta.

Probado contra el mDNSResponder de Apple (`dns-sd -B` / `-L` y `-R` en una Mac de la misma red), en
los dos sentidos.
