/**
 * Le fasce di rischio **di questo cliente**, nel browser (verifica «Cosa resta
 * cablato», ondata 1).
 *
 * Soglie e nomi delle fasce si dichiarano in Matrici di dominio
 * (`Tenant.risk_band_thresholds`, `lib/riskBands.ts` nell'API) e decidono la
 * priorità della change. Il badge del rischio però calcolava tre livelli fissi
 * (≤30 low, ≤60 medium, oltre high): con soglie 20/50, o con quattro fasce, la
 * priorità seguiva il cliente e il badge diceva altro.
 *
 * Un contesto e non un hook per componente, per la stessa ragione di
 * `DomainVocabularyContext`: una lista di change monta un badge per riga.
 *
 * `bandOf` restituisce `null` quando le soglie non si conoscono (query in
 * corso, in errore, provider non montato): chi mostra il badge mostra il solo
 * punteggio, che è vero, invece di indovinare una fascia.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_RISK_BAND_THRESHOLDS } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

export interface RiskBandThreshold { band: string; upTo: number }

export interface RiskBands {
  /** La fascia del punteggio secondo le soglie del cliente, o `null` se non si conoscono. */
  bandOf: (score: number) => string | null
  loading: boolean
  error:   string | null
}

/** La fascia per `score`: la prima la cui soglia lo contiene. Esportata per i test. */
export function bandForScore(thresholds: readonly RiskBandThreshold[], score: number): string | null {
  return thresholds.find((t) => score <= t.upTo)?.band ?? null
}

/** Esportato per i test, che iniettano le soglie senza query. */
export const RiskBandContext = createContext<RiskBands>({ bandOf: () => null, loading: false, error: null })

export function RiskBandProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useQuery<{ riskBandThresholds: { thresholds: RiskBandThreshold[] } | null }>(
    GET_RISK_BAND_THRESHOLDS, { fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const value = useMemo<RiskBands>(() => {
    const thresholds = !loading && !error ? (data?.riskBandThresholds?.thresholds ?? null) : null
    if (error) console.error(`[risk-bands] the risk bands of this tenant are unavailable: ${error.message}`)
    return {
      bandOf:  (score) => (thresholds ? bandForScore(thresholds, score) : null),
      loading,
      error:   error ? error.message : null,
    }
  }, [data, loading, error])
  return <RiskBandContext.Provider value={value}>{children}</RiskBandContext.Provider>
}

export function useRiskBands(): RiskBands {
  return useContext(RiskBandContext)
}
