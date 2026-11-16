/** A D-Bus value. Its shape depends on the signature that goes with it. */
export type DBusValue = any

/** A message read from the bus. */
export interface ReceivedMessage {
  type: number; flags: number; serial: number
  path?: string; iface?: string; member?: string; error?: string
  replySerial?: number; destination?: string; sender?: string
  signature: string; body: DBusValue[]
}

/** A value with its type, for `v` (variant). */
export class Variant { constructor (sig: string, value: DBusValue); sig: string; value: DBusValue }
export function variant (sig: string, value: DBusValue): Variant

/** A D-Bus error reply. `dbusName` is the error name; `code` is always `dbus-error`. */
export class DBusError extends Error { constructor (name: string, message?: string); dbusName: string; code: 'dbus-error' }

/** Unwraps variants recursively. */
export function plain (v: DBusValue): DBusValue
/** Splits a signature into complete types: 'sa{sv}as' → ['s', 'a{sv}', 'as']. */
export function splitSig (sig: string): string[]

export class DBusConnection {
  /** Unique name on the bus (from `Hello`). */
  name: string | null
  closed: boolean
  onClose: (() => void) | null
  /** Calls a method and resolves with the reply body. Rejects with `DBusError`. */
  call (m: { destination: string; path: string; iface: string; member: string; signature?: string; body?: DBusValue[] }): Promise<DBusValue[]>
  signal (m: { path: string; iface: string; member: string; signature?: string; body?: DBusValue[] }): void
  export (path: string, handlers: Record<string, Record<string, (args: DBusValue[], msg: ReceivedMessage) => any>>): void
  unexport (path: string): void
  onSignal (fn: (msg: ReceivedMessage) => void): () => boolean
  addMatch (rule: string): Promise<void>
  close (): void
}

/** Opens a bus by address (`unix:path=…`). `null` if that socket does not exist here. Node only. */
export function openBus (address: string): Promise<DBusConnection | null>
/** Opens the user's session bus. `null` without a session bus. Node only. */
export function openSessionBus (): Promise<DBusConnection | null>
/** Opens the system bus. `null` without one. Node only. */
export function openSystemBus (): Promise<DBusConnection | null>
