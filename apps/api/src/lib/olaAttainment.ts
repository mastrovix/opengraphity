/**
 * Il rispetto di un contratto OLA/UC nel report (secondo giro UI del 15 set
 * 2026 · V-17).
 *
 * ## Il difetto
 * Per ogni contratto il report contava TUTTI i ticket del tipo conclusi nel
 * periodo, di qualunque team, misurati 24×7 da `created_at` a `resolved_at`.
 * Dal vivo: un OLA creato due minuti prima per «Sistemi e Server», con il
 * calendario «Service hours», mostrava già «100% (5/5)», identico all'OLA di un
 * altro team e all'UC del fornitore.
 *
 * ## La regola
 * Un contratto vale per i ticket:
 *  - del suo ambito (`any` = incident, problem, change e richieste);
 *  - assegnati al suo team (`team_id`, interno per un OLA, esterno per un UC);
 *  - nati da quando il contratto esiste (i controlli di breach si armano alla
 *    creazione del ticket: prima il contratto non c'era);
 *  - conclusi nel periodo del report.
 * Il tempo si misura come i controlli di breach: la scadenza è
 * `calculateDeadline(creazione, obiettivo, calendario del contratto, fuso del
 * tenant)`, rispettato se la conclusione non la supera.
 */
import { calculateDeadline, type ServiceCalendar } from '@opengraphity/sla'

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

/**
 * I ticket di un tipo conclusi nel periodo, del team del contratto, nati dopo
 * il contratto. `$teamId` null = contratto senza team (dato vecchio): nessun
 * filtro di team, com'era. `$contractCreatedAt` null = nessun filtro di data.
 */
export function olaConcludedTicketsCypher(entityType: string): string {
  const m = OLA_CONCLUDED_FIELD[entityType]
  if (!m) throw new Error(`olaConcludedTicketsCypher: unknown ticket type "${entityType}"`)
  return `
    MATCH (e:${m.label} {tenant_id: $tenantId})
    WHERE e.${m.field} IS NOT NULL AND e.${m.field} >= $cutoff AND e.created_at IS NOT NULL
      AND ($contractCreatedAt IS NULL OR e.created_at >= $contractCreatedAt)
      AND ($teamId IS NULL OR EXISTS { (e)-[:ASSIGNED_TO_TEAM]->(:Team {id: $teamId, tenant_id: $tenantId}) })
    RETURN e.created_at AS createdAt, e.${m.field} AS concludedAt`
}

export interface OLATimedTicket { createdAt: string; concludedAt: string }

/** Rispettati e violati: la conclusione confrontata con la scadenza del contratto. */
export function evaluateOLATickets(
  tickets: readonly OLATimedTicket[],
  contract: { resolveMinutes: number; businessHours: boolean; calendar: ServiceCalendar | null },
  timezone: string,
): { evaluated: number; met: number; breached: number } {
  let met = 0
  let breached = 0
  for (const t of tickets) {
    const created = new Date(t.createdAt)
    const concluded = new Date(t.concludedAt)
    if (Number.isNaN(created.getTime()) || Number.isNaN(concluded.getTime())) {
      throw new Error(`OLA/UC attainment: unreadable ticket dates (created_at ${JSON.stringify(t.createdAt)}, concluded ${JSON.stringify(t.concludedAt)})`)
    }
    const deadline = calculateDeadline(created, contract.resolveMinutes, contract.businessHours, timezone, contract.calendar)
    if (concluded.getTime() <= deadline.getTime()) met++
    else breached++
  }
  return { evaluated: met + breached, met, breached }
}

/** Lo stato di un contratto su un ticket: rispettato, violato, in corso. */
export type OLATicketState = 'met' | 'breached' | 'running'

/**
 * La scadenza e lo stato di un contratto su UN ticket, con le regole del report:
 * scadenza = creazione + obiettivo sul calendario del contratto; concluso entro
 * la scadenza = rispettato; aperto oltre la scadenza = violato.
 */
export function olaTicketState(
  ticket: { createdAt: string; concludedAt: string | null },
  contract: { resolveMinutes: number; businessHours: boolean; calendar: ServiceCalendar | null },
  timezone: string,
  now: Date = new Date(),
): { deadline: string; state: OLATicketState } {
  const created = new Date(ticket.createdAt)
  if (Number.isNaN(created.getTime())) throw new Error(`OLA/UC: unreadable ticket created_at ${JSON.stringify(ticket.createdAt)}`)
  const deadline = calculateDeadline(created, contract.resolveMinutes, contract.businessHours, timezone, contract.calendar)
  if (ticket.concludedAt) {
    const concluded = new Date(ticket.concludedAt)
    if (Number.isNaN(concluded.getTime())) throw new Error(`OLA/UC: unreadable ticket conclusion ${JSON.stringify(ticket.concludedAt)}`)
    return { deadline: deadline.toISOString(), state: concluded.getTime() <= deadline.getTime() ? 'met' : 'breached' }
  }
  return { deadline: deadline.toISOString(), state: now.getTime() > deadline.getTime() ? 'breached' : 'running' }
}
