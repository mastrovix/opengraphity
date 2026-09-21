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
import { useTranslation } from 'react-i18next'
import { localizedLabel } from '@opengraphity/types'
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
  const { getCIType, ciTypes } = useMetamodel()
  const { labelOf } = useDomainVocabularies()
  const { i18n } = useTranslation()
  const lingua = i18n.resolvedLanguage ?? i18n.language
  return useMemo(() => {
    /*
     * UNA SOLA REGOLA PER IL NOME DI UN TIPO (20 set 2026, dal giro nel
     * browser: «Portale clienti — businessapplication»).
     *
     * Ne giravano tre: la CMDB metteva davanti l'etichetta del disegnatore
     * (regola F-22), cinque pagine una tabella CABLATA di sei traduzioni, e
     * la pagina Anomalie quella tabella senza ripiego — quindi ogni tipo
     * creato dal cliente usciva col nome interno. Lo stesso tipo si leggeva
     * «Application», «Applicazione» o «businessapplication» secondo la
     * pagina.
     *
     * Ora c'è un ordine solo, e sono le stesse due regole che il prodotto usa
     * già per i campi e le relazioni:
     *  1. le `labels` che il CLIENTE scrive nel disegnatore, nella lingua di
     *     chi guarda — il suo tipo, il suo nome, in ogni lingua che parla;
     *  2. l'etichetta del nodo, che per i tipi spediti arriva già tradotta
     *     dal `MetamodelProvider` (`shippedLabel('type', …)`): tradotta
     *     finché è quella spedita, intoccata se il cliente l'ha rinominata.
     * Il nome interno resta l'ultima spiaggia: un'anomalia storica può citare
     * un tipo cancellato, e il nome è meglio del nulla.
     */
    /*
     * Il tipo arriva in due grafie: il NOME del metamodello
     * (`business_application`) e, da chi legge il grafo, l'etichetta Neo4j
     * minuscola (`businessapplication` — visto dal vivo nelle anomalie). Si
     * confronta senza maiuscole e senza trattini bassi, così le due si
     * incontrano: cercare solo per nome lasciava «businessapplication» a
     * schermo.
     */
    const senzaForma = (x: string) => x.toLowerCase().replace(/_/g, '')
    const typeLabel = (type: string) => {
      const def = getCIType(type) ?? ciTypes.find((t) => senzaForma(t.name) === senzaForma(type))
      return def ? localizedLabel(def.label || type, def.labels ?? [], lingua) : type
    }
    const environmentLabel = (environment: string) => labelOf(CI_ENVIRONMENT_VOCABULARY, environment) || environment
    return {
      typeLabel,
      environmentLabel,
      statusLabel: (status: string) => labelOf(CI_STATUS_VOCABULARY, status) || status,
      subtitle: (ci) => (ci.environment ? `${typeLabel(ci.type)} · ${environmentLabel(ci.environment)}` : typeLabel(ci.type)),
    }
  }, [getCIType, ciTypes, labelOf, lingua])
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
