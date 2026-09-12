# @dotrino/proxy-client

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

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
- Por defecto solo se usan servidores STUN públicos. Sin TURN, los pares en NAT simétrico se quedan en proxy; para atravesarlos activa TURN (sección siguiente).
- La señalización (offer / answer / ICE) se transporta por el propio proxy como mensajes `__cc_rtc__`, así que no necesitas un canal extra.
- Los handlers de `'message'` reciben un tercer argumento con `via: 'webrtc' | 'proxy'` para distinguir el transporte si lo necesitas.
- Pasa `enableWebRTC: false` para volver al comportamiento previo (todo por proxy).

## TURN temporal (0.7.0+)

El proxy actúa como **administrador de credenciales TURN** (Cloudflare): la llave
de Cloudflare vive solo en el servidor y a los clientes se les entregan
credenciales **efímeras** (TTL corto, cuota por pubkey/hora), únicamente en
conexiones **identificadas** con el vault. Así el relay TURN solo lo usan apps
Dotrino y no sirve como relay abierto para tráfico ajeno.

```js
// 1) identify con el vault (igual que para la cola offline)
await client.identify({ data, signature })

// 2) activar TURN: pide credenciales, las inyecta como ICE servers y las renueva sola
const activo = await client.enableTurn({ publicKey, sign })   // false si el proxy no tiene TURN

// O manual, si quieres armar tu propio RTCPeerConnection:
const { enabled, iceServers, expiresAt } = await client.getTurnCredentials({ publicKey, sign })
```

Notas:
- `enableTurn()` afecta a las conexiones P2P **nuevas**; los peers ya negociados conservan su configuración.
- Si el proxy responde `enabled: false` (sin TURN configurado), todo sigue STUN-only con fallback al proxy: no hay que hacer nada.
- El proxy exige `identify` previo en la misma conexión: tras una reconexión, vuelve a llamar a `identify` antes de que toque renovar.

## Cifrado extremo a extremo de mensajes dirigidos (0.13.0+)

**El proxy no cifra el contenido.** `sendByPubkey` enruta por pubkey y manda el
payload tal cual, así que cualquier cosa sensible que viaje así la puede leer quien
opere el proxy. Los canales públicos son públicos por diseño y esto no les aplica;
los mensajes **dirigidos** sí deberían ir sellados.

```js
import { makeEncKeypair } from '@dotrino/proxy-client'

// Un par de CIFRADO, aparte del de firma. Su pública se intercambia al emparejar.
const mio = await makeEncKeypair()          // { privateKey, encPub }

const client = new WebSocketProxyClient({
  url: 'wss://proxy.dotrino.com',
  requireSealed: true,                       // nada en claro, ni al enviar ni al recibir
  myEncPrivateKey: mio.privateKey,           // para abrir lo que me sellen
})

await client.sendSealed(['<pubkey-del-peer>'], { op: 'hola' }, { peerEncPub })
```

Con `requireSealed: true`:

- `sendByPubkey()` con un payload sin sellar **lanza** (`code: 'unsealed'`) en vez de
  enviarlo. Se usa `sendSealed()`.
- Lo que **llega** en claro se descarta y se emite `error` con `{ type: 'unsealed' }`.
  Sellar solo de salida no basta: si la otra punta acepta texto plano, mandarlo así
  se salta el sellado entero, y alguien que nunca leyó nada podría colar un payload
  falso en la app.
- Lo sellado a otro emite `{ type: 'undecipherable' }` y no llega a la app.
- Los `message` que sí llegan traen `meta.sealed`.

**Está apagado por defecto** para no romper las apps existentes, pero es lo que debería
tener cualquier app que mande algo del usuario. La criptografía es la de
`@dotrino/identity/content` (la misma de los secretos sellados del vault), declarada
como **peer dependency**: empaquetarla aquí colaría una copia vieja del pilar en cada
consumidor.

## La llave del otro lado SE AVERIGUA (0.20.0+)

Hasta 0.19 `sendSealed` exigía `peerEncPub` y el pilar no daba **ninguna** forma de
conseguirla. O sea que solo podían sellar dos puntas que se hubieran emparejado antes y
se la hubieran intercambiado a mano — el gestor de contraseñas, y poco más. Una sala de
desconocidos no puede hacer eso, así que seguía mandando en claro.

Desde 0.20.0 cada identidad **anuncia** su llave de cifrado con una frase firmada por la
misma llave con la que se identifica en el cable:

```
{ v:1, op:'encpub', aud:'dotrino:encpub', publickey, encpub, ts }  + signature
```

El proxio se la queda y se la da a quien pregunte. **Es un buzón, no una autoridad**:
devuelve el sobre entero y quien pregunta verifica la firma contra la pubkey a la que va
a escribir. Si el proxio cambiara la llave por la suya para poder leer, la firma no
cuadra y no sale nada — ni sellado ni en claro.

### La receta, para migrar una app

**1. Anunciar la propia llave.** Una línea al construir el cliente; `identify` hace el
resto solo, por detrás y sin bloquear.

```js
// Navegador (la privada vive en la bóveda; la pública no es secreto).
import { getWebSocketProxyClient, identitySealing } from '@dotrino/proxy-client'

const client = getWebSocketProxyClient({
  url: 'wss://proxy.dotrino.com',
  requireSealed: true,
  myEncPub: await identity.getEncryptionPubkey(),
  sealing: identitySealing(identity, { app: 'mundial' }),   // 0.21.0+
})
await client.connect()
await client.identifyAs({ publickey: me.publickey, sign: (d) => identity.signData(d) })
```

`identitySealing` es **el puente de la bóveda**, y viene en el pilar desde 0.21.0: en el
navegador la privada de cifrado no está en la app —vive dentro del iframe y no sale—, así
que sellar y abrir se delegan en `identity.encrypt` / `identity.decrypt`, que es la misma
cripto. Habla los dos dialectos de `@dotrino/identity` (la clase que habla con el iframe y
el núcleo de dentro de un service worker) y comprueba algo que se cuela solo: si la bóveda
envuelve el mensaje **para nadie** —la llave del otro no se pudo importar y el llavero sale
vacío—, lanza con `code: 'unsealed'` en vez de mandar un sobre cifrado que no abre nadie.

`app` es la marca del sobre: quien recibe lo que no es suyo lo descarta por ahí. Es estable
por app y cambiarla es dejar de abrir lo de la versión anterior.

```js
// Aparato headless (la privada es suya).
const mio = await makeEncKeypair()      // { privateKey, encPub }
const client = new WebSocketProxyClient({
  url, requireSealed: true,
  myEncPub: mio.encPub,
  myEncPrivateKey: mio.privateKey,
})
```

**2. Mandar.** Se quita el `peerEncPub` y ya está: el pilar lo averigua, lo verifica y
lo cachea.

```js
// Por pubkey (cola offline 24 h). UNA envoltura por destinatario.
await client.sendSealed([pubkeyDelOtro], { type: 'ROOM_INVITE', url })

// Por token, que es como hablan los de una sala y lo único que sube a WebRTC.
// El token NO dice de quién es: lo dice la app, con lo que ya sabe del canal,
// del saludo de la sala o de la invitación.
await client.sendSealedTo(token, { type: 'hit', enemyId }, { peerPubkey: pubkeyDelOtro })
```

**3. Y si algo falla, mirar el `code`** — nunca la frase (ver más abajo). Los tres
significan cosas distintas y se arreglan de formas distintas:

| `code` | Qué pasó | Qué hacer |
|---|---|---|
| `no-encpub` | nadie ha anunciado llave para esa identidad | el otro lado tiene que actualizar; esperar no sirve |
| `encpub-unverified` | llegó una llave que **esa identidad no firmó** | no se manda nada. Es el caso que importa |
| `no-encpub-support` | el proxio es anterior a `websocket-proxy` 1.1.0 | actualizar el proxio |
| `unsealed` | se intentó mandar en claro con `requireSealed` | usar `sendSealed`/`sendSealedTo` |

**Nada de repliegues.** Si no se puede sellar, **no se manda en claro**: se lanza. Con
varios destinatarios se resuelven todas las llaves **antes** de mandar nada, para que no
quede media sala con el mensaje y la otra media sin él.

### Si ya sabes la llave, no preguntes

Los aparatos de un mismo dueño llevan su llave de cifrado escrita en el **acta**, firmada
por el master — eso es más fuerte que el anuncio. Una app que tiene el acta enchufa:

```js
import { memberEncPub } from '@dotrino/identity/acta'   // ≥ 0.90.0

const client = new WebSocketProxyClient({
  url, requireSealed: true, myEncPub, myEncPrivateKey,
  encPubResolver: (pub) => memberEncPub(acta, pub),      // null = «yo no sé» → pregunta al proxio
})
```

### Lo que esto NO resuelve, dicho en voz alta

- **Sellar a una PERSONA (el `profileId`) y no a un aparato.** Escribir a un `profileId`
  llega a todos sus aparatos, y cada uno tiene su propia llave de cifrado: eso es la
  tarjeta de perfil del acta (`cardBody`), no este directorio. Preguntar por un
  `profileId` que nunca se anunció da `no-encpub`, alto y claro.
- **Rotar la llave de cifrado.** Si alguien la cambia, lo sellado a la anterior deja de
  abrirse y llega como `{ type: 'undecipherable' }`. El anuncio lleva `ts` y el proxio
  nunca acepta uno más viejo que el que tiene, así que nadie puede hacerte retroceder;
  pero rotar sigue costando lo ya enviado.
- **Comparar pubkeys con `===`.** Un JWK serializado no es canónico. Para eso está
  `samePubkey`, que este paquete exporta y usa por dentro.

## Identidad

Cada navegador genera y persiste un par ECDSA P-256 en `localStorage` (`dotrino.proxy-client.keypair`). La pública se incluye en cada operación de canal y sirve como identidad estable entre sesiones (no entre apps con orígenes distintos — para eso usa la librería de identidad).

**En un service worker (0.12.0+)** no hay `localStorage`, y hasta la 0.11.0 eso significaba que el par se regeneraba en cada llamada **sin guardarse**: el aparato cambiaba de identidad cada vez que el worker se dormía, y cualquier peer que lo conociera por su pubkey veía un desconocido. Ahora cae solo a **IndexedDB**, que sí existe en workers y guarda el `CryptoKey` tal cual — así la privada se queda **no extraíble** en vez de escribirse como JWK. No hay que configurar nada. Si necesitas otro almacén:

```js
import { setKeypairStore } from '@dotrino/proxy-client'

// Un almacén que guarda el CryptoKey tal cual (IndexedDB): la privada se queda
// no extraíble.
setKeypairStore({ get: async () => saved, set: async (pair) => { saved = pair } })

// Un almacén que SERIALIZA (disco, texto, red) tiene que exportar la privada a JWK,
// y eso no se puede con una llave no extraíble. Hay que declararlo:
setKeypairStore(storeDeDisco, { extractable: true })
```

Si el almacén no puede guardar, el cliente lo **dice por consola** en vez de seguir en
silencio: sin persistencia la identidad se regenera en cada arranque y los peers que
conocen el aparato por su pubkey dejan de reconocerlo — un fallo que, callado, se
descubre días después y desde el otro lado.

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

**Caso B — PWA con SW propio (vite-plugin-pwa/Workbox, etc.):** NO registres un segundo SW (clobbearía el tuyo). En su lugar, inyecta los handlers de push en tu SW existente y llama a `enablePush()` **sin** `swPath` (usa el SW activo):
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
//     propio, omite swPath (usa el SW activo); ver "Caso B" arriba.
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

Además del timbre event-driven, puedes **programar un push a tu PROPIA pubkey** para una hora futura: el proxy lo dispara aunque la app esté cerrada (despierta el mismo SW). Es **self-only** — el target es siempre la pubkey que firma, así nadie puede programar pushes a terceros (sin vector de spam). Requiere haber activado push (`enablePush`) para que haya una subscription que timbrar.

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

## Errores: comprueba por `code`, nunca por la frase

Cuando una petición falla, el `Error` trae un **`code` estable**. Empareja por
ahí: el texto es para leerlo un humano y puede cambiar o traducirse, y una
comprobación por frase se rompe **en silencio** el día que eso pase.

| `code` | Cuándo |
|---|---|
| `NOT_CONNECTED` | se pidió algo sin conexión abierta |
| `CONNECTION_CLOSED` | se llamó a `close()` con peticiones en vuelo: se cortan en el acto en vez de esperar el timeout |
| `REQUEST_TIMEOUT` | el proxy no contestó en 10 s |
| `unsealed` | se intentó mandar un mensaje dirigido en claro con `requireSealed` |
| `no-encpub` | nadie ha anunciado la llave de cifrado de ese destinatario |
| `encpub-unverified` | llegó una llave que esa identidad no firmó (un proxio hostil, un sobre manipulado) |
| `no-encpub-support` | el proxio no sirve el directorio de llaves (anterior a `websocket-proxy` 1.1.0) |
| `no-signature` | `sign()` no devolvió firma. **No** es un fallo de red: eso se arregla en la bóveda |

```js
try {
  await client.publish('sala')
} catch (e) {
  if (e.code === 'NOT_CONNECTED') reconectar()
  else if (e.code !== 'CONNECTION_CLOSED') mostrarError(e)   // cerrar fue decisión nuestra
}
```

## Diseño

- Sin heartbeat ni polling de respaldo: cada app decide su política.
- Reconexión simple con backoff fijo (configurable).
- Las operaciones de canal devuelven `Promise` (timeout 10 s). `close()` las
  rechaza en el acto (`CONNECTION_CLOSED`): lo que estaba en vuelo ya no va a
  llegar, y esperar el timeout completo solo retrasa la mala noticia.
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

## Deuda conocida

`test/protocol.test.mjs` tiene **tests intermitentes**: esperan frames con un timeout de
10 s y, con la máquina cargada, fallan ~1 de cada 5 pasadas (`list devuelve los tokens`,
`dos peticiones a la vez`). No es una regresión — falla igual en cualquier commit — pero
un test que a veces pasa enseña a ignorar el rojo, que es peor que no tenerlo.
