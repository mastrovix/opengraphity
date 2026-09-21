/**
 * Le categorie del ticket come le chiama il cliente: il vocabolario `category`
 * con le etichette del Dizionario, nella lingua attiva. Giro nel browser del
 * 14 set 2026: il portale ne aveva cinque scritte nel codice (mancava
 * «security»), con etichette sue.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_TICKET_CATEGORIES } from '@/graphql/queries'

export interface TicketCategory { name: string; label: string }

export function useTicketCategories() {
  const { i18n } = useTranslation()
  const { data, loading, error } = useQuery<{ ticketCategories: TicketCategory[] }>(GET_TICKET_CATEGORIES, {
    variables: { language: i18n.resolvedLanguage ?? i18n.language },
  })
  const categories = data?.ticketCategories ?? []
  const byName = new Map(categories.map((c) => [c.name, c.label]))
  /** L'etichetta della categoria; il valore stesso se il vocabolario non l'ha (più). */
  const labelOf = (name: string) => byName.get(name) ?? name
  return { categories, labelOf, loading, error }
}
