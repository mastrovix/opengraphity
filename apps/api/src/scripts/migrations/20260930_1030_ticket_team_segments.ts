/**
 * Secondo giro UI del 15 set 2026, punto 3 («il tempo del team»): la storia
 * delle assegnazioni ai team (`lib/ticketTeamHistory.ts`) nasce adesso, e i
 * ticket che hanno già un team non ce l'hanno. Per loro un tratto RICOSTRUITO:
 * dal momento dell'apertura, ancora aperto, `inferred: true`, così il report e
 * il riquadro del ticket dicono che quel tempo non è misurato ma supposto.
 * Solo i ticket che un contratto OLA/UC può misurare. Idempotente: un ticket
 * con almeno un tratto non si tocca.
 */
import type { Migration } from '@opengraphity/neo4j'

export const TEAM_SEGMENT_LABELS = ['Incident', 'Problem', 'ServiceRequest', 'Change'] as const

export const ticketTeamSegments: Migration = {
  id:          '20260930_1030_ticket_team_segments',
  description: 'Storia delle assegnazioni ai team: un tratto ricostruito dall\'apertura per i ticket che hanno già un team',

  async up(session) {
    let created = 0
    for (const label of TEAM_SEGMENT_LABELS) {
      const res = await session.run(`
        MATCH (e:${label})-[:ASSIGNED_TO_TEAM]->(t:Team)
        WHERE NOT EXISTS { (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment) }
        CREATE (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment {
          id: randomUUID(), tenant_id: e.tenant_id, team_id: t.id,
          started_at: coalesce(e.created_at, toString(datetime())), ended_at: null, inferred: true
        })
        RETURN count(*) AS n`)
      created += Number(res.records[0]?.get('n') ?? 0)
    }
    console.log(`[${ticketTeamSegments.id}] tratti ricostruiti: ${created}`)
  },
}
