/**
 * LE COSE DA SISTEMARE NELLA CONFIGURAZIONE, lette una volta sola (20 set
 * 2026, decisione del proprietario dopo il giro nel browser).
 *
 * Il banner stava in cima a OGNI pagina e con tre rilievi aperti si mangiava
 * un quinto dello schermo: si legge una volta e poi dà fastidio per sempre.
 * Ora l'elenco vive nella sua pagina, in Configurazione, e in alto resta una
 * pastiglia col NUMERO che porta lì — presente quanto prima, ingombrante
 * quanto un pallino.
 *
 * Le due cose leggono lo stesso hook: la pastiglia conta quello che la pagina
 * elenca, e il permesso è dichiarato in un posto solo.
 */
import { useQuery } from '@apollo/client/react'
import { pausedWhenHidden } from '@/lib/polling'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import type { IssueData } from '@/lib/configurationIssueText'

export interface ConfigurationIssues {
  /** I rilievi, o vuoto: se la diagnostica non risponde non si inventa niente. */
  issues: IssueData[]
  /** Quanti sono di gravità «error» (il resto sono avvisi). */
  errors: number
  /** Chi legge può anche vedere la pagina: senza questo non si chiede nulla. */
  mayRead: boolean
  loading: boolean
}

export function useConfigurationIssues(): ConfigurationIssues {
  const { can } = useMe()
  // La diagnostica della configurazione è della salute della piattaforma (ondata 7).
  const mayRead = can('admin.system')

  const { data, error, loading } = useQuery<{ configurationIssues: IssueData[] }>(GET_CONFIGURATION_ISSUES, {
    skip: !mayRead,
    fetchPolicy: 'cache-and-network',
    // La diagnostica cambia anche per fatti che non passano da questa pagina
    // (un ticket risolto da un allarme): senza rilettura si elencava ancora un
    // incident già risolto.
    ...pausedWhenHidden(60_000),
  })

  // Un errore qui non deve rompere la pagina: se la diagnostica non risponde,
  // la pastiglia semplicemente non c'è (e il problema vero resta nei log del
  // server, dove la diagnostica stessa lo scrive).
  const issues = error ? [] : data?.configurationIssues ?? []
  return { issues, errors: issues.filter((i) => i.severity === 'error').length, mayRead, loading }
}
