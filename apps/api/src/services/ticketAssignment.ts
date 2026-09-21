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

/**
 * Una persona disattivata non riceve lavoro (revisione totale · M-6): la regola
 * vale per ogni scrittura di `ASSIGNED_TO` — ticket, task, azioni di passo e automazioni.
 * Una persona inesistente la lascia dire a chi scrive (NOT_FOUND con il contesto).
 */
export async function assertAssignablePerson(session: Session, userId: string, tenantId: string): Promise<void> {
  const person = await runQueryOne<{ active: boolean }>(session, `
    MATCH (u:User {id: $userId, tenant_id: $tenantId}) RETURN coalesce(u.active, true) AS active
  `, { userId, tenantId })
  if (person && person.active === false) {
    throw new ValidationError('The selected person is deactivated and cannot be assigned', { key: 'errors.assignment.userInactive' })
  }
}

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

/**
 * Sostituisce il gruppo assegnatario; NOT_FOUND se ticket o team non esistono
 * nel tenant.
 *
 * Se l'assegnatario attuale NON è membro del gruppo nuovo, l'assegnazione alla
 * persona cade (revisione totale · M-10): la regola ITSM «prima il gruppo, poi
 * una persona di quel gruppo» è imposta da `assertUserInAssignedTeam`, e ogni
 * cambio di gruppo la violava subito dopo — il ticket restava assegnato a
 * qualcuno che in quel gruppo non c'è. Chi resta membro (un team allargato)
 * non viene toccato. `unassigned` dice se è caduta, così chi chiama lo può
 * scrivere in timeline.
 */
export async function setTicketTeam(session: Session, label: TicketLabel, id: string, teamId: string, tenantId: string): Promise<{ teamName: string; previousTeamName: string | null; unassignedUserName: string | null }> {
  const now = new Date().toISOString()
  /*
   * `previousTeamName`: DA CHI, non solo a chi (20 set 2026, ondata 2 di
   * «Miglioramento continuo»).
   *
   * Il registro scriveva `incident.assigned` senza nessun dettaglio — tutte
   * le 34 voci di c-one avevano `details = NULL` — e da lì non si può
   * ricostruire niente: non si sa a chi, non si sa da chi, e nemmeno se
   * l'assegnazione era a una squadra o a una persona, perché le due mutation
   * scrivono la stessa stringa. L'esempio che il progetto usava come vetrina
   * («47 incident riassegnati dalla stessa squadra alla stessa squadra») non
   * era calcolabile.
   *
   * Si legge PRIMA della scrittura e nella stessa query, perché
   * `assignTeamCypher` cancella la relazione vecchia: un secondo giro
   * leggerebbe già il valore nuovo.
   */
  const row = await runQueryOne<{ teamName: string; previousTeamName: string | null; unassignedUserName: string | null }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(__prima:Team)
    WITH e, t, __prima.name AS previousTeamName
    ${assignTeamCypher('e', 't', { carry: ['previousTeamName'] })}
    // L'assegnatario che non è nel gruppo nuovo: si stacca, e si dice chi era.
    OPTIONAL MATCH (e)-[__assignee:ASSIGNED_TO]->(u:User)
      WHERE NOT exists((u)-[:MEMBER_OF]->(t))
    WITH e, t, previousTeamName, u.name AS unassignedUserName, __assignee
    DELETE __assignee
    WITH e, t, previousTeamName, unassignedUserName
    SET e.updated_at = $now
    RETURN t.name AS teamName, previousTeamName, unassignedUserName
  `, { id, teamId, tenantId, now, [TEAM_NOW_PARAM]: now })
  if (!row) throw new NotFoundError(`${label} o Team`, `${id} / ${teamId}`)
  return {
    teamName: row.teamName,
    previousTeamName: row.previousTeamName ?? null,
    unassignedUserName: row.unassignedUserName ?? null,
  }
}

/**
 * Sostituisce (o rimuove, con userId null) l'assegnatario; NOT_FOUND se
 * ticket o utente non esistono.
 *
 * `previousUserName` per lo stesso motivo di `setTicketTeam`: senza il valore
 * di PRIMA, dal registro non si può dire se un ticket è rimbalzato fra due
 * persone o se è stato assegnato una volta sola.
 */
export async function setTicketUser(session: Session, label: TicketLabel, id: string, userId: string | null, tenantId: string): Promise<{ userName: string | null; previousUserName: string | null }> {
  if (userId === null) {
    const row = await runQueryOne<{ previousUserName: string | null }>(session, `
      MATCH (e:${label} {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->(__prima:User)
      WITH e, old, __prima.name AS previousUserName
      DELETE old
      SET e.updated_at = $now
      RETURN previousUserName
    `, { id, tenantId, now: new Date().toISOString() })
    if (!row) throw new NotFoundError(label, id)
    return { userName: null, previousUserName: row.previousUserName ?? null }
  }
  await assertAssignablePerson(session, userId, tenantId)
  const row = await runQueryOne<{ userName: string | null; previousUserName: string | null }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->(__prima:User)
    WITH e, u, old, __prima.name AS previousUserName
    DELETE old
    WITH DISTINCT e, u, previousUserName
    CREATE (e)-[:ASSIGNED_TO]->(u)
    SET e.updated_at = $now
    RETURN u.name AS userName, previousUserName
  `, { id, userId, tenantId, now: new Date().toISOString() })
  if (!row) throw new NotFoundError(`${label} o User`, `${id} / ${userId}`)
  return { userName: row.userName, previousUserName: row.previousUserName ?? null }
}
