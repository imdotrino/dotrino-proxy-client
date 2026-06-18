/* dotrino-push-sw.js — Service Worker de "timbre" Web Push del ecosistema
 * Dotrino.
 *
 * El proxy envía un push SIN contenido de usuario ({ type:'ring' }) cuando hay
 * mensajes encolados para esta pubkey estando offline. Este SW:
 *   1. Si la app ya está abierta y visible: le avisa por postMessage para que
 *      reconecte al proxy y baje su cola cifrada (sin mostrar notificación).
 *   2. Si no hay ventana visible: muestra una notificación genérica (no filtra
 *      contenido — el contenido real lo baja la app al abrirse).
 *   3. Al hacer click: enfoca/abre la app.
 *
 * La app debe servir este archivo desde su propio origen (cópialo a tu carpeta
 * pública, p.ej. /public/) y pasarlo como `swPath` a `enablePush()`. Podés
 * personalizar título/cuerpo/idioma editando las constantes de abajo o
 * extendiendo los handlers.
 */

const DEFAULT_TITLE = 'Dotrino'
const DEFAULT_BODY = 'Tenés mensajes nuevos'
const DEFAULT_URL = '/'

self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch (_) { payload = {} }

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Avisar a toda ventana abierta para que drene la cola del proxy.
    for (const c of wins) {
      try { c.postMessage({ type: 'cc-push-ring', payload }) } catch (_) {}
    }
    const visible = wins.some(c => c.visibilityState === 'visible' || c.focused)
    // Si hay una ventana visible, no hace falta notificar.
    if (visible) return
    await self.registration.showNotification(payload.title || DEFAULT_TITLE, {
      body: payload.body || DEFAULT_BODY,
      tag: payload.tag || 'cc-ring',
      renotify: false,
      data: { url: payload.url || DEFAULT_URL }
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || DEFAULT_URL
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of wins) {
      if ('focus' in c) {
        try { c.postMessage({ type: 'cc-push-click' }) } catch (_) {}
        return c.focus()
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url)
  })())
})
