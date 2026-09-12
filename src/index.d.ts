export interface WebSocketProxyClientOptions {
  url?: string
  autoReconnect?: boolean
  maxReconnectAttempts?: number
  reconnectDelay?: number
  /** Enable WebRTC DataChannel transport with proxy fallback. Default true. */
  enableWebRTC?: boolean
  /** Override ICE servers (STUN-only by default). */
  iceServers?: RTCIceServer[]
  /** Refuse to send OR accept directed messages in the clear (`send` and `sendByPubkey`). */
  requireSealed?: boolean
  /** My encryption private key, to open what is sealed to me (headless devices). */
  myEncPrivateKey?: CryptoKey
  /**
   * My PUBLIC encryption key. With it set, `identify` announces it (signed) so anyone who
   * knows my pubkey can seal to me without ever having paired.
   */
  myEncPub?: string
  /** Delegate sealing to the vault (browser apps, where the private key is not here). */
  sealing?: SealingBridge
  /**
   * Answer "what is this identity's encryption key?" locally when it is already known —
   * an app holding the profile's acta plugs `memberEncPub(acta, pub)` in here. Returning
   * null means "I do not know": the proxy directory is asked next, and if nobody knows,
   * nothing is sent.
   */
  encPubResolver?: (publickey: string) => Promise<string | null> | string | null
  acceptDirectFrom?: (token: string) => boolean
}

/** What an app plugs in when the encryption private key lives in the vault, not here. */
export interface SealingBridge {
  seal (message: any, peerEncPub: string): Promise<any>
  open (envelope: any, meta?: any): Promise<any>
  isSealed (message: any): boolean
}

/** The signed statement that binds an encryption key to an identity. */
export interface EncPubStatement {
  data: {
    v: 1
    op: 'encpub'
    aud: string
    publickey: string
    encpub: string
    ts: number
  }
  signature: string
}

export interface ChannelEntry {
  name: string
  count: number
}

export interface ListChannelsOptions {
  prefix?: string
}

export type ProxyEvent =
  | 'connect'
  | 'token'
  | 'disconnect'
  | 'error'
  | 'message'
  | 'channel_joined'
  | 'channel_left'
  | 'peer_disconnected'
  | 'reconnecting'
  | 'reconnect_failed'
  | 'abuse_notice'
  | 'webrtc_open'
  | 'webrtc_close'
  | 'unknown'

export interface AbuseNotice {
  from: string
  operation: string
  severity: 'soft'
  timestamp: string
}

/** Callback de firma del vault (id.signData): devuelve la firma base64. */
export type SignFn = (data: any) => Promise<string | { signature: string }>

export interface PushConfig {
  enabled: boolean
  vapidPublicKey: string | null
}

export interface EnablePushOptions {
  /** Pubkey JWK string del vault (la misma usada en identify). */
  publicKey: string
  /** Firma del vault (id.signData). */
  sign: SignFn
  /** VAPID pública; si falta se pide al proxy con getPushConfig(). */
  vapidPublicKey?: string
  /** SW ya registrado a reutilizar (PWAs con SW propio). */
  registration?: ServiceWorkerRegistration
  /** Ruta de un SW a registrar (apps sin SW propio). Si se omite, usa el SW activo. */
  swPath?: string
  /** Scope del Service Worker (solo con swPath). */
  swScope?: string
}

export interface TurnCredentialsOptions {
  /** Pubkey JWK string del vault (la misma usada en identify). */
  publicKey: string
  /** Firma del vault (id.signData). */
  sign: SignFn
}

export interface TurnCredentials {
  /** false si el proxy no tiene TURN (Cloudflare) configurado. */
  enabled: boolean
  /** ICE servers con credenciales temporales (usuario/clave con TTL). */
  iceServers: RTCIceServer[] | null
  /** Epoch ms en que expiran las credenciales. */
  expiresAt: number | null
}

export interface DisablePushOptions {
  publicKey: string
  sign: SignFn
  registration?: ServiceWorkerRegistration
  swPath?: string
}

export interface SchedulePushOptions {
  publicKey: string
  sign: SignFn
  /** One-shot: instante futuro (Date o epoch ms). Usar esto o `cron`. */
  when?: Date | number
  /** Recurrente: expresión cron de 5 campos. */
  cron?: string
  /** Timezone IANA para el cron (ej. 'America/Argentina/Buenos_Aires'). */
  tz?: string
  /** Datos extra opcionales para la notificación (ej. { title }). */
  payload?: Record<string, unknown>
}

export interface ScheduledPush {
  jobId: number
  nextFire: number
  cron: string | null
  tz: string | null
  payload: Record<string, unknown> | null
}

export class WebSocketProxyClient {
  constructor (options?: WebSocketProxyClientOptions)
  readonly isConnected: boolean
  token: string | null
  connect (): Promise<string>
  close (): void
  on (event: ProxyEvent, handler: (...args: any[]) => void): () => void
  off (event: ProxyEvent, handler: (...args: any[]) => void): void
  send (to: string | string[], payload: any): void
  disconnect (): void
  updateConfig (options: WebSocketProxyClientOptions): void
  publish (channel: string, extraData?: Record<string, any>): Promise<any>
  unpublish (channel: string): Promise<any>
  list (channel: string): Promise<string[]>
  listChannel (channel: string): Promise<string[]>
  /** Observar un canal read-only: recibir joined/left/peer_disconnected en vivo sin figurar como miembro. Devuelve los tokens actuales. */
  watch (channel: string): Promise<string[]>
  /** Dejar de observar un canal. */
  unwatch (channel: string): Promise<any>
  listChannels (options?: ListChannelsOptions): Promise<ChannelEntry[]>
  channelCount (channel: string): Promise<number>
  disconnectFrom (targetToken: string): Promise<any>
  sendByPubkey (toPubkeys: string | string[], payload: any): void
  /**
   * Seal towards each recipient's encryption key and send by pubkey.
   *
   * With no `peerEncPub` the key is resolved (local resolver, then the proxy directory)
   * and VERIFIED against the pubkey being written to. If any recipient's key cannot be
   * resolved, nothing is sent at all — it throws with `code`: 'no-encpub' (nobody has
   * announced one), 'encpub-unverified' (a key arrived that that identity did not sign),
   * or 'no-encpub-support' (this proxy is older than websocket-proxy 1.1.0).
   */
  sendSealed (
    toPubkeys: string | string[],
    payload: any,
    opts?: { peerEncPub?: string; ephemeral?: boolean }
  ): Promise<void>
  /**
   * Seal and send BY TOKEN (which is what peers in a room use, and the only route that
   * can upgrade to WebRTC). A token does not say whose it is, so the app states it with
   * `peerPubkey` — from the channel, the room roster or the invite.
   */
  sendSealedTo (
    toTokens: string | string[],
    payload: any,
    opts: { peerPubkey?: string; peerEncPub?: string }
  ): Promise<void>
  /** Announce my encryption key, signed. `identify` does it on its own when `myEncPub` is set. */
  announceEncPub (args: { publickey: string; encPub: string; sign: SignFn }): Promise<string>
  /** An identity's encryption key, verified. Never returns null: it resolves or throws. */
  encPubOf (publickey: string): Promise<string>
  /** Take in a key that already comes signed by its owner (from an invite, a channel). */
  learnEncPub (statement: EncPubStatement, args: { publickey: string }): Promise<string>
  /** Forget what was learnt about an identity (it rotated its key), or about everyone. */
  forgetEncPub (publickey?: string | null): void
  /** What this proxy says it can do, from the `connected` frame. Null on older proxies. */
  readonly caps: string[] | null
  /** The proxy's wire protocol number. Null on proxies from before it was announced. */
  readonly protocol: number | null
  identify (envelope: { data: any; signature: string; cert?: any; acta?: any; sign?: (data: any) => Promise<any> }): Promise<{ publickey: string; queued_delivered: number }>
  /** PARA QUIÉN firmamos cuando le hablamos a este proxio: la URL a la que estamos conectados. */
  readonly audience: string
  /**
   * Identificarse armando el sobre aquí: `{op:'identify', aud, publickey, token, ts}` firmado
   * con `sign`. Es la forma normal — el sobre a mano estaba copiado en doce repos.
   */
  identifyAs (args: { publickey: string; sign: (data: any) => Promise<any>; cert?: any; acta?: any }): Promise<{ publickey: string; queued_delivered: number }>
  /** Pedir credenciales TURN temporales al proxy (requiere identify previo en esta conexión). */
  getTurnCredentials (opts: TurnCredentialsOptions): Promise<TurnCredentials>
  /** Activar TURN en WebRTC: inyecta las credenciales temporales y las renueva sola. */
  enableTurn (opts: TurnCredentialsOptions): Promise<boolean>
  /** Consultar la config de Web Push del proxy. */
  getPushConfig (): Promise<PushConfig>
  /** Activar Web Push: registra el SW, crea la subscription y la registra (firmada) en el proxy. */
  enablePush (opts: EnablePushOptions): Promise<PushSubscription>
  /** Desactivar Web Push: cancela la subscription local y la borra del proxy. */
  disablePush (opts: DisablePushOptions): Promise<void>
  /** Programar un push a la propia pubkey (one-shot o cron). Self-only. */
  schedulePush (opts: SchedulePushOptions): Promise<{ jobId: number; nextFire: number }>
  /** Cancelar un push programado propio. */
  cancelScheduledPush (opts: { publicKey: string; sign: SignFn; jobId: number }): Promise<number>
  /** Listar los push programados propios. */
  listScheduledPushes (opts: { publicKey: string; sign: SignFn }): Promise<ScheduledPush[]>;
  connectWebRTC (token: string): Promise<void>
  isWebRTCOpen (token: string): boolean
  getPublicKey (): Promise<string>
  sign (data: any): Promise<string>
}

export function canonicalStringify (value: any): string
export function getPublicKeyJwk (): Promise<string>
export function signData (data: any): Promise<string>
/** Verify someone else's signature over the canonical JSON of `data`. */
export function verifyData (publickeyJwkStr: string, data: any, signatureB64: string): Promise<boolean>
/** Are these the same key? Never compare serialized JWKs with `===`. */
export function samePubkey (a: string, b: string): boolean
export const ENCPUB_V: 1
export const ENCPUB_AUD: string
export function isEncPub (v: string): boolean
export function encPubBody (args: { publickey: string; encPub: string; ts?: number }): EncPubStatement['data']
export function buildEncPubStatement (
  args: { publickey: string; encPub: string; sign: SignFn }
): Promise<EncPubStatement>
/** Read someone's announcement and return the key, or throw with `code`. Never null. */
export function readEncPubStatement (
  statement: EncPubStatement,
  args: { publickey: string }
): Promise<string>
export function buildSignedChannel (
  channelName: string,
  extraData?: Record<string, any>
): Promise<{ data: { name: string; publickey: string; [k: string]: any }; signature: string }>

export function getWebSocketProxyClient (
  options?: WebSocketProxyClientOptions
): WebSocketProxyClient
