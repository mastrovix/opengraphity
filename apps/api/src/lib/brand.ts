/**
 * IL MARCHIO DELL'ORGANIZZAZIONE sull'API (verifica «Cosa resta cablato»,
 * ondata 6): lettura, nome e mittente, logo. La forma e le regole stanno in
 * `@opengraphity/types` (`brand.ts`), perché le legge anche il pacchetto delle
 * notifiche per le e-mail.
 *
 * Il logo sta nello storage degli allegati (`ATTACHMENT_DIR/<tenant>/_brand/`),
 * PNG o SVG fino a 1 MB. Un SVG con script, gestori di eventi o `javascript:`
 * è rifiutato: il logo si serve anche aperto da solo, fuori da un `<img>`.
 */
import fs from 'fs'
import path from 'path'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import {
  BRAND_LOGO_MAX_BYTES, BrandError, assertBrandName, assertReplyTo, parseTenantBrand,
  type TenantBrand,
} from '@opengraphity/types'
import { invalidateTenantBrand } from '@opengraphity/notifications'
import { NotFoundError, ValidationError } from './errors.js'
import { config } from './config.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

const cache = createMetamodelCache<TenantBrand & { isDefault: boolean }>({
  name: 'tenant-brand',
  load: (tenantId) => loadBrand(tenantId),
})

/** Solo per i test. */
export function clearBrandCache(): void { cache.clear() }

export function tenantBrand(tenantId: string): Promise<TenantBrand & { isDefault: boolean }> {
  return cache.get(tenantId)
}

function toValidation(err: unknown): never {
  if (err instanceof BrandError) throw new ValidationError(err.message, { key: err.key, params: err.params })
  throw err
}

async function loadBrand(tenantId: string): Promise<TenantBrand & { isDefault: boolean }> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.brand AS raw', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    return parseTenantBrand(row.raw, tenantId)
  } finally {
    await session.close()
  }
}

async function writeBrand(tenantId: string, brand: TenantBrand): Promise<TenantBrand & { isDefault: boolean }> {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session,
      'MATCH (t:Tenant {id: $tenantId}) SET t.brand = $json, t.updated_at = $now RETURN t.id AS id',
      { tenantId, json: JSON.stringify(brand), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  invalidateTenantBrand(tenantId)
  return { ...brand, isDefault: false }
}

export async function setTenantBrandTexts(tenantId: string, input: { displayName: unknown; senderName: unknown; replyTo: unknown }): Promise<TenantBrand & { isDefault: boolean }> {
  let texts: Pick<TenantBrand, 'displayName' | 'senderName' | 'replyTo'>
  try {
    texts = { displayName: assertBrandName(input.displayName, 'displayName'), senderName: assertBrandName(input.senderName, 'senderName'), replyTo: assertReplyTo(input.replyTo) }
  } catch (err) { toValidation(err) }
  const current = await loadBrand(tenantId)
  return writeBrand(tenantId, { ...texts, logo: current.logo })
}

// ── Logo ─────────────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SVG_FORBIDDEN = /<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|xlink:href\s*=\s*["'](?!#)|href\s*=\s*["'](?!#)/i

/** Il tipo vero del file, dal contenuto (il MIME del browser non prova niente). */
export function detectLogoType(content: Buffer): 'image/png' | 'image/svg+xml' {
  if (content.length > BRAND_LOGO_MAX_BYTES) {
    throw new ValidationError('The logo is larger than 1 MB.', { key: 'errors.brand.logoSize', params: { max: 1 } })
  }
  if (content.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png'
  const text = content.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    if (SVG_FORBIDDEN.test(text)) {
      throw new ValidationError('The SVG logo contains scripts, event handlers or external links.', { key: 'errors.brand.logoUnsafe', params: {} })
    }
    return 'image/svg+xml'
  }
  throw new ValidationError('The logo must be a PNG or SVG image.', { key: 'errors.brand.logoType', params: {} })
}

function brandDir(tenantId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) throw new Error(`Unsafe tenant id for a path: ${tenantId}`)
  return path.join(config.attachmentDir, tenantId, '_brand')
}

export async function setTenantLogo(tenantId: string, content: Buffer): Promise<TenantBrand & { isDefault: boolean }> {
  const mimeType = detectLogoType(content)
  const dir = brandDir(tenantId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, mimeType === 'image/png' ? 'logo.png' : 'logo.svg')
  const current = await loadBrand(tenantId)
  fs.writeFileSync(file, content)
  // Un logo dell'altro tipo, se c'era, non serve più.
  if (current.logo && current.logo.path !== file && fs.existsSync(current.logo.path)) fs.unlinkSync(current.logo.path)
  const { isDefault: _d, ...rest } = current
  return writeBrand(tenantId, { ...rest, logo: { mimeType, path: file, updatedAt: new Date().toISOString() } })
}

export async function removeTenantLogo(tenantId: string): Promise<TenantBrand & { isDefault: boolean }> {
  const current = await loadBrand(tenantId)
  if (current.logo && fs.existsSync(current.logo.path)) fs.unlinkSync(current.logo.path)
  const { isDefault: _d, ...rest } = current
  return writeBrand(tenantId, { ...rest, logo: null })
}

/** Il file del logo da servire, o null se l'organizzazione non ne ha uno. */
export async function tenantLogoFile(tenantId: string): Promise<{ path: string; mimeType: string; updatedAt: string } | null> {
  const brand = await tenantBrand(tenantId)
  if (!brand.logo) return null
  const resolved = path.resolve(brand.logo.path)
  // Il percorso salvato deve stare nella cartella del marchio di QUESTO tenant.
  if (!resolved.startsWith(path.resolve(brandDir(tenantId)) + path.sep) || !fs.existsSync(resolved)) return null
  return { path: resolved, mimeType: brand.logo.mimeType, updatedAt: brand.logo.updatedAt }
}

/** L'indirizzo del logo per il web e il portale (stessa origine, con la versione per la cache). */
export function logoUrlOf(tenantId: string, brand: TenantBrand): string | null {
  return brand.logo ? `/api/brand/${encodeURIComponent(tenantId)}/logo?v=${encodeURIComponent(brand.logo.updatedAt)}` : null
}
