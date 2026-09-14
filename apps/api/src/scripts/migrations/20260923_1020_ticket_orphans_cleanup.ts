/**
 * Revisione del 14 set 2026 · F3: la bonifica dei nodi rimasti senza ticket.
 *
 * Le cancellazioni fisiche di prima (problem, reset dei dati dimostrativi)
 * lasciavano nel grafo nodi che nessuna pagina può più raggiungere. Dal vivo,
 * prima di questa migrazione: 85 `SLAStatus` senza ticket (c-one 81, c-two 4),
 * 111 `Comment` non appesi a niente (c-one), 2 istanze di workflow `kb_article`
 * il cui articolo non esiste più.
 *
 * Si toglie SOLO ciò che è davvero orfano:
 *  - `SLAStatus` senza `HAS_SLA` entrante E senza un ticket con il suo
 *    `entity_id` nel suo tenant (se il ticket esiste, è un collegamento da
 *    ricucire, non un rifiuto: non si tocca e lo si stampa);
 *  - `Comment`/`ProblemComment` senza `HAS_COMMENT` entrante (non hanno altro
 *    modo di essere trovati);
 *  - `WorkflowInstance` senza `HAS_WORKFLOW` entrante e senza un nodo con il suo
 *    `entity_id`, con la loro storia.
 * Una riga di log per tenant ed etichetta. Idempotente: al secondo giro non
 * trova niente.
 */
import type { Migration } from '@opengraphity/neo4j'

const TICKET_LABELS = ['Incident', 'Problem', 'Change', 'ServiceRequest']

export const ticketOrphansCleanup: Migration = {
  id: '20260923_1020_ticket_orphans_cleanup',
  description: 'Bonifica: SLAStatus, commenti e istanze di workflow rimasti senza ticket dopo le cancellazioni fisiche',
  async up(session) {
    const slaRelinkable = await session.run(`
      MATCH (s:SLAStatus) WHERE NOT ()-[:HAS_SLA]->(s)
      MATCH (t {id: s.entity_id, tenant_id: s.tenant_id}) WHERE any(l IN labels(t) WHERE l IN $labels)
      RETURN s.tenant_id AS tenant, count(s) AS n
    `, { labels: TICKET_LABELS })
    for (const r of slaRelinkable.records) {
      console.log(`[${ticketOrphansCleanup.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} SLAStatus senza HAS_SLA ma con il ticket presente — NON cancellati, da ricucire`)
    }

    const sla = await session.run(`
      MATCH (s:SLAStatus) WHERE NOT ()-[:HAS_SLA]->(s)
        AND NOT EXISTS { MATCH (t {id: s.entity_id, tenant_id: s.tenant_id}) WHERE any(l IN labels(t) WHERE l IN $labels) }
      WITH s, s.tenant_id AS tenant
      DETACH DELETE s
      RETURN tenant, count(*) AS n
    `, { labels: TICKET_LABELS })
    const comments = await session.run(`
      MATCH (c) WHERE (c:Comment OR c:ProblemComment) AND NOT ()-[:HAS_COMMENT]->(c)
      WITH c, c.tenant_id AS tenant, head(labels(c)) AS label
      DETACH DELETE c
      RETURN tenant, label, count(*) AS n
    `)
    const instances = await session.run(`
      MATCH (wi:WorkflowInstance) WHERE NOT ()-[:HAS_WORKFLOW]->(wi)
        AND NOT EXISTS { MATCH (e {id: wi.entity_id, tenant_id: wi.tenant_id}) WHERE NOT e:WorkflowInstance }
      OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(ex:WorkflowStepExecution)
      WITH wi, wi.tenant_id AS tenant, wi.entity_type AS entityType, collect(ex) AS history
      FOREACH (x IN history | DETACH DELETE x)
      DETACH DELETE wi
      RETURN tenant, entityType, count(*) AS n
    `)
    for (const r of sla.records) console.log(`[${ticketOrphansCleanup.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} SLAStatus orfani cancellati`)
    for (const r of comments.records) console.log(`[${ticketOrphansCleanup.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} ${String(r.get('label'))} orfani cancellati`)
    for (const r of instances.records) console.log(`[${ticketOrphansCleanup.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} WorkflowInstance ${String(r.get('entityType'))} orfane cancellate`)
    if (!sla.records.length && !comments.records.length && !instances.records.length) console.log(`[${ticketOrphansCleanup.id}] nessun orfano`)
  },
}
