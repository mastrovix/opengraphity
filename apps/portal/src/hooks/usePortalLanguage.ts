/**
 * All'avvio: in che lingua si legge questo cliente.
 *
 * Come nel web: prima la lingua scelta dalla PERSONA (`me.language`, dal
 * Profilo del web o dal menu del portale), poi quella dell'azienda. Secondo
 * giro UI del 15 set 2026: la scelta personale stava solo nel browser del web,
 * e il portale restava nella lingua dell'organizzazione anche per chi aveva
 * scelto l'italiano. Prima ancora decideva il browser (`navigator`).
 */
import { useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import i18n from '@/i18n/i18n'
import { GET_ME, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }

export function usePortalLanguage(): void {
  const { data } = useQuery<{ tenantLanguageSettings: LanguageSettings }>(GET_TENANT_LANGUAGE_SETTINGS, {
    fetchPolicy: 'cache-first',
  })
  const { data: meData } = useQuery<{ me: { language: string | null } | null }>(GET_ME)
  const lingua = meData?.me?.language ?? data?.tenantLanguageSettings.defaultLanguage ?? null

  useEffect(() => {
    // `null` = nessuno l'ha configurata: resta la lingua di bootstrap, e a
    // dirlo all'admin ci pensa la diagnostica nel web (dove l'admin sta).
    if (lingua === null || i18n.language === lingua) return
    void i18n.changeLanguage(lingua)
  }, [lingua])
}
