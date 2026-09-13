/**
 * All'avvio: in che lingua si legge questo cliente.
 *
 * Come nel web, con una differenza che conta: qui non c'è nessuna scelta
 * personale da rispettare. Chi apre il portale è un `end_user`, non ha una
 * pagina del Profilo, e quindi la lingua predefinita dell'azienda è l'unica
 * cosa che decide. Prima decideva il browser (`navigator` nel rilevamento di
 * i18next) e il ripiego era l'italiano scritto nel codice.
 */
import { useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import i18n from '@/i18n/i18n'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }

export function usePortalLanguage(): void {
  const { data } = useQuery<{ tenantLanguageSettings: LanguageSettings }>(GET_TENANT_LANGUAGE_SETTINGS, {
    fetchPolicy: 'cache-first',
  })
  const lingua = data?.tenantLanguageSettings.defaultLanguage ?? null

  useEffect(() => {
    // `null` = nessuno l'ha configurata: resta la lingua di bootstrap, e a
    // dirlo all'admin ci pensa la diagnostica nel web (dove l'admin sta).
    if (lingua === null || i18n.language === lingua) return
    void i18n.changeLanguage(lingua)
  }, [lingua])
}
