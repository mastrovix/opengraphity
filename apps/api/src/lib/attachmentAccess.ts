/**
 * CHI PUÒ VEDERE O AGGIUNGERE GLI ALLEGATI DI UN'ENTITÀ — una regola sola per
 * caricamento, scaricamento, elenco e cancellazione (revisione totale del 16 set
 * 2026 · H-3, H-14, D-14).
 *
 * ## I difetti
 * - `POST /api/attachments` accettava `portal.submit` e controllava solo che
 *   l'entità esistesse nel tenant: un utente del portale allegava file a
 *   qualunque incident, problem o change dello staff.
 * - `GET /api/attachments/:id` controllava solo il tenant: chiunque avesse un
 *   token del tenant e l'id (che circola nei link) scaricava il file, anche di un
 *   ticket che non poteva vedere.
 * - la query `attachments` elencava gli allegati di qualunque entità a chi aveva
 *   UNO dei permessi di lettura dei ticket.
 *
 * ## La regola
 * - **staff**: in lettura il permesso di lettura di quel tipo di entità; in
 *   scrittura `ticket.work` o il permesso di scrittura di quel tipo;
 * - **portale**: solo incident e richieste che ha aperto lui (`created_by`); in
 *   lettura anche gli articoli KB pubblicati;
 * - nient'altro.
 */
import type { Permission } from '@opengraphity/types'
import { kbArticlePublishedCypher } from './kbPublished.js'

export type AttachmentMode = 'read' | 'write'
export type AttachmentAccess = 'staff' | 'own' | 'published' | 'denied'

const STAFF_READ: Readonly<Record<string, readonly Permission[]>> = {
  incident:        ['incident.read'],
  problem:         ['problem.read'],
  change:          ['change.read'],
  service_request: ['request.read'],
  kb_article:      ['kb.read'],
  team:            ['workspace.use'],
  task:            ['change.read'],
  ci:              ['cmdb.read'],
}

const STAFF_WRITE: Readonly<Record<string, readonly Permission[]>> = {
  incident:        ['ticket.work', 'incident.write'],
  problem:         ['ticket.work', 'problem.write'],
  change:          ['ticket.work', 'change.write'],
  service_request: ['ticket.work', 'request.write'],
  kb_article:      ['ticket.work', 'kb.write'],
  team:            ['ticket.work', 'admin.users'],
  task:            ['ticket.work', 'change.write'],
  ci:              ['ticket.work', 'cmdb.write'],
}

/** I tipi che un utente del portale apre e quindi possiede. */
export const PORTAL_OWNED_ENTITY_TYPES: ReadonlySet<string> = new Set(['incident', 'service_request'])

/**
 * Whether these permissions read an entity type as STAFF — the same table the
 * attachments use. For what only staff may see whole: the PDF dossier carries
 * the internal comments (review of 23 Sep 2026).
 */
export function readsAsStaff(permissions: ReadonlySet<string>, entityType: string): boolean {
  return (STAFF_READ[entityType] ?? []).some((p) => permissions.has(p))
}

/** Che accesso ha chi ha questi permessi, per quel tipo di entità. Pura, per i test. */
export function attachmentAccess(permissions: ReadonlySet<string>, entityType: string, mode: AttachmentMode): AttachmentAccess {
  const staff = (mode === 'read' ? STAFF_READ : STAFF_WRITE)[entityType] ?? []
  if (staff.some((p) => permissions.has(p))) return 'staff'
  const portalPermission = mode === 'read' ? 'portal.read' : 'portal.submit'
  if (permissions.has(portalPermission)) {
    if (PORTAL_OWNED_ENTITY_TYPES.has(entityType)) return 'own'
    if (mode === 'read' && entityType === 'kb_article') return 'published'
  }
  return 'denied'
}

/**
 * La condizione Cypher sull'entità `e` per quell'accesso (`$userId` è il
 * chiamante). `null` per `denied`: il chiamante risponde 403 senza interrogare.
 */
export function attachmentAccessCondition(access: AttachmentAccess, variable = 'e'): string | null {
  switch (access) {
    case 'staff':     return 'true'
    case 'own':       return `${variable}.created_by = $userId`
    case 'published': return kbArticlePublishedCypher(variable)
    case 'denied':    return null
  }
}
