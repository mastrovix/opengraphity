/**
 * `ticket.updated`: l'aggiornamento dei campi di un ticket — revisione del
 * 14 set 2026 · AU-1.
 *
 * Nessuna modifica di campo pubblicava un evento: le automazioni «su
 * aggiornamento» e «campo cambiato» non avevano niente a cui reagire, e un
 * webhook non poteva sapere che un ticket era cambiato. I campi cambiati si
 * calcolano confrontando il nodo prima e dopo la scrittura; `updated_at` non
 * conta. Nessun campo cambiato, nessun evento.
 */
import { TICKET_UPDATED_EVENT, type AutomationEntityType, type TicketUpdatedPayload } from '@opengraphity/types'
import { publishEvent } from './publishEvent.js'

type Props = Record<string, unknown>

const IGNORED = new Set(['updated_at'])

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/** I campi cambiati fra le due versioni del nodo, e i loro valori prima. Pura, per i test. */
export function ticketDiff(before: Props, after: Props): { changed: string[]; previous: Props } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  const previous: Props = {}
  for (const k of keys) {
    if (IGNORED.has(k)) continue
    if (!same(before[k], after[k])) {
      changed.push(k)
      previous[k] = before[k] ?? null
    }
  }
  return { changed: changed.sort(), previous }
}

export async function publishTicketUpdated(
  ctx: { tenantId: string; userId: string },
  entityType: AutomationEntityType,
  entityId: string,
  before: Props,
  after: Props,
): Promise<void> {
  const { changed, previous } = ticketDiff(before, after)
  if (changed.length === 0) return
  const payload: TicketUpdatedPayload = { entity_type: entityType, entity_id: entityId, changed_fields: changed, previous }
  await publishEvent(TICKET_UPDATED_EVENT, ctx.tenantId, ctx.userId, payload)
}
