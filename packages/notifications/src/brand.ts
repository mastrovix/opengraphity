/**
 * Il marchio del cliente nelle e-mail (verifica «Cosa resta cablato», ondata 6).
 *
 * Una sola impaginazione per tutte le e-mail che escono — quelle delle regole di
 * notifica (dispatcher) e quelle dell'API (menzioni, osservatori, riepilogo) —
 * con il logo e il nome dell'organizzazione in testa, e «Powered by OpenGrafo»
 * piccolo in fondo. Il mittente porta il nome scelto dal cliente e l'indirizzo
 * della piattaforma; le risposte vanno dove il cliente ha detto.
 *
 * Cache breve come per la lingua: si legge a ogni e-mail.
 */
import { getSession } from '@opengraphity/neo4j'
import { parseTenantBrand, type TenantBrand } from '@opengraphity/types'
import { tenantAppUrl } from './appUrl.js'
import { escapeHtml as e } from './escapeHtml.js'
import { sendEmail, type EmailMessage } from './email.js'

const TTL_MS = 30_000
const cache = new Map<string, { brand: TenantBrand; expires: number }>()

export function invalidateTenantBrand(tenantId?: string): void {
  if (tenantId === undefined) cache.clear()
  else cache.delete(tenantId)
}

export async function loadTenantBrand(tenantId: string): Promise<TenantBrand> {
  const now = Date.now()
  const hit = cache.get(tenantId)
  if (hit && hit.expires > now) return hit.brand
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.brand AS brand', { tenantId }))
    const row = res.records[0]
    if (!row) throw new Error(`[notifications] Tenant ${tenantId} not found: cannot read its brand`)
    const { isDefault: _d, ...brand } = parseTenantBrand(row.get('brand'), tenantId)
    cache.set(tenantId, { brand, expires: now + TTL_MS })
    return brand
  } finally {
    await session.close()
  }
}

/** L'indirizzo pubblico del logo (le e-mail non hanno la sessione di chi le legge). */
export function brandLogoUrl(tenantId: string, brand: TenantBrand): string | null {
  if (!brand.logo) return null
  return `${tenantAppUrl(tenantId)}/api/brand/${encodeURIComponent(tenantId)}/logo?v=${encodeURIComponent(brand.logo.updatedAt)}`
}

/** Impaginazione di un'e-mail: marchio in testa, contenuto, «Powered by OpenGrafo» in fondo. */
export function brandedEmailHtml(tenantId: string, brand: TenantBrand, content: string, language: string): string {
  const logo = brandLogoUrl(tenantId, brand)
  const head = logo
    ? `<img src="${e(logo)}" alt="${e(brand.displayName)}" height="32" style="height:32px;max-width:220px;vertical-align:middle;border:0;">`
      + `<span style="color:#0F172A;font-size:15px;font-weight:700;margin-left:10px;vertical-align:middle;">${e(brand.displayName)}</span>`
    : `<span style="color:#0F172A;font-size:18px;font-weight:700;">${e(brand.displayName)}</span>`
  return `<!DOCTYPE html><html lang="${e(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;">
<tr><td style="padding:16px 24px;border-bottom:1px solid #E2E8F0;">${head}</td></tr>
<tr><td style="padding:24px;">${content}</td></tr>
<tr><td style="padding:12px 24px;border-top:1px solid #E2E8F0;text-align:center;">
<span style="font-size:10px;color:#94A3B8;">Powered by OpenGrafo</span>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

/** Manda un'e-mail a nome dell'organizzazione: mittente con il suo nome, risposte al suo indirizzo. */
export async function sendTenantEmail(tenantId: string, msg: Omit<EmailMessage, 'from' | 'senderName' | 'replyTo'>): Promise<void> {
  const brand = await loadTenantBrand(tenantId)
  await sendEmail({ ...msg, senderName: brand.senderName, replyTo: brand.replyTo })
}
