/**
 * Pure validation helpers for attachment uploads (rest/attachments.ts).
 * Kept free of Express/Neo4j so they can be unit-tested directly.
 */
import path from 'node:path'
import { ALL_CI_LABELS } from './ciLabels.js'
import { ValidationError } from './errors.js'

/**
 * entityType (client field) → Neo4j labels the target entity may carry.
 * The label used in Cypher ALWAYS comes from this table, never from input.
 * Mirrors the entityType values the web passes to <AttachmentsSection>.
 */
export const ATTACHMENT_ENTITY_LABELS: Readonly<Record<string, readonly string[]>> = {
  incident:        ['Incident'],
  problem:         ['Problem'],
  change:          ['Change'],
  service_request: ['ServiceRequest'],
  kb_article:      ['KBArticle'],
  team:            ['Team'],
  task:            ['AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask'],
  ci:              ALL_CI_LABELS,
}

/** RFC-4122 shape (8-4-4-4-12 hex). Rejects anything usable as a path segment attack. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const LABEL_RE = /^[A-Za-z][A-Za-z0-9]*$/

/** Roles that may upload. `viewer` is read-only; `end_user` attaches to its own portal tickets. */
export const UPLOAD_ROLES: ReadonlySet<string> = new Set(['admin', 'operator', 'end_user'])

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
  const labels = Object.prototype.hasOwnProperty.call(ATTACHMENT_ENTITY_LABELS, entityType)
    ? ATTACHMENT_ENTITY_LABELS[entityType]
    : undefined
  if (!labels) {
    throw new ValidationError(`entityType '${entityType}' is not allowed (expected one of: ${Object.keys(ATTACHMENT_ENTITY_LABELS).join(', ')})`)
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
export function entityExistsCypher(labels: readonly string[]): string {
  if (labels.length === 0) throw new ValidationError('entityExistsCypher: no labels')
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new ValidationError(`entityExistsCypher: invalid label "${l}"`)
  }
  const predicate = labels.map((l) => `e:${l}`).join(' OR ')
  return `MATCH (e {id: $entityId, tenant_id: $tenantId}) WHERE ${predicate} RETURN e.id AS id LIMIT 1`
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
