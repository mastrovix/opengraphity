/**
 * I tipi di CI esclusi per un tipo di ticket (revisione del 15 set 2026 · CM-8).
 *
 * Servono alla ricerca dei CI da collegare: i tipi esclusi non si propongono.
 * L'API rifiuta comunque il collegamento, da qualunque strada arrivi; qui si
 * evita di offrire un CI che verrebbe rifiutato. `excluded` è `undefined`
 * finché la lettura non è arrivata: chi cerca aspetta, per non proporre per un
 * attimo i tipi esclusi.
 */
import { useQuery } from '@apollo/client/react'
import { GET_TICKET_CI_EXCLUSIONS } from '@/graphql/queries'

export type TicketCIType = 'incident' | 'problem' | 'change' | 'service_request'

export function useTicketCIExclusions(ticketType: TicketCIType): { excluded: readonly string[] | undefined; error: Error | undefined } {
  const { data, error } = useQuery<{ ticketCIExclusions: { ticketType: string; ciTypes: string[] }[] }>(GET_TICKET_CI_EXCLUSIONS, {
    variables: { ticketType },
    fetchPolicy: 'cache-and-network',
  })
  const excluded = data?.ticketCIExclusions.find((x) => x.ticketType === ticketType)?.ciTypes
  return { excluded, error: error as Error | undefined }
}
