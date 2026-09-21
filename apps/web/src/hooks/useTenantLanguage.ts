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
import { useMutation, useQuery } from '@apollo/client/react'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { SET_MY_LANGUAGE } from '@/graphql/mutations'
import { useMe } from '@/hooks/useMe'
import i18n from '@/i18n/i18n'
import { applicaLinguaDelCliente, linguaSceltaDallUtente, scegliLinguaPersonale, usaLinguaDellOrganizzazione } from '@/i18n/tenantLanguage'

/** Una volta per browser: la scelta che stava solo qui è stata portata sulla persona. */
const CHIAVE_PORTATA = 'og.language.synced'
function giaPortata(): boolean {
  try { return window.localStorage.getItem(CHIAVE_PORTATA) === 'true' } catch { return true }
}
function segnaPortata(): void {
  try { window.localStorage.setItem(CHIAVE_PORTATA, 'true') } catch { /* localStorage negato: si riproverà, innocuo */ }
}

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }

export function useTenantLanguage(): void {
  const { data } = useQuery<{ tenantLanguageSettings: LanguageSettings }>(GET_TENANT_LANGUAGE_SETTINGS, {
    fetchPolicy: 'cache-first',
  })
  const lingua = data?.tenantLanguageSettings.defaultLanguage ?? null
  const { me, loading: meLoading } = useMe()
  const [salvaLingua] = useMutation(SET_MY_LANGUAGE, { refetchQueries: ['GetMe'] })
  const personale = me?.language ?? null

  useEffect(() => {
    if (meLoading) return
    // Secondo giro UI del 15 set 2026: la scelta della persona sta sul suo nodo
    // (`me.language`), così la vede anche il portale.
    if (personale) { void scegliLinguaPersonale(personale); segnaPortata(); return }
    if (me && linguaSceltaDallUtente() && !giaPortata()) {
      // Scelta fatta prima, quando stava solo nel browser: la si porta sulla persona una volta.
      segnaPortata()
      void salvaLingua({ variables: { language: i18n.resolvedLanguage ?? i18n.language } })
      return
    }
    if (me && linguaSceltaDallUtente()) void usaLinguaDellOrganizzazione(null)   // tolta da un altro posto
    if (lingua === null) return              // non configurata: lo dice la diagnostica
    void applicaLinguaDelCliente(lingua)
  }, [lingua, personale, me, meLoading, salvaLingua])
}
