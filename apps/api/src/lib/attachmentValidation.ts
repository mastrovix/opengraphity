/**
 * Pure validation helpers for attachment uploads (rest/attachments.ts).
 * Kept free of Express/Neo4j so they can be unit-tested directly.
 */
import path from 'node:path'
import { ValidationError } from './errors.js'
import { FORM_DRAFT_ENTITY_TYPE, FORM_FIELD_NAME_RE, type Permission } from '@opengraphity/types'

/**
 * entityType (client field) → Neo4j labels the target entity may carry.
 * The label used in Cypher ALWAYS comes from this table, never from input.
 * Mirrors the entityType values the web passes to <AttachmentsSection>.
 *
 * `ci` è `:ConfigurationItem`, non l'elenco dei tipi (ondata 6, A-9): qui
 * serve solo sapere «è un CI di questo cliente», e ogni CI porta quella
 * etichetta (migrazione `20260908_1010`, dal vivo 2049 su 2049). Con l'elenco
 * dei quindici tipi spediti, allegare un file a un CI di un tipo creato dal
 * cliente rispondeva 404. La validazione resta **sincrona** di proposito:
 * `rest/attachments.ts` la esegue dentro il callback `busboy.on('file')`,
 * prima di aprire il flusso su disco.
 */
export const ATTACHMENT_ENTITY_LABELS: Readonly<Record<string, readonly string[]>> = {
  incident:        ['Incident'],
  problem:         ['Problem'],
  change:          ['Change'],
  service_request: ['ServiceRequest'],
  kb_article:      ['KBArticle'],
  team:            ['Team'],
  task:            ['AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask'],
  ci:              ['ConfigurationItem'],
}

/**
 * LA BOZZA DI UN MODULO (moduli del catalogo, ondata 2). È l'unico bersaglio
 * senza un nodo: il file si carica mentre la richiesta non esiste ancora, con
 * un identificativo di bozza scelto dal client.
 *
 * Non ha etichette, quindi il controllo di esistenza va SALTATO — e questo è
 * il punto delicato, perché quel controllo è anche il controllo di accesso
 * («questo ticket è tuo»). Qui non c'è niente di cui essere proprietari: la
 * proprietà si verifica al momento di RECLAMARE i file, dove si pretende che
 * `uploaded_by` sia chi sta creando la richiesta. Fino a lì un file caricato su
 * una bozza è visibile solo a chi l'ha caricato, e se nessuno lo reclama la
 * manutenzione notturna lo cancella.
 */
export { FORM_DRAFT_ENTITY_TYPE }

/** Il nome del campo a cui il file risponde: obbligatorio per una bozza, vietato altrove. */
export function validateAttachmentFieldName(entityType: string, fieldName: unknown): string | null {
  if (entityType !== FORM_DRAFT_ENTITY_TYPE) {
    if (typeof fieldName === 'string' && fieldName !== '') {
      throw new ValidationError('fieldName is only for form draft uploads')
    }
    return null
  }
  if (typeof fieldName !== 'string' || !FORM_FIELD_NAME_RE.test(fieldName)) {
    throw new ValidationError('fieldName is required for a form draft upload, and must be a field name')
  }
  return fieldName
}

/** RFC-4122 shape (8-4-4-4-12 hex). Rejects anything usable as a path segment attack. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const LABEL_RE = /^[A-Za-z][A-Za-z0-9]*$/

/**
 * Who may upload (wave 7): whoever works tickets, or submits them from the portal
 * (attaching to their own tickets). Read-only roles have neither.
 */
export const UPLOAD_PERMISSIONS: readonly Permission[] = ['ticket.work', 'portal.submit']

export interface AttachmentTarget {
  entityType: string
  entityId:   string
  labels:     readonly string[]
}

/** Validates entityType (whitelist) and entityId (UUID). Throws ValidationError. */
export function validateAttachmentTarget(entityType: unknown, entityId: unknown): AttachmentTarget {
  if (typeof entityType !== 'string' || !entityType) {
    throw new ValidationError('entityType is required')
  }
  // La bozza di un modulo non ha un nodo, quindi non ha etichette: chi la
  // riceve salta il controllo di esistenza (vedi FORM_DRAFT_ENTITY_TYPE).
  const labels = entityType === FORM_DRAFT_ENTITY_TYPE
    ? []
    : Object.prototype.hasOwnProperty.call(ATTACHMENT_ENTITY_LABELS, entityType)
      ? ATTACHMENT_ENTITY_LABELS[entityType]
      : undefined
  if (!labels) {
    throw new ValidationError(`entityType '${entityType}' is not allowed (expected one of: ${Object.keys(ATTACHMENT_ENTITY_LABELS).join(', ')}, ${FORM_DRAFT_ENTITY_TYPE})`)
  }
  if (typeof entityId !== 'string' || !UUID_RE.test(entityId)) {
    throw new ValidationError('entityId must be a UUID')
  }
  return { entityType, entityId: entityId.toLowerCase(), labels }
}

/**
 * Cypher that checks the target exists in the tenant. Labels are interpolated
 * from the whitelist only (double-checked against LABEL_RE); ids/tenant go as
 * parameters `$entityId`, `$tenantId`.
 */
export function entityExistsCypher(labels: readonly string[], condition = 'true'): string {
  if (labels.length === 0) throw new ValidationError('entityExistsCypher: no labels')
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new ValidationError(`entityExistsCypher: invalid label "${l}"`)
  }
  const predicate = labels.map((l) => `e:${l}`).join(' OR ')
  return `MATCH (e {id: $entityId, tenant_id: $tenantId}) WHERE (${predicate}) AND (${condition}) RETURN e.id AS id LIMIT 1`
}

/**
 * Resolves `<baseDir>/<tenantId>/<entityId>/<fileName>` and guarantees the
 * result stays inside `baseDir` (path.resolve + prefix check). Throws
 * ValidationError otherwise. Returns { dir, file } absolute paths.
 */
export function resolveAttachmentPath(baseDir: string, tenantId: string, entityId: string, fileName: string): { dir: string; file: string } {
  const base = path.resolve(baseDir)
  const dir  = path.resolve(base, tenantId, entityId)
  const file = path.resolve(dir, fileName)
  const inside = (p: string) => p === base || p.startsWith(base + path.sep)
  if (!inside(dir) || !inside(file) || path.dirname(file) !== dir) {
    throw new ValidationError('Attachment path escapes the storage directory')
  }
  return { dir, file }
}

/** `<uuid>_<basename>` — basename strips directories; control chars and separators removed. */
export function safeStoredFilename(fileId: string, originalName: string): string {
  const base = Array.from(path.basename(originalName || 'file'))
    .map((ch) => {
      const c = ch.charCodeAt(0)
      return c < 32 || c === 127 || ch === '/' || ch === '\\' ? '_' : ch
    })
    .join('')
    .slice(0, 200)
  return `${fileId}_${base || 'file'}`
}
