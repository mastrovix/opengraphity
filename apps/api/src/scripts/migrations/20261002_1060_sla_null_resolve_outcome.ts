/**
 * H-47: uno SLA concluso non può restare «né rispettato né violato».
 *
 * La migrazione `20260922_1010_concluded_tickets_sla` chiudeva gli SLA dei
 * ticket già conclusi con
 *
 *     s.resolve_met = datetime(fine) <= datetime(s.resolve_deadline)
 *     s.breached    = coalesce(s.breached, false) OR datetime(fine) > datetime(s.resolve_deadline)
 *
 * In Cypher `datetime(null)` è null e un confronto con null è null, quindi su
 * uno SLAStatus senza `resolve_deadline` sia `resolve_met` sia `breached`
 * diventavano **null** — e i report li leggono come nessuna delle due cose.
 * Quella migrazione è applicata e non si tocca (regola di `migrations/index.ts`
 * e OPERATIONS §3): la riparazione è questa migrazione nuova.
 *
 * Verificato dal vivo prima di scriverla: su questo database 1535 SLAStatus,
 * **nessuno** senza `resolve_deadline` (il prodotto lo scrive sempre, e
 * `markResolveMet` lancerebbe su un valore nullo). Quindi qui è un no-op: vale
 * per un database che quel caso l'abbia, e come rete per il futuro.
 *
 * Cosa scrive, e perché:
 *  - `breached` non è mai null: senza una scadenza di risoluzione da mancare,
 *    la violazione resta quella della risposta (o falsa).
 *  - `resolve_met` resta **null** quando non c'è una scadenza da rispettare:
 *    è l'unica risposta vera, e non è «non rispettato».
 *
 * Idempotente: tocca solo i nodi in cui una delle due è null.
 */
import type { Migration } from '@opengraphity/neo4j'

export const slaNullResolveOutcome: Migration = {
  id:          '20261002_1060_sla_null_resolve_outcome',
  description: 'H-47: breached mai null sugli SLA conclusi senza resolve_deadline (riparazione della 20260922_1010)',

  async up(session) {
    const r = await session.run(`
      MATCH (:Incident|Problem|ServiceRequest)-[:HAS_SLA]->(s:SLAStatus)
      WHERE s.resolved_at IS NOT NULL
        AND (s.breached IS NULL OR (s.resolve_met IS NULL AND s.resolve_deadline IS NOT NULL))
      SET s.breached = CASE
            WHEN s.resolve_deadline IS NULL
              THEN coalesce(s.response_met, true) = false
            ELSE datetime(s.resolved_at) > datetime(s.resolve_deadline)
                 OR coalesce(s.response_met, true) = false
          END,
          s.resolve_met = CASE
            WHEN s.resolve_deadline IS NULL THEN null
            ELSE datetime(s.resolved_at) <= datetime(s.resolve_deadline)
          END
      RETURN count(s) AS n`)
    const n = Number(r.records[0]?.get('n') ?? 0)
    console.log(`[${slaNullResolveOutcome.id}] SLAStatus riparati: ${n}`)
  },
}
