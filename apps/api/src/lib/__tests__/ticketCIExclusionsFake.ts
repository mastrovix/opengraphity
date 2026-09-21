/**
 * Doppio di `lib/ticketCIExclusions.ts` per i test dei servizi che non parlano
 * delle esclusioni: nessuna esclusione, e le chiamate registrate così un test
 * può pretendere che il controllo ci sia (CM-8).
 */
import { vi } from 'vitest'
import { TICKET_CI_TYPES } from '@opengraphity/types'

export { TICKET_CI_TYPES }
export const assertCIsLinkable = vi.fn(async (_tenantId: string, _ticketType: string, _ciIds: readonly string[]) => {})
export const excludedCITypes = vi.fn(async () => [] as readonly string[])
export const assertTicketCIType = (v: unknown) => v
export const setTicketCIExclusions = vi.fn()
