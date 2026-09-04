/**
 * Minimal, dependency-free error surface for the portal.
 *
 * The portal has no toast library; without this, every failed GraphQL request
 * (including the 30s background poll) is invisible. `notifyError` shows a
 * dismissible banner, deduped so a burst of failures shows one message.
 */
const DEDUPE_MS = 5_000
const recent = new Map<string, number>()

export function notifyError(message: string): void {
  const now = Date.now()
  const last = recent.get(message)
  if (last !== undefined && now - last < DEDUPE_MS) return
  recent.set(message, now)

  if (typeof document === 'undefined') return

  let host = document.getElementById('portal-error-host')
  if (!host) {
    host = document.createElement('div')
    host.id = 'portal-error-host'
    host.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:360px;font-family:system-ui,sans-serif'
    document.body.appendChild(host)
  }

  const banner = document.createElement('div')
  banner.setAttribute('role', 'alert')
  banner.style.cssText =
    'background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.08);cursor:pointer;line-height:1.4'
  banner.textContent = message
  banner.title = 'Clicca per chiudere'
  banner.onclick = () => banner.remove()
  host.appendChild(banner)

  window.setTimeout(() => banner.remove(), 8_000)
}
