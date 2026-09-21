/**
 * Seguito della 1030 (secondo giro UI del 15 set 2026): un OLA su una change si
 * misura sui suoi task (`lib/olaChangeUnits.ts`), e i task di assessment e i
 * piani di deploy già esistenti hanno un team ma non la storia. Per loro un
 * tratto dalla nascita del task: il team l'hanno avuto da allora (nascono col
 * team del CI e fin qui non c'era modo di cambiarlo senza scriverlo), ma il
 * tratto resta `inferred: true` perché una riassegnazione di prima non si vede.
 * Idempotente: un task con almeno un tratto non si tocca.
 */
import type { Migration } from '@opengraphity/neo4j'

export const CHANGE_TASK_LABELS = ['AssessmentTask', 'DeployPlanTask'] as const

export const changeTaskTeamSegments: Migration = {
  id:          '20260930_1040_change_task_team_segments',
  description: 'Storia delle assegnazioni ai team anche per i task delle change: un tratto dalla nascita del task',

  async up(session) {
    let created = 0
    for (const label of CHANGE_TASK_LABELS) {
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
    console.log(`[${changeTaskTeamSegments.id}] tratti ricostruiti: ${created}`)
  },
}
