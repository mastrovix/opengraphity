/**
 * I tipi di CI esclusi per tipo di ticket, dall'interfaccia (revisione del 15
 * set 2026 · CM-8). La regola e la validazione stanno in
 * `lib/ticketCIExclusions.ts`; qui si legge e si salva.
 */
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import {
  TICKET_CI_TYPES, assertTicketCIType, excludedCITypes, setTicketCIExclusions as saveExclusions,
} from '../../lib/ticketCIExclusions.js'

async function ticketCIExclusions(_: unknown, args: { ticketType?: string | null }, ctx: GraphQLContext) {
  const types = args.ticketType == null ? TICKET_CI_TYPES : [assertTicketCIType(args.ticketType)]
  return Promise.all(types.map(async (ticketType) => ({
    ticketType,
    ciTypes: [...await excludedCITypes(ctx.tenantId, ticketType)],
  })))
}

async function setTicketCIExclusions(_: unknown, args: { ticketType: string; ciTypes: string[] }, ctx: GraphQLContext) {
  const before = args.ticketType && TICKET_CI_TYPES.includes(args.ticketType as never)
    ? [...await excludedCITypes(ctx.tenantId, assertTicketCIType(args.ticketType))]
    : []
  const saved = await saveExclusions(ctx.tenantId, args.ticketType, args.ciTypes)
  void audit(ctx, 'ticket_ci_exclusions.updated', 'Tenant', ctx.tenantId, { ticketType: saved.ticketType, from: before, to: saved.ciTypes })
  return saved
}

export const ticketCIExclusionResolvers = {
  Query:    { ticketCIExclusions },
  Mutation: { setTicketCIExclusions },
}
