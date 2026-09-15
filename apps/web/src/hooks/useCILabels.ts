/**
 * Come si legge un CI in un elenco: l'etichetta del tipo (dal metamodello del
 * cliente) e quella dell'ambiente (dal Dizionario), non i valori interni.
 *
 * Giro UI del 15 set 2026 · U-9/U-11: la ricerca dei CI e gli elenchi dei CI
 * impattati mostravano «application · production», e la ricerca diceva
 * «excluded: application» col nome interno del tipo. Un valore che il
 * metamodello o il vocabolario non conoscono resta com'è: è il dato vero, non
 * un'etichetta inventata (come `useFieldValueLabel`).
 */
import { useCallback, useMemo } from 'react'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'

/** I vocabolari dei campi di `__base__` (ambiente e stato di ciclo di vita). */
export const CI_ENVIRONMENT_VOCABULARY = 'environment'
export const CI_STATUS_VOCABULARY = 'ci_status'

export interface CILabels {
  typeLabel:        (type: string) => string
  environmentLabel: (environment: string) => string
  /** Giro UI · U-26: i filtri della topologia umanizzavano il valore («Dr») invece dell'etichetta del Dizionario. */
  statusLabel:      (status: string) => string
  /** «Application · Production»; senza ambiente solo il tipo. */
  subtitle:         (ci: { type: string; environment?: string | null }) => string
}

export function useCILabels(): CILabels {
  const { getCIType } = useMetamodel()
  const { labelOf } = useDomainVocabularies()
  return useMemo(() => {
    const typeLabel = (type: string) => getCIType(type)?.label || type
    const environmentLabel = (environment: string) => labelOf(CI_ENVIRONMENT_VOCABULARY, environment) || environment
    return {
      typeLabel,
      environmentLabel,
      statusLabel: (status: string) => labelOf(CI_STATUS_VOCABULARY, status) || status,
      subtitle: (ci) => (ci.environment ? `${typeLabel(ci.type)} · ${environmentLabel(ci.environment)}` : typeLabel(ci.type)),
    }
  }, [getCIType, labelOf])
}

/** Il vocabolario della criticità di un servizio (BusinessApplication.criticality). */
export const SERVICE_CRITICALITY_VOCABULARY = 'service_criticality'

/**
 * La criticità di un servizio con l'etichetta del Dizionario. Giro UI del 15
 * set 2026: si leggeva «Business Critical», il valore umanizzato.
 */
export function useCriticalityLabel(): (criticality: string) => string {
  const { labelOf } = useDomainVocabularies()
  return useCallback((criticality: string) => labelOf(SERVICE_CRITICALITY_VOCABULARY, criticality) || criticality, [labelOf])
}
