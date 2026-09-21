/**
 * Ticket conclusi con lo SLA ancora aperto, e richieste chiuse senza data.
 *
 * Fino al 14 set 2026 lo SLA si chiudeva solo con `incident.resolved`,
 * `problem.resolved` o `request.completed`, che molti cammini non pubblicano
 * (un problem risolto dalla sua change, una richiesta chiusa dal workflow); e
 * `completed_at` lo scriveva solo `completeRequest`, che il workflow non
 * chiama. Da ora li scrive il motore (vedi `workflow.step_entered`); qui si
 * sistemano quelli già conclusi.
 *
 *  1. Richieste e change in un passo terminale senza `completed_at`: la data è
 *     l'ingresso in quel passo (`WorkflowInstance.updated_at`).
 *  2. SLA senza `resolved_at` di un ticket concluso: si chiude alla data di
 *     conclusione del ticket, rispettato se entro la scadenza. Le pause ancora
 *     aperte non si ricostruiscono (la data vale com'è): è la stima prudente.
 *
 * Idempotente: tocca solo ciò che manca.
 */
import type { Migration } from '@opengraphity/neo4j'

export const concludedTicketsSla: Migration = {
  id:          '20260922_1010_concluded_tickets_sla',
  description: 'completed_at sulle richieste/change terminali e chiusura degli SLA dei ticket già conclusi',

  async up(session) {
    const a = await session.run(`
      MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(st:WorkflowStep)
      WHERE (e:ServiceRequest OR e:Change)
        AND coalesce(st.is_terminal, st.type = 'end') = true
        AND e.completed_at IS NULL
      SET e.completed_at = coalesce(wi.updated_at, e.updated_at)
      RETURN count(e) AS n`)
    const b = await session.run(`
      MATCH (e)-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest)
        AND s.resolved_at IS NULL
        AND coalesce(e.resolved_at, e.completed_at) IS NOT NULL
      WITH s, coalesce(e.resolved_at, e.completed_at) AS fine
      SET s.resolved_at = fine,
          s.resolve_met = datetime(fine) <= datetime(s.resolve_deadline),
          s.breached    = coalesce(s.breached, false) OR datetime(fine) > datetime(s.resolve_deadline),
          s.paused_at   = null,
          s.paused_type = null
      RETURN count(s) AS n`)
    console.log(`[20260922_1010] completed_at scritto: ${Number(a.records[0]?.get('n') ?? 0)}; SLA chiusi: ${Number(b.records[0]?.get('n') ?? 0)}`)
  },
}
