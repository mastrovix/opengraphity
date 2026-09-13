/**
 * All'avvio: in che lingua si legge questo cliente.
 *
 * Il bundle non può saperlo — è configurazione del cliente, e sta nel grafo —
 * quindi si chiede all'API e si applica a chi non ha una lingua propria. Vale
 * per la maggioranza: nessuno passa dal Profilo il primo giorno.
 *
 * L'ordine dei fatti, che è il punto di tutto:
 *   la scelta della PERSONA  →  la predefinita dell'AZIENDA  →  la prima lingua
 *   del prodotto (e la diagnostica dice all'admin di configurarla).
 *
 * Prima di tutto questo decideva `navigator`, cioè il browser, che non è
 * nessuno dei tre.
 */
import { useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { applicaLinguaDelCliente, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }

export function useTenantLanguage(): void {
  const { data } = useQuery<{ tenantLanguageSettings: LanguageSettings }>(GET_TENANT_LANGUAGE_SETTINGS, {
    fetchPolicy: 'cache-first',
  })
  const lingua = data?.tenantLanguageSettings.defaultLanguage ?? null

  useEffect(() => {
    if (lingua === null) return              // non configurata: lo dice la diagnostica
    if (linguaSceltaDallUtente()) return     // la scelta di una persona vince
    void applicaLinguaDelCliente(lingua)
  }, [lingua])
}
