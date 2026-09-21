/**
 * Il FUSO dell'organizzazione, per i campi data-e-ora.
 *
 * Revisione totale · F-13: i campi `datetime-local` delle finestre di
 * validazione e rilascio convertivano col fuso del BROWSER, mentre le finestre
 * sono pianificate nel fuso dell'organizzazione (`Tenant.timezone`, lo stesso
 * che decide le scadenze SLA e le passate OLA). Un operatore in viaggio che
 * pianificava «22:00» la salvava alle 22:00 del posto in cui si trovava, cioè
 * a un'altra ora per il cliente — e nessuno lo diceva.
 *
 * Finché la risposta non è arrivata il fuso è `null`: chi lo usa mostra
 * comunque il campo, col fuso del browser, e l'etichetta dice quale fuso sta
 * usando. Meglio un'informazione in ritardo che una conversione silenziosa.
 */
import { useQuery } from '@apollo/client/react'
import { GET_TENANT_TIMEZONE_SETTINGS } from '@/graphql/queries'

export function useTenantTimezone(): { timeZone: string | null; loading: boolean } {
  const { data, loading } = useQuery<{ tenantTimezoneSettings: { timezone: string | null } }>(
    GET_TENANT_TIMEZONE_SETTINGS, { fetchPolicy: 'cache-first' },
  )
  return { timeZone: data?.tenantTimezoneSettings.timezone ?? null, loading }
}
