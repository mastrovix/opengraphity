/**
 * Le lingue in cui il cliente scrive le sue etichette.
 *
 * L'elenco viene dall'API (`tenantLanguageSettings.available`), come per la
 * pagina Organizzazione e per le severità del portale: era una costante del
 * web, e una terza lingua aggiunta lato server sarebbe stata offerta da una
 * pagina e non dalle altre (revisione totale · G-12).
 *
 * Stava dentro al Dizionario; dal 20 set 2026 la usa anche il disegnatore dei
 * tipi CI, che ha le sue etichette per lingua — quindi vive qui, una volta.
 * I nomi delle lingue non si traducono: sono nomi propri.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

const NOMI_LINGUA: Record<string, string> = { it: 'Italiano', en: 'English' }

export interface LinguaDelCliente { codice: string; nome: string }

export function useLingue(): LinguaDelCliente[] {
  const { data } = useQuery<{ tenantLanguageSettings: { available: string[] } }>(
    GET_TENANT_LANGUAGE_SETTINGS, { fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  return useMemo(
    () => (data?.tenantLanguageSettings.available ?? []).map((codice) => ({ codice, nome: NOMI_LINGUA[codice] ?? codice })),
    [data],
  )
}
