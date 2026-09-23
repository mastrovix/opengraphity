/**
 * I COMMENTI DEI TICKET: un modello solo — revisione del 14 set 2026 · F1.
 *
 * ## Il difetto
 * Il portale scriveva e leggeva nodi `EntityComment` (campo `body`, relazione
 * `HAS_ENTITY_COMMENT`); il dettaglio dell'incident nel web scriveva e leggeva
 * nodi `Comment` (campo `text`, relazione `HAS_COMMENT`); il problem un terzo
 * modello, `ProblemComment`. Nessuno vedeva i commenti dell'altro: la domanda
 * dell'utente finale non arrivava all'operatore, e la risposta dell'operatore
 * non arrivava all'utente.
 *
 * ## Il modello
 * `(ticket)-[:HAS_COMMENT]->(:Comment)` per ogni ticket, con:
 *  - `text`, `author_id`, `created_at`, `updated_at`;
 *  - `is_internal`: `true` = nota di lavoro, la vede solo lo staff; `false` =
 *    risposta pubblica, la vede anche chi ha aperto il ticket dal portale. È
 *    SEMPRE scritto (lo pretende `commentsSingleModel.test.ts`): il portale
 *    mostra solo `is_internal = false`, quindi un commento senza la proprietà
 *    non raggiungerebbe mai l'utente e nessuno saprebbe perché;
 *  - `author_label` per chi scrive e non è una persona (una regola), e
 *    `author_id = 'monitoring'` per il monitoraggio.
 * I testi scritti dal sistema (note di transizione, regole, monitoraggio,
 * import) sono note interne. I commenti esistenti prima di questo modello sono
 * diventati interni con la migrazione: niente di già scritto è diventato
 * visibile a un utente finale.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { Permission } from '@opengraphity/types'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../context.js'
import { requirePermission } from './permissions.js'

/** Ticket commentabili: entity_type → etichetta Neo4j (allowlist: l'etichetta finisce nel Cypher). */
export const COMMENTABLE_LABELS: Readonly<Record<string, 'Incident' | 'Problem' | 'Change' | 'ServiceRequest' | 'KBArticle'>> = {
  incident:        'Incident',
  problem:         'Problem',
  change:          'Change',
  service_request: 'ServiceRequest',
  kb_article:      'KBArticle',
}

/**
 * Who reads the comments and the internal chat of a ticket: who reads THAT
 * ticket type. The operation policy opens `comments` to any ticket read
 * permission, and until 23 Sep 2026 nothing looked at the type asked: a role
 * with request.read alone read the internal notes of every incident and
 * change by id (the same gap H-14 closed for attachments).
 */
const COMMENT_READ_PERMISSION: Readonly<Record<keyof typeof COMMENTABLE_LABELS, Permission>> = {
  incident:        'incident.read',
  problem:         'problem.read',
  change:          'change.read',
  service_request: 'request.read',
  kb_article:      'kb.read',
}

export function requireCommentRead(ctx: Pick<GraphQLContext, 'role' | 'permissions'>, entityType: string): void {
  const permission = (COMMENT_READ_PERMISSION as Readonly<Record<string, Permission>>)[entityType]
  if (!permission) {
    throw new GraphQLError(`Entity type cannot be commented on: ${entityType}`,
      { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.entityType', params: { entityType } } } })
  }
  requirePermission(ctx, permission)
}

type Props = Record<string, unknown>

export interface NewTicketComment {
  entityType: string
  entityId:   string
  tenantId:   string
  text:       string
  authorId:   string
  isInternal: boolean
  /** Il nome di chi scrive quando non è una persona (una regola). */
  authorLabel?: string | null
  /** Id esterno dell'import, per sostituire il thread a un nuovo giro. */
  importExternalId?: string | null
  createdAt?: string
}

export function commentLabelFor(entityType: string): string {
  const label = COMMENTABLE_LABELS[entityType]
  if (!label) throw new Error(`Entity type cannot be commented on: ${entityType}`)
  return label
}

/**
 * Scrive un commento appeso al ticket. `null` se il ticket non esiste nel
 * tenant (il chiamante decide il NOT_FOUND). Ritorna le proprietà del commento
 * e quelle dell'autore, se è un utente.
 */
export async function writeTicketComment(
  session: Session, c: NewTicketComment,
): Promise<{ comment: Props; author: Props | null } | null> {
  const label = commentLabelFor(c.entityType)
  const now = c.createdAt ?? new Date().toISOString()
  const rows = await runQuery<{ comment: Props; author: Props | null }>(session, `
    MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
    CREATE (c:Comment {
      id:           randomUUID(),
      tenant_id:    $tenantId,
      text:         $text,
      is_internal:  $isInternal,
      author_id:    $authorId,
      author_label: $authorLabel,
      import_external_id: $importExternalId,
      created_at:   $now,
      updated_at:   $now
    })
    CREATE (e)-[:HAS_COMMENT]->(c)
    SET e.updated_at = $now
    WITH c
    OPTIONAL MATCH (u:User {id: $authorId, tenant_id: $tenantId})
    RETURN properties(c) AS comment, properties(u) AS author
  `, {
    entityId: c.entityId, tenantId: c.tenantId, text: c.text, isInternal: c.isInternal,
    authorId: c.authorId, authorLabel: c.authorLabel ?? null, importExternalId: c.importExternalId ?? null, now,
  })
  return rows[0] ?? null
}
