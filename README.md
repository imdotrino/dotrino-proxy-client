# @dotrino/proxy-client

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Misión: aplicaciones que resuelven problemas comunes, respetando tu privacidad — sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Cliente WebSocket para el proxy de Dotrino. Maneja la conexión, el token efímero, mensajes peer-to-peer y canales públicos firmados con ECDSA P-256.

## Instalación

```bash
npm install @dotrino/proxy-client
```

## Uso

```js
import { WebSocketProxyClient } from '@dotrino/proxy-client'

const client = new WebSocketProxyClient({ url: 'wss://proxy.dotrino.com' })

client.on('token', (token) => console.log('mi token:', token))
client.on('message', (from, payload) => console.log('de', from, ':', payload))
client.on('channel_joined', (channel, token) => console.log(token, 'entró a', channel))
client.on('channel_left', (channel, token) => console.log(token, 'salió de', channel))

await client.connect()

// Publicar en un canal público (firmado con tu clave local)
await client.publish('chat_room_general')

// Listar miembros y canales
const tokens = await client.list('chat_room_general')
const channels = await client.listChannels({ prefix: 'chat_room_' })
const count = await client.channelCount('chat_room_general')

// Mensaje directo
client.send(['ABCD'], { type: 'hello', text: 'hi' })

// Cerrar pair lógico
await client.disconnectFrom('ABCD')
```

## Transporte WebRTC (P2P) con fallback al proxy

Por defecto el cliente intenta abrir un `RTCDataChannel` con cada peer al que le envías mensajes. Si la negociación tiene éxito, los `send()` posteriores viajan directamente entre navegadores; si falla (NAT simétrico, etc.) se sigue usando el proxy de forma transparente.

```js
const client = new WebSocketProxyClient({
  url: 'wss://proxy.dotrino.com',
  enableWebRTC: true,           // default
  // iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]  // override opcional
})

client.on('webrtc_open',  (token) => console.log('P2P abierto con', token))
client.on('webrtc_close', (token) => console.log('P2P cerrado con', token))

// Forzar handshake antes de enviar
await client.connectWebRTC('ABCD')
client.send('ABCD', { type: 'hello' })  // viaja P2P si está abierto
```

Notas:
- Solo se usan servidores STUN públicos. Sin TURN, los pares en NAT simétrico se quedan en proxy (es el comportamiento esperado).
- La señalización (offer / answer / ICE) se transporta por el propio proxy como mensajes `__cc_rtc__`, así que no necesitas un canal extra.
- Los handlers de `'message'` reciben un tercer argumento con `via: 'webrtc' | 'proxy'` para distinguir el transporte si lo necesitas.
- Pasa `enableWebRTC: false` para volver al comportamiento previo (todo por proxy).

## Identidad

Cada navegador genera y persiste un par ECDSA P-256 en `localStorage` (`dotrino.proxy-client.keypair`). La pública se incluye en cada operación de canal y sirve como identidad estable entre sesiones (no entre apps con orígenes distintos — para eso usa la librería de identidad).

```js
const pubkeyJwk = await client.getPublicKey()
const signature = await client.sign({ msg: 'hola' })
```

## Cola offline + fan-out multi-instancia (0.4.0+)

Para mensajes que deben llegar aunque el destinatario esté offline, el proxy mantiene una cola por **publickey**. Para usarla, el cliente llama a `identify()` con un sobre firmado externamente (típicamente por el identity vault), y luego direcciona por `to_publickey` en lugar de `to`.

```js
import { Identity } from '@dotrino/identity'

const id = await Identity.connect()
await client.connect()

// Bind: el proxy asocia mi pubkey con mi token actual
const data = { op: 'identify', publickey: id.me.publickey, token: client.token, ts: Date.now() }
const { signature } = await id.signData(data)
const result = await client.identify({ data, signature })
//   result = { publickey, queued_delivered: <N> }   ← N mensajes en cola que llegan al instante

// Enviar por pubkey: si el peer tiene 1+ instancias online, fan-out a todas;
// si no, queda en cola del proxy 24h y se entrega al primer reconnect.
client.sendByPubkey(['<peer-publickey-jwk>'], { type: 'dm', text: 'hola' })
```

En los handlers `'message'`, el tercer argumento incluye:
- `meta.via`: `'webrtc' | 'proxy'`
- `meta.fromPubkey`: la pubkey del remitente (poblada cuando llegó por `to_publickey`).
- `meta.queued`: `true` si venía de la cola offline.
- `meta.queuedAt`: timestamp ISO de cuando se encoló.

## Web Push — "timbre" para mensajes offline (0.5.0+)

Cuando un mensaje cae a la cola offline, el proxy puede mandar un **Web Push** (sin contenido de usuario) que despierta al Service Worker del destinatario para que reconecte y baje su cola cifrada. Usa **Web Push estándar + VAPID** — **no** el SDK de Firebase, ni JS de terceros, ni cookies. El push solo dice "despertá"; el contenido nunca pasa por el push service (en Android, FCM solo ve el metadato del timbre).

**Requisitos:** el proxy debe tener VAPID configurado, y la app debe tener un Service Worker.

**Caso A — app sin SW propio:** copiá `node_modules/@dotrino/proxy-client/sw/dotrino-push-sw.js` a tu carpeta pública y pasá `swPath`:
```js
await client.enablePush({ publicKey, sign, swPath: '/dotrino-push-sw.js' })
```

**Caso B — PWA con SW propio (vite-plugin-pwa/Workbox, etc.):** NO registres un segundo SW (clobbearía el tuyo). En su lugar, inyectá los handlers de push en tu SW existente y llamá `enablePush()` **sin** `swPath` (usa el SW activo):
```js
// vite.config.js → VitePWA({ workbox: { importScripts: ['dotrino-push-sw.js'] } })
// (copiá el SW a public/ para que importScripts lo encuentre)
await client.enablePush({ publicKey, sign })   // reutiliza navigator.serviceWorker.ready
```

```js
import { Identity } from '@dotrino/identity'

const id = await Identity.connect()
await client.connect()

// (1) identify primero: el push se liga a la MISMA pubkey del vault.
const data = { op: 'identify', publickey: id.me.publickey, token: client.token, ts: Date.now() }
const { signature } = await id.signData(data)
await client.identify({ data, signature })

// (2) Activar push: crea la subscription y la registra (firmada por el vault)
//     en el proxy. La VAPID se pide sola si no la pasás. Para una PWA con SW
//     propio, omití swPath (usa el SW activo); ver "Caso B" arriba.
await client.enablePush({
  publicKey: id.me.publickey,
  sign: (d) => id.signData(d)        // mismo firmante que identify
})

// Desactivar (cancela local + borra del proxy):
await client.disablePush({ publicKey: id.me.publickey, sign: (d) => id.signData(d) })
```

El Service Worker, al recibir el timbre, hace `postMessage({ type: 'cc-push-ring' })` a las ventanas abiertas (para que la app reconecte y drene la cola) y, si no hay ventana visible, muestra una notificación genérica. Al hacer click enfoca/abre la app. Personalizá título/cuerpo editando el archivo del SW.

> **Privacidad:** vos nunca manejás la push-subscription de un contacto — solo su pubkey. "Mandarle un push" no es una acción aparte: es `sendByPubkey(pubkeyDelAmigo, ...)`; si está offline, el proxy le toca el timbre solo.

## Push programado / auto-recordatorios (0.6.0+)

Además del timbre event-driven, podés **programar un push a tu PROPIA pubkey** para una hora futura: el proxy lo dispara aunque la app esté cerrada (despierta el mismo SW). Es **self-only** — el target es siempre la pubkey que firma, así nadie puede programar pushes a terceros (sin vector de spam). Requiere haber activado push (`enablePush`) para que haya una subscription que timbrar.

```js
// One-shot: dentro de 1 hora
const { jobId, nextFire } = await client.schedulePush({
  publicKey: id.me.publickey,
  sign: (d) => id.signData(d),
  when: Date.now() + 3600_000,
  payload: { title: 'Recordatorio', body: 'Revisá tus pronósticos' } // opcional
})

// Recurrente (cron + timezone IANA): lunes 08:30 hora de Buenos Aires
await client.schedulePush({
  publicKey: id.me.publickey,
  sign: (d) => id.signData(d),
  cron: '30 8 * * 1',
  tz: 'America/Argentina/Buenos_Aires'
})

const jobs = await client.listScheduledPushes({ publicKey: id.me.publickey, sign: (d) => id.signData(d) })
await client.cancelScheduledPush({ publicKey: id.me.publickey, sign: (d) => id.signData(d), jobId })
```

Notas:
- **One-shot vs recurrente**: pasá `when` (Date|ms) **o** `cron` (+ `tz`). El cron es de 5 campos (estándar).
- **Catch-up**: si el proxy estuvo caído cuando vencía un job, **no** lo dispara tarde — los one-shot vencidos se descartan y los recurrentes avanzan al próximo futuro.
- **Best-effort**: un recordatorio es un timbre puro (no un mensaje); si al disparar no hay subscription activa, no pasa nada (no se encola).

## Eventos

| evento              | argumentos                       |
|---------------------|----------------------------------|
| `connect`           | —                                |
| `token`             | `(token)`                        |
| `disconnect`        | `({ code, reason })`             |
| `error`             | `(error)`                        |
| `message`           | `(from, payload, { raw, ts })`   |
| `channel_joined`    | `(channel, token)`               |
| `channel_left`      | `(channel, token)`               |
| `peer_disconnected` | `(token, channel?)`              |
| `reconnecting`      | `(attempt, maxAttempts)`         |
| `reconnect_failed`  | `(attempts)`                     |
| `abuse_notice`      | `({ from, operation, severity, timestamp })` — el proxy avisa que `from` está enviando demasiado. Las apps pueden penalizar el ranking de ese token. |

## Diseño

- Sin heartbeat ni polling de respaldo: cada app decide su política.
- Reconexión simple con backoff fijo (configurable).
- Las operaciones de canal devuelven `Promise` (timeout 10s).
- La firma usa JSON canónico (claves ordenadas) para que el proxy verifique con la misma representación.

## Publicación (npm)

Paquete público en npm: `@dotrino/proxy-client`.

```bash
npm login                 # requerido (scope @dotrino, --access public)
npm version               # ya está en 0.5.0; usar `npm version patch|minor` para futuros bumps
npm publish --access public
```

Tras publicar, las apps actualizan con `npm i @dotrino/proxy-client@latest`
y, para Web Push, copian el Service Worker a su carpeta pública:

```bash
cp node_modules/@dotrino/proxy-client/sw/dotrino-push-sw.js public/
```

## Licencia

MIT
