# Bluetooth: el escalón directo sin red compartida

> Decidido por el dueño el 2026-10-23: el Bluetooth es parte del transporte, no una pieza
> aparte. Va **después de WebRTC directo y antes de TURN**. La red local y el Bluetooth se
> consideran **ambiente seguro**.

Esta página es el **contrato del cable**. Lo cumplen igual el pilar de JS (`src/ble/`) y los
puertos de `dotrino-native` (Kotlin y Swift). Si cambia algo aquí, cambian los tres.

## 1. Dónde va en la escalera

| | Camino | Nombre en `routeTo` / estadísticas |
|---|---|---|
| 1 | socket local | `socket` |
| 2 | WebRTC directo | `direct` |
| 3 | **Bluetooth** | `bluetooth` |
| 4 | WebRTC por TURN | `turn` |
| 5 | el proxio | `proxy` |

Lo mismo que con WebRTC:

- **Subir de escalón no bloquea.** El primer mensaje sale por donde se pueda ahora, y la
  negociación del Bluetooth arranca por detrás en paralelo con la de WebRTC.
- **Ningún servicio elige.** `send`, `sendSealedTo` y compañía mandan por el mejor canal
  abierto: WebRTC si va directo, si no Bluetooth, si no WebRTC por TURN, si no el proxio.
- Un canal que se cae deja de usarse y el siguiente mensaje sale por el escalón de abajo.

Bluetooth es lento (decenas de KB/s): sirve cuando no hay red compartida, no para sustituir a
WebRTC en la misma red.

## 2. Dónde existe

| Entorno | Anuncia (periférico) | Busca (central) |
|---|---|---|
| Node en **Linux** | sí, BlueZ por D-Bus (`src/ble/bluez.js`, sin dependencias) | sí |
| Node en macOS / Windows | no (haría falta un módulo nativo; un `.node` no entra en el SEA de la bóveda) | no |
| Navegador | no | no (Web Bluetooth solo en Chrome, sin periférico y con un selector por conexión) |
| Android (`dotrino-native`) | sí | sí |
| iOS (`dotrino-native`) | sí | sí |

**Pendiente, decidido así (dueño, 2026-10-23): Node en macOS y Windows.** Haría falta un auxiliar
nativo aparte (Swift en macOS, WinRT en Windows), porque un `.node` no entra en el SEA. No corre
prisa: la red local ya deja descubrir la bóveda en los tres sistemas, y el Bluetooth solo añade el
caso de un teléfono cerca sin red compartida, raro con una bóveda en un PC.

Donde no existe, el escalón no está y todo sigue por los demás. Eso no es un fallo. Para anunciar
y descubrir, la red local (`lan.md`, mDNS) sí existe en Node en las tres plataformas, y
`announceNearby` / `discoverNearby` usan los dos medios a la vez.

**En Linux, un solo dueño por proceso.** BlueZ deja registrar varias veces el mismo servicio,
pero quien se conecta solo ve el primero. Así que el primer cliente del proceso que abre el
Bluetooth se lo queda, y los demás siguen sin él (`bluetoothAvailable` en `false`). Lo nota la
bóveda con varios perfiles en un proceso: el Bluetooth es del perfil que arrancó primero.

## 3. GATT

Un servicio, cuatro características. UUID base `0be25149-664d-4d28-b496-3ca98a63fbXX`:

| UUID (`XX`) | Nombre | Propiedades | Contenido |
|---|---|---|---|
| `00` | servicio | primario | — |
| `01` | `hello` | read | JSON UTF-8 `{"v":1,"bid":"<8 bytes en base64url>"}` |
| `02` | `beacon` | read | JSON UTF-8 `{"kind":"…","data":"…"}`, o vacío si no se anuncia nada |
| `03` | `rx` | write | tramas del central al periférico |
| `04` | `tx` | notify | tramas del periférico al central |

**Anuncio:** conectable, solo con el UUID del servicio. No lleva identidad: dice «aquí hay un
aparato de Dotrino» y nada más. Se anuncia mientras el escalón está encendido.

**`bid`** (*bluetooth id*): 8 bytes aleatorios. Se renueva al arrancar y cada 15 minutos. Es lo
que permite reconocer en el aire a quien se negoció por el proxio, y no sirve para nada más.

**`beacon`:** lo que el aparato anuncia a propósito, legible sin estar conectado al proxio.
Como mucho 512 bytes. Dos usos hoy:

| `kind` | `data` | Quién lo pone |
|---|---|---|
| `pair` | la invitación de emparejar (`c…`, `dotrino-vault/docs/pairing-protocol.md` §1.5) | la bóveda, solo con la ventana de «Emparejar» abierta |
| `contact` | la tarjeta pública de contacto (abajo) | la pantalla de añadir amigo, solo mientras está abierta |

**La tarjeta de contacto** es el mismo fragmento que el enlace `#to=` del messenger:

```
to=<base64url de la publickey>&nick=<apodo>
```

- `publickey`: la cadena JWK tal cual la escribe la identidad (`me.publickey`), en UTF-8.
- `nick`: opcional. Se recorta a 40 unidades UTF-16 **y** 60 bytes UTF-8, por puntos de código
  enteros, y se codifica como `encodeURIComponent`: lo que no es `A-Za-z0-9-_.!~*'()` va como `%XX`
  de sus bytes UTF-8, en mayúsculas. Con eso, la tarjeta más larga cabe en el `beacon`.
- `encodeContact` / `decodeContact` (`src/ble/wire.js`, y `BleWire` en `dotrino-native`). Quien la
  recibe manda la solicitud entre pares de siempre a esa llave: aceptar es de los dos.

## 4. Señalización (por el proxio, como la de WebRTC)

Trama de control con `t: "__cc_ble__"`. Va en claro, igual que la de WebRTC, y por eso
`requireSealed` no la para: solo lleva un `bid` aleatorio y una llave pública efímera.

```
{ "t":"__cc_ble__", "kind":"offer",  "bid":"<mi bid>", "epub":"<P-256 sin comprimir, 65 B, base64url>" }
{ "t":"__cc_ble__", "kind":"answer", "bid":"<mi bid>", "epub":"<…>" }
```

1. Quien quiere subir de escalón manda `offer` con una llave ECDH P-256 **nueva** para esta
   negociación.
2. El otro, si tiene Bluetooth, contesta `answer` con la suya.
3. **El del token mayor es el central**: busca en el aire un periférico de Dotrino cuyo
   `hello.bid` sea el del otro, se conecta y se suscribe a `tx`. El del token menor espera la
   conexión. (Mismo sorteo que WebRTC.)
4. Sin `answer` en 10 s, o sin encontrar al otro en 20 s, ese par se da por fallido en este
   escalón hasta que el canal de WebRTC o una reconexión lo vuelvan a intentar.

**Llave del canal:**

```
secreto = ECDH(mi epub privada, epub del otro)
llave   = HKDF-SHA256(ikm = secreto,
                      salt = UTF-8(token menor + "|" + token mayor),
                      info = UTF-8("dotrino-ble-v1"), 32 bytes)
```

## 5. Tramas

Cada valor escrito en `rx` o notificado en `tx` es un **trozo**:

```
rx (central → periférico)   byte 0 banderas ‖ parte del registro
tx (periférico → central)   byte 0 banderas ‖ etiqueta (4 B) ‖ parte del registro

banderas: bit 0 = último trozo del registro; el resto de bits a 0
etiqueta: los 4 primeros bytes del `bid` que el CENTRAL mandó en su señalización
```

**Por qué la etiqueta.** BlueZ (Linux) manda cada notificación a todos los centrales suscritos,
no a uno. Sin etiqueta, un central rearmaría trozos de otro. Cada central descarta los trozos
cuya etiqueta no es la suya. Android e iOS sí notifican a un central concreto, pero la etiqueta
va igual: el cable es uno.

El tamaño del trozo es `MTU − 3`, cabecera incluida. Los trozos de un registro van seguidos y en orden (GATT es
fiable y ordenado). Se rearma concatenando hasta el trozo con el bit de último.

Un **registro** es `AES-256-GCM(llave, nonce, texto)`:

```
nonce = dir (1 B: 0 central→periférico, 1 periférico→central) ‖ 00 00 00 ‖ contador (8 B, big-endian)
texto = tipo (1 B) ‖ cuerpo
          tipo 0  mensaje de texto (JSON UTF-8, el mismo que iría por el proxio)
          tipo 1  mensaje con bytes (un paquete de binpack.js)
          tipo 2  saludo: el token propio en UTF-8
```

El contador empieza en 0 en cada dirección y sube de uno en uno por registro. Un registro que no
se descifra cierra la conexión.

**Saludo:** el central manda primero un registro de tipo 2 con su token. El periférico prueba con
las llaves de sus negociaciones pendientes hasta que una lo descifra (así sabe quién es) y
contesta con el suyo. Con los dos saludos dados, el canal está abierto en las dos puntas.

**Tope de un registro:** 1 MiB. Lo que pasa de ahí ya lo parte el pilar (`parts.js`) con el
tamaño del canal directo.

## 6. Descubrir (sin proxio)

`beacon` se lee sin señalización, así que descubrir funciona sin conexión a internet:

1. Se busca en el aire el UUID del servicio durante el tiempo pedido.
2. A cada aparato nuevo se le lee `beacon` y se desconecta.
3. Se devuelven los que tienen el `kind` pedido.

Lo que se haga con lo descubierto es de quien lo pidió. Una invitación sigue el emparejamiento de
siempre (código tecleado en la bóveda, `cert.iss === qr.iss`, y si responden dos aparatos se
cancela y es un incidente: eso lo decide la bóveda, no el pilar). Una tarjeta de contacto sigue la
solicitud entre pares, y ahí que lleguen varios a la vez es lo normal (un grupo, una partida).

**El pilar no limita cuántos se conectan**: un periférico atiende a varios centrales a la vez, cada
uno con su canal y su llave.

## 7. Seguridad, sin exagerar

- El anuncio no lleva identidad, y el `bid` cambia cada 15 minutos.
- La tarjeta de contacto **sí** lleva tu llave pública y tu apodo, y la lee cualquiera que esté
  cerca. Por eso solo se anuncia con la pantalla de añadir abierta. Es lo mismo que enseñar tu QR.
- La llave del canal sale de un ECDH efímero. El proxio ve las dos llaves públicas, no el secreto.
- Lo que no cierra, y es lo mismo que con WebRTC: un proxio malicioso **y** cerca puede cambiar
  las llaves de la señalización y meterse en medio. Lo que viaja por un canal directo va además
  sellado por la app (`sendSealed`, §4.1 de las convenciones), así que en medio tampoco lee nada.
