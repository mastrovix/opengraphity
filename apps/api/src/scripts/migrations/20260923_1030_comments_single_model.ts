/**
 * Revisione del 14 set 2026 · F1: un modello solo per i commenti dei ticket
 * (`lib/ticketComments.ts`).
 *
 * Tre modelli convivevano e nessuno vedeva gli altri: `Comment` (dettaglio
 * dell'incident), `ProblemComment` (problem) ed `EntityComment` (portale e API
 * generica). Qui si portano tutti su `(ticket)-[:HAS_COMMENT]->(:Comment)`:
 *  - `ProblemComment` → `Comment`, con `created_by` che diventa `author_id`;
 *  - `EntityComment` → `Comment` appeso al suo ticket (per `entity_type` /
 *    `entity_id`), `body` che diventa `text`; la relazione del portale
 *    `HAS_ENTITY_COMMENT` sparisce. Un `EntityComment` il cui ticket non esiste
 *    più non si tocca e lo si stampa;
 *  - ogni `Comment` senza `is_internal` diventa nota interna (`true`): i
 *    commenti scritti prima esistevano solo lato staff, e nessuno di loro deve
 *    diventare visibile all'utente finale per effetto di una migrazione. I
 *    commenti del portale conservano il loro `is_internal = false`.
 * Idempotente: al secondo giro non trova niente da convertire.
 */
import type { Migration } from '@opengraphity/neo4j'

const LABELS: Readonly<Record<string, string>> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest', kb_article: 'KBArticle',
}

export const commentsSingleModel: Migration = {
  id: '20260923_1030_comments_single_model',
  description: 'Commenti dei ticket su un modello solo: ProblemComment ed EntityComment diventano Comment appesi con HAS_COMMENT; is_internal sempre valorizzato',
  async up(session) {
    const problem = await session.run(`
      MATCH (c:ProblemComment)
      SET c:Comment, c.author_id = coalesce(c.author_id, c.created_by)
      REMOVE c:ProblemComment, c.created_by
      RETURN c.tenant_id AS tenant, count(*) AS n
    `)
    for (const r of problem.records) console.log(`[${commentsSingleModel.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} ProblemComment → Comment`)

    const entity = await session.run(`
      MATCH (c:EntityComment)
      MATCH (e {id: c.entity_id, tenant_id: c.tenant_id})
      WHERE $labels[c.entity_type] IS NOT NULL AND $labels[c.entity_type] IN labels(e)
      OPTIONAL MATCH ()-[old:HAS_ENTITY_COMMENT]->(c)
      DELETE old
      WITH DISTINCT c, e
      MERGE (e)-[:HAS_COMMENT]->(c)
      SET c:Comment, c.text = coalesce(c.text, c.body), c.is_internal = coalesce(c.is_internal, true)
      REMOVE c:EntityComment, c.body
      RETURN c.tenant_id AS tenant, count(*) AS n
    `, { labels: LABELS })
    for (const r of entity.records) console.log(`[${commentsSingleModel.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} EntityComment → Comment`)

    const stranded = await session.run(`
      MATCH (c:EntityComment) RETURN c.tenant_id AS tenant, c.entity_type AS type, c.entity_id AS id
    `)
    for (const r of stranded.records) {
      console.log(`[${commentsSingleModel.id}] ${String(r.get('tenant'))}: EntityComment di ${String(r.get('type'))} ${String(r.get('id'))} senza ticket — lasciato com'è`)
    }

    const internal = await session.run(`
      MATCH (c:Comment) WHERE c.is_internal IS NULL
      SET c.is_internal = true
      RETURN c.tenant_id AS tenant, count(*) AS n
    `)
    for (const r of internal.records) console.log(`[${commentsSingleModel.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} commenti esistenti marcati come note interne`)
  },
}
