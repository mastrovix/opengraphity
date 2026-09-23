/**
 * COSA MISURA UN CONTRATTO OLA/UC (secondo giro UI del 15 set 2026, decisione
 * del proprietario: «il tempo del team»).
 *
 * ## Com'era
 * V-17 aveva legato il contratto al suo team, ma misurava dall'APERTURA del
 * ticket alla conclusione, col team che il ticket aveva alla fine: un team
 * pagava anche il tempo in cui il ticket era di altri. E gli avvisi, armati
 * all'apertura e scattati una volta sola, non vedevano riassegnazioni, obiettivi
 * cambiati né contratti riattivati.
 *
 * ## La regola, una sola per report, riquadro del ticket e avvisi
 * Un contratto misura il tempo in cui il ticket è stato DEL SUO TEAM: la somma
 * dei tratti di assegnazione a quel team (`lib/ticketTeamHistory.ts`), contati
 * dal momento in cui il contratto esiste e fino alla conclusione del ticket (o
 * adesso), sul calendario del contratto e nel fuso dell'organizzazione. Il
 * tempo NON si ferma quando lo SLA è in pausa.
 *  - usato oltre l'obiettivo            → violato (anche se poi è passato ad altri);
 *  - concluso entro l'obiettivo         → rispettato;
 *  - aperto e del team, entro l'obiettivo → in corso (con la scadenza);
 *  - aperto, passato ad altri, entro      → passato ad altri.
 * I tratti ricostruiti (`inferred`: ticket che c'erano prima della storia)
 * partono dall'apertura del ticket, e chi mostra il risultato lo dice.
 * Un contratto senza team (dato vecchio) conta dall'apertura, per ogni team.
 *
 * ## Le change: una misura per task (decisione del proprietario)
 * Una change non ha un team: ce l'hanno i suoi task. Ogni task di assessment è
 * una misura (tempo del team fino al completamento); ogni passo del piano di
 * deploy ne dà due, validazione e rilascio, che partono dall'inizio della loro
 * finestra (`startsAt`) e finiscono col test registrato e col deployment
 * eseguito. Prima dell'inizio della finestra il tempo non corre («pianificato»);
 * fatto prima, conta zero. Vedi `olaChangeUnits.ts`.
 */
import { businessMinutesBetween, calculateDeadline, type ServiceCalendar } from '@opengraphity/sla'

/** Il campo di conclusione per tipo di ticket (lo stesso di `packages/sla/olaBreach.ts`). */
export const OLA_CONCLUDED_FIELD: Readonly<Record<string, { label: string; field: string }>> = {
  incident:        { label: 'Incident',       field: 'resolved_at' },
  problem:         { label: 'Problem',        field: 'resolved_at' },
  service_request: { label: 'ServiceRequest', field: 'completed_at' },
  change:          { label: 'Change',         field: 'completed_at' },
}

/** I tipi di ticket che un contratto copre. */
export function olaEntityTypes(entityType: string): string[] {
  if (entityType === 'any') return Object.keys(OLA_CONCLUDED_FIELD)
  if (!OLA_CONCLUDED_FIELD[entityType]) throw new Error(`OLA/UC contract scope "${entityType}" is not a ticket type (${Object.keys(OLA_CONCLUDED_FIELD).join(', ')}, any)`)
  return [entityType]
}

export interface TeamSegment { teamId: string; startedAt: string; endedAt: string | null; inferred: boolean }

export interface OLATicketFacts {
  createdAt:     string
  concludedAt:   string | null
  currentTeamId: string | null
  /** I tratti di assegnazione del ticket (tutti, o solo quelli del team: il calcolo filtra). */
  segments:      readonly TeamSegment[]
  /** Da quando il tempo può correre (la finestra di un piano di deploy): prima non conta. Assente = dall'assegnazione. */
  startsAt?:     string | null
}

export interface OLAContractRule {
  teamId:         string | null
  /** Da quando il contratto esiste: il tempo prima non conta. */
  createdAt:      string | null
  resolveMinutes: number
  businessHours:  boolean
  calendar:       ServiceCalendar | null
  /**
   * The contract's own time zone; null = the organization's (tour of 23 Sep
   * 2026). A team in Singapore works 9-18 in Singapore: counted in the
   * organization's zone, its calendar was six or seven hours off, so the demo
   * could give OLAs only to the teams in the organization's zone.
   */
  timezone:       string | null
}

/** The zone a contract counts in: its own, or the organization's. */
export function olaTimezone(contract: Pick<OLAContractRule, 'timezone'>, organizationTimezone: string): string {
  return contract.timezone ?? organizationTimezone
}

export type OLATeamState = 'met' | 'breached' | 'running' | 'handed_off' | 'scheduled'

export interface OLATeamMeasure {
  /** Il team ha avuto il ticket da quando il contratto esiste. */
  applies:          boolean
  /** Perché non conta: il team non l'ha mai avuto, o l'ha avuto solo prima del contratto. */
  reason:           'other_team' | 'before_contract' | null
  usedMinutes:      number
  remainingMinutes: number
  state:            OLATeamState | null
  /** In corso: quando scade se il team lo tiene. Pianificato: quando scadrebbe partendo all'inizio della finestra. */
  deadline:         string | null
  /** Almeno un tratto ricostruito (inizio = apertura del ticket). */
  inferred:         boolean
}

function iso(v: string, what: string): Date {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`OLA/UC: unreadable ${what} ${JSON.stringify(v)}`)
  return d
}

/** La misura di un contratto su un ticket, adesso (`now`). */
export function olaTeamMeasure(ticket: OLATicketFacts, contract: OLAContractRule, organizationTimezone: string, now: Date = new Date()): OLATeamMeasure {
  const timezone = olaTimezone(contract, organizationTimezone)
  const concluded = ticket.concludedAt ? iso(ticket.concludedAt, 'conclusion') : null
  const until = concluded ?? now
  const contractFrom = contract.createdAt ? iso(contract.createdAt, 'contract creation') : null
  const startsAt = ticket.startsAt ? iso(ticket.startsAt, 'window start') : null
  const segments: TeamSegment[] = contract.teamId === null
    ? [{ teamId: '*', startedAt: ticket.createdAt, endedAt: null, inferred: true }]
    : ticket.segments.filter((s) => s.teamId === contract.teamId)

  let used = 0
  let counted = 0
  let inferred = false
  for (const s of segments) {
    const start = iso(s.startedAt, 'segment start')
    const end = s.endedAt ? iso(s.endedAt, 'segment end') : until
    // Il team l'ha avuto mentre il contratto esisteva?
    const heldFrom = contractFrom && contractFrom > start ? contractFrom : start
    const heldTo = end < until ? end : until
    if (heldTo <= heldFrom && !(s.endedAt === null && !concluded && heldFrom <= now)) continue
    counted++
    inferred ||= s.inferred
    // Il tempo corre solo dall'inizio della finestra, se c'è.
    const from = startsAt && startsAt > heldFrom ? startsAt : heldFrom
    if (heldTo > from) used += businessMinutesBetween(from, heldTo, contract.businessHours, timezone, contract.calendar)
  }
  if (counted === 0) {
    return {
      applies: false, reason: segments.length > 0 ? 'before_contract' : 'other_team',
      usedMinutes: 0, remainingMinutes: contract.resolveMinutes, state: null, deadline: null, inferred: false,
    }
  }
  const remaining = Math.max(0, contract.resolveMinutes - used)
  const withTeamNow = !concluded && (contract.teamId === null || ticket.currentTeamId === contract.teamId)
  const notStarted = !concluded && startsAt !== null && now < startsAt
  const state: OLATeamState = used > contract.resolveMinutes ? 'breached'
    : concluded ? 'met'
    : !withTeamNow ? 'handed_off'
    : notStarted ? 'scheduled' : 'running'
  const deadline = state === 'running' ? calculateDeadline(now, remaining, contract.businessHours, timezone, contract.calendar).toISOString()
    : state === 'scheduled' ? calculateDeadline(startsAt!, contract.resolveMinutes, contract.businessHours, timezone, contract.calendar).toISOString()
    : null
  return { applies: true, reason: null, usedMinutes: Math.round(used), remainingMinutes: Math.round(remaining), state, inferred, deadline }
}

/** Rispettati e violati fra i ticket conclusi: quelli su cui il contratto conta. */
export function evaluateOLATeamTickets(
  tickets: readonly OLATicketFacts[], contract: OLAContractRule, timezone: string, now: Date = new Date(),
): { evaluated: number; met: number; breached: number; inferred: number } {
  let met = 0
  let breached = 0
  let inferred = 0
  for (const t of tickets) {
    const m = olaTeamMeasure(t, contract, timezone, now)
    if (!m.applies || !t.concludedAt) continue
    if (m.inferred) inferred++
    if (m.state === 'breached') breached++
    else met++
  }
  return { evaluated: met + breached, met, breached, inferred }
}

/**
 * I ticket di un tipo conclusi nel periodo che il team del contratto ha avuto
 * (un tratto di assegnazione), con i loro tratti di quel team. `$teamId` null =
 * contratto senza team (dato vecchio): tutti i ticket conclusi, dall'apertura.
 */
export function olaConcludedTicketsCypher(entityType: string): string {
  const m = OLA_CONCLUDED_FIELD[entityType]
  if (!m) throw new Error(`olaConcludedTicketsCypher: unknown ticket type "${entityType}"`)
  if (entityType === 'change') throw new Error('olaConcludedTicketsCypher: a change is measured on its tasks (olaChangeUnits.ts), it has no team of its own')
  return `
    MATCH (e:${m.label} {tenant_id: $tenantId})
    WHERE e.${m.field} IS NOT NULL AND e.${m.field} >= $cutoff AND e.created_at IS NOT NULL
      AND ($teamId IS NULL OR EXISTS { (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment {team_id: $teamId}) })
    OPTIONAL MATCH (e)-[:TEAM_SEGMENT]->(s:TicketTeamSegment)
      WHERE $teamId IS NOT NULL AND s.team_id = $teamId
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(ct:Team)
    RETURN e.created_at AS createdAt, e.${m.field} AS concludedAt, ct.id AS currentTeamId,
           [x IN collect(DISTINCT s) | {teamId: x.team_id, startedAt: x.started_at, endedAt: x.ended_at, inferred: coalesce(x.inferred, false)}] AS segments`
}

/** Il ticket con i suoi tratti, per il riquadro OLA/UC del dettaglio. */
export function olaTicketFactsCypher(entityType: string): string {
  const m = OLA_CONCLUDED_FIELD[entityType]
  if (!m) throw new Error(`olaTicketFactsCypher: unknown ticket type "${entityType}"`)
  if (entityType === 'change') throw new Error('olaTicketFactsCypher: a change is measured on its tasks (olaChangeUnits.ts), it has no team of its own')
  return `
    MATCH (e:${m.label} {id: $entityId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:TEAM_SEGMENT]->(s:TicketTeamSegment)
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(ct:Team)
    RETURN e.created_at AS createdAt, e.${m.field} AS concludedAt, ct.id AS currentTeamId,
           [x IN collect(DISTINCT s) | {teamId: x.team_id, startedAt: x.started_at, endedAt: x.ended_at, inferred: coalesce(x.inferred, false)}] AS segments
    LIMIT 1`
}
