/**
 * Doppio di `lib/ticketNumbering.ts` per i test dei servizi: il formato di
 * fabbrica (INC/PRB/CHG/REQ, 8 cifre) senza leggere il Tenant, e il contatore
 * vero di `lib/sequence.ts` (che i test simulano già con la sessione).
 */
import { nextSequenceValue, type SessionOrTx } from '../sequence.js'

export const TICKET_NUMBER_KINDS = ['incident', 'problem', 'change', 'service_request'] as const
export type TicketNumberKind = (typeof TICKET_NUMBER_KINDS)[number]
export const FACTORY_TICKET_NUMBERING = {
  incident:        { prefix: 'INC', digits: 8 },
  problem:         { prefix: 'PRB', digits: 8 },
  change:          { prefix: 'CHG', digits: 8 },
  service_request: { prefix: 'REQ', digits: 8 },
} as const

export async function ticketNumbering() { return { ...FACTORY_TICKET_NUMBERING, isDefault: true } }

export async function nextTicketNumber(s: SessionOrTx, tenantId: string, kind: TicketNumberKind): Promise<string> {
  const f = FACTORY_TICKET_NUMBERING[kind]
  return f.prefix + String(await nextSequenceValue(s, tenantId, kind)).padStart(f.digits, '0')
}
