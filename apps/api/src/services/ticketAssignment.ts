/**
 * Assegnazione di un ticket (incident, problem; per la richiesta solo
 * l'utente, `setTicketUser`) a team e utente — logica condivisa.
 *
 * Regola ITSM (una sola, per entrambe le entità): si assegna a un utente solo
 * dopo aver assegnato il gruppo, e l'utente deve appartenere a quel gruppo.
 * Prima la guardia MEMBER_OF era copiata in incidentService e in problem.ts con
 * tipi d'errore diversi; qui c'è una sola versione, con errori tipizzati
 * (NotFoundError / ValidationError) che il layer GraphQL traduce in codici.
 */
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { assignTeamCypher, TEAM_NOW_PARAM } from '../lib/ticketTeamHistory.js'

type Session = Parameters<typeof runQueryOne>[0]
export type TicketLabel = 'Incident' | 'Problem' | 'ServiceRequest'

/** Verifica che il ticket abbia un gruppo assegnatario e che l'utente ne faccia parte. */
export async function assertUserInAssignedTeam(
  session: Session, label: TicketLabel, id: string, userId: string, tenantId: string,
): Promise<{ teamId: string; teamName: string | null }> {
  const check = await runQueryOne<{ teamId: string | null; teamName: string | null; isMember: boolean }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(team:Team)
    RETURN team.id AS teamId, team.name AS teamName,
           exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)) AS isMember
  `, { id, userId, tenantId })
  if (!check) throw new NotFoundError(label, id)
  if (!check.teamId) throw new ValidationError(`${label}: assign a group first, then a user from that group`, { key: 'errors.assignment.groupFirst' })
  if (!check.isMember) throw new ValidationError(`The selected user does not belong to the assigned group${check.teamName ? ` (${check.teamName})` : ''}`, { key: check.teamName ? 'errors.assignment.notMemberNamed' : 'errors.assignment.notMember', params: { team: check.teamName ?? '' } })
  return { teamId: check.teamId, teamName: check.teamName }
}

/** Sostituisce il gruppo assegnatario; NOT_FOUND se ticket o team non esistono nel tenant. */
export async function setTicketTeam(session: Session, label: TicketLabel, id: string, teamId: string, tenantId: string): Promise<{ teamName: string }> {
  const now = new Date().toISOString()
  const row = await runQueryOne<{ teamName: string }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
    ${assignTeamCypher('e', 't')}
    SET e.updated_at = $now
    RETURN t.name AS teamName
  `, { id, teamId, tenantId, now, [TEAM_NOW_PARAM]: now })
  if (!row) throw new NotFoundError(`${label} o Team`, `${id} / ${teamId}`)
  return { teamName: row.teamName }
}

/** Sostituisce (o rimuove, con userId null) l'assegnatario; NOT_FOUND se ticket o utente non esistono. */
export async function setTicketUser(session: Session, label: TicketLabel, id: string, userId: string | null, tenantId: string): Promise<{ userName: string | null }> {
  if (userId === null) {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (e:${label} {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->()
      DELETE old
      SET e.updated_at = $now
      RETURN e.id AS id
    `, { id, tenantId, now: new Date().toISOString() })
    if (!row) throw new NotFoundError(label, id)
    return { userName: null }
  }
  const row = await runQueryOne<{ userName: string | null }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->()
    DELETE old
    WITH DISTINCT e, u
    CREATE (e)-[:ASSIGNED_TO]->(u)
    SET e.updated_at = $now
    RETURN u.name AS userName
  `, { id, userId, tenantId, now: new Date().toISOString() })
  if (!row) throw new NotFoundError(`${label} o User`, `${id} / ${userId}`)
  return { userName: row.userName }
}
