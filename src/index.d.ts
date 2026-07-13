export interface WebSocketProxyClientOptions {
  url?: string
  autoReconnect?: boolean
  maxReconnectAttempts?: number
  reconnectDelay?: number
  /** Enable WebRTC DataChannel transport with proxy fallback. Default true. */
  enableWebRTC?: boolean
  /** Override ICE servers (STUN-only by default). */
  iceServers?: RTCIceServer[]
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
  identify (envelope: { data: any; signature: string }): Promise<{ publickey: string; queued_delivered: number }>
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
export function buildSignedChannel (
  channelName: string,
  extraData?: Record<string, any>
): Promise<{ data: { name: string; publickey: string; [k: string]: any }; signature: string }>

export function getWebSocketProxyClient (
  options?: WebSocketProxyClientOptions
): WebSocketProxyClient
