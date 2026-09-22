/**
 * GLI ALLEGATI CHE UN'ORGANIZZAZIONE ACCETTA (verifica «Cosa resta cablato»,
 * ondata 6).
 *
 * ## Il difetto
 * 10 MB e un elenco fisso di tipi MIME (PDF, Office, immagini, testo, zip) per
 * tutti, in `rest/attachments.ts`. Chi deve allegare log `.gz` o catture
 * `.pcap` non poteva.
 *
 * ## La regola
 * `Tenant.attachment_policy` = `{maxSizeMb, extensions}`. Il cliente sceglie
 * sotto due tetti della piattaforma:
 *  - la dimensione: `ATTACHMENT_MAX_MB_CAP` (config);
 *  - i tipi: le estensioni di `PLATFORM_ATTACHMENT_EXTENSIONS`. Fuori restano
 *    ciò che un browser esegue o interpreta (html, svg, js) e gli eseguibili:
 *    un allegato si scarica, ma un file così è un rischio per chi lo apre.
 * Il controllo è sull'estensione del nome: il tipo MIME lo dichiara il browser
 * di chi carica e non prova niente.
 *
 * La proprietà assente è il comportamento di prima (10 MB, i tipi di prima) e
 * la migrazione `20260927_1010_attachment_policy` lo scrive esplicito.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'
import { config } from './config.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

/** Le estensioni fra cui un'organizzazione può scegliere. */
export const PLATFORM_ATTACHMENT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'txt', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'md',
  'zip', 'gz', 'tgz', 'tar', '7z',
  'pcap', 'pcapng', 'har', 'eml', 'msg',
] as const

export interface AttachmentPolicy { maxSizeMb: number; extensions: string[] }

/** Quello che `rest/attachments.ts` accettava prima, tradotto in estensioni. */
export const FACTORY_ATTACHMENT_POLICY: Readonly<AttachmentPolicy> = {
  maxSizeMb: 10,
  extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'zip'],
}

const cache = createMetamodelCache<AttachmentPolicy & { isDefault: boolean }>({
  name: 'attachment-policy',
  load: (tenantId) => loadPolicy(tenantId),
})

/** Solo per i test. */
export function clearAttachmentPolicyCache(): void { cache.clear() }

export function attachmentPolicy(tenantId: string): Promise<AttachmentPolicy & { isDefault: boolean }> {
  return cache.get(tenantId)
}

export function assertAttachmentPolicy(raw: unknown): AttachmentPolicy {
  const obj = (raw ?? {}) as Record<string, unknown>
  const cap = config.attachmentMaxMbCap
  const size = obj['maxSizeMb']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > cap) {
    throw new ValidationError(`The maximum attachment size must be a whole number of MB between 1 and ${String(cap)} (the platform limit).`,
      { key: 'errors.attachmentPolicy.size', params: { max: cap } })
  }
  const exts = obj['extensions']
  if (!Array.isArray(exts) || exts.length === 0) {
    throw new ValidationError('Choose at least one allowed file type.', { key: 'errors.attachmentPolicy.noExtensions', params: {} })
  }
  const allowed = new Set<string>(PLATFORM_ATTACHMENT_EXTENSIONS)
  const out: string[] = []
  for (const e of exts) {
    const ext = typeof e === 'string' ? e.trim().toLowerCase().replace(/^\./, '') : ''
    if (!allowed.has(ext)) {
      throw new ValidationError(`".${String(e)}" is not a file type the platform accepts.`,
        { key: 'errors.attachmentPolicy.extension', params: { extension: String(e) } })
    }
    if (!out.includes(ext)) out.push(ext)
  }
  return { maxSizeMb: size, extensions: out }
}

async function loadPolicy(tenantId: string): Promise<AttachmentPolicy & { isDefault: boolean }> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.attachment_policy AS raw', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    if (row.raw == null) return { ...FACTORY_ATTACHMENT_POLICY, extensions: [...FACTORY_ATTACHMENT_POLICY.extensions], isDefault: true }
    let parsed: unknown
    try { parsed = JSON.parse(String(row.raw)) }
    catch (e) { throw new Error(`Tenant ${tenantId}: attachment_policy is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e }) }
    // Un tetto di piattaforma abbassato dopo il salvataggio vale subito: la
    // scelta del cliente non può superarlo, e l'errore dice perché.
    return { ...assertAttachmentPolicy(parsed), isDefault: false }
  } finally {
    await session.close()
  }
}

export async function setAttachmentPolicy(tenantId: string, raw: unknown): Promise<AttachmentPolicy & { isDefault: boolean }> {
  const policy = assertAttachmentPolicy(raw)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session,
      'MATCH (t:Tenant {id: $tenantId}) SET t.attachment_policy = $json, t.updated_at = $now RETURN t.id AS id',
      { tenantId, json: JSON.stringify(policy), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  return { ...policy, isDefault: false }
}

/** L'estensione di un nome di file, minuscola e senza punto ('' se non ce l'ha). */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Il file è di un tipo che questa organizzazione accetta? */
export function extensionAllowed(policy: AttachmentPolicy, filename: string): boolean {
  const ext = fileExtension(filename)
  return ext !== '' && policy.extensions.includes(ext)
}
