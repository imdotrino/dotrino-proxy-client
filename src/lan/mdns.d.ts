/** Announces `{kind, data}` on the local network by mDNS until the returned function is called (docs/lan.md). Node only. Throws `no-lan`. */
export function announceLan (kind: string, data: string): Promise<() => void>
/** What devices on the local network announce with that `kind`. Throws `no-lan`. */
export function discoverLan (opts: { kind?: string; timeoutMs?: number; onFound?: (b: { kind: string; data: string }) => void }): Promise<{ kind: string; data: string }[]>
export const SERVICE: '_dotrino._tcp.local'
export const MAX_DATA: 512
