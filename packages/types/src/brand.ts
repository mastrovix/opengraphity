/**
 * IL MARCHIO DI UN'ORGANIZZAZIONE (verifica «Cosa resta cablato», ondata 6):
 * logo e nome mostrati nel portale, nelle e-mail e nei PDF, nome del mittente e
 * indirizzo di risposta. «Powered by OpenGrafo» resta, piccolo, in fondo.
 *
 * Qui la FORMA, condivisa fra API (che lo salva) e pacchetto notifiche (che lo
 * legge per le e-mail). Il dominio d'invio resta della piattaforma
 * (`EMAIL_FROM`): il cliente sceglie il NOME che il destinatario legge e dove
 * arrivano le risposte, non l'indirizzo da cui si spedisce.
 */

export interface TenantBrandLogo {
  /** `image/png` o `image/svg+xml`. */
  mimeType:  string
  /** Percorso del file nello storage degli allegati. */
  path:      string
  updatedAt: string
}

export interface TenantBrand {
  displayName: string
  senderName:  string
  replyTo:     string | null
  logo:        TenantBrandLogo | null
}

/** Il marchio con cui nasce ogni organizzazione: quello del prodotto. */
export const FACTORY_TENANT_BRAND: Readonly<TenantBrand> = {
  displayName: 'OpenGrafo', senderName: 'OpenGrafo', replyTo: null, logo: null,
}

export const BRAND_NAME_MAX_LENGTH = 80
export const BRAND_LOGO_MAX_BYTES = 1024 * 1024
export const BRAND_LOGO_MIME_TYPES = ['image/png', 'image/svg+xml'] as const

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/

export class BrandError extends Error {
  constructor(message: string, readonly key: string, readonly params: Record<string, string | number> = {}) { super(message) }
}

/** Un nome leggibile che può stare in un'intestazione `From:` senza romperla. */
export function assertBrandName(raw: unknown, field: 'displayName' | 'senderName'): string {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (v.length === 0 || v.length > BRAND_NAME_MAX_LENGTH || /[<>"\r\n]/.test(v)) {
    throw new BrandError(`${field}: 1–${String(BRAND_NAME_MAX_LENGTH)} characters, without < > " or line breaks`, `errors.brand.${field}`, { max: BRAND_NAME_MAX_LENGTH })
  }
  return v
}

export function assertReplyTo(raw: unknown): string | null {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!EMAIL_RE.test(v) || v.length > 254) throw new BrandError(`replyTo "${String(raw)}" is not an e-mail address`, 'errors.brand.replyTo', { value: String(raw) })
  return v
}

/** Legge `Tenant.brand` (JSON). Assente = il marchio del prodotto; illeggibile = errore. */
export function parseTenantBrand(raw: unknown, tenantId: string): TenantBrand & { isDefault: boolean } {
  if (raw == null) return { ...FACTORY_TENANT_BRAND, isDefault: true }
  let parsed: unknown
  try { parsed = JSON.parse(String(raw)) }
  catch (e) { throw new Error(`Tenant ${tenantId}: brand is not valid JSON (${e instanceof Error ? e.message : String(e)})`) }
  const o = (parsed ?? {}) as Record<string, unknown>
  const logo = o['logo'] as Record<string, unknown> | null | undefined
  return {
    displayName: assertBrandName(o['displayName'], 'displayName'),
    senderName:  assertBrandName(o['senderName'], 'senderName'),
    replyTo:     assertReplyTo(o['replyTo']),
    logo: logo && typeof logo['path'] === 'string' && (BRAND_LOGO_MIME_TYPES as readonly string[]).includes(String(logo['mimeType']))
      ? { mimeType: String(logo['mimeType']), path: String(logo['path']), updatedAt: String(logo['updatedAt'] ?? '') }
      : null,
    isDefault: false,
  }
}

/** L'indirizzo dentro `Nome <indirizzo>` (o l'indirizzo stesso). */
export function emailAddressOf(from: string): string {
  const m = /<([^>]+)>\s*$/.exec(from)
  return (m ? m[1]! : from).trim()
}

/** Il mittente con il nome del cliente e l'indirizzo della piattaforma. */
export function brandedFrom(platformFrom: string, senderName: string): string {
  return `${senderName} <${emailAddressOf(platformFrom)}>`
}
