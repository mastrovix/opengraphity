import { useQuery } from '@apollo/client/react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GET_WORKFLOW_DEFINITION } from '@/graphql/queries/workflow'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { localizedLabel, withLocalizedLabel, type LocalizedLabel } from '@/lib/localizedLabel'

export interface WorkflowStepMeta {
  id:         string
  name:       string
  /** Già nella lingua di chi guarda (vedi `useWorkflowSteps`). */
  label:      string
  /** Traduzioni dell'etichetta spedita: `labelFor` sceglie la lingua attiva. */
  labels?:    LocalizedLabel[]
  type:       string
  isInitial:  boolean
  isTerminal: boolean
  isOpen:     boolean
  category:   string | null
  /**
   * Lo SCOPO del passo (vocabolario chiuso `WORKFLOW_STEP_PURPOSES`): che ruolo
   * ha nel processo — approvazione, finestra di rilascio, analisi… È così che
   * le pagine riconoscono un passo che il cliente ha rinominato (ondata 4).
   * `null` = non dichiarato, e non si indovina dal nome.
   */
  purpose:    string | null
  order:      number
}

/**
 * Fetch workflow step metadata for an entity type. Cached by Apollo so the
 * same tenant+entityType is shared across components.
 *
 * Returns the raw steps plus derived lookups and filter helpers so callers
 * never need to hardcode a step name.
 */
/** Un arco del workflow: serve a chi deve sapere DOVE si può andare da un passo. */
export interface WorkflowTransitionMeta {
  id:           string
  fromStepName: string
  toStepName:   string
  trigger:      string
}

export function useWorkflowSteps(entityType: string) {
  const { data, loading, error } = useQuery<{ workflowDefinition: { steps: WorkflowStepMeta[]; transitions?: WorkflowTransitionMeta[] } | null }>(
    GET_WORKFLOW_DEFINITION,
    // Entità vuota = chi chiama non ha un workflow da leggere (un CI, un evento): nessuna richiesta.
    { variables: { entityType }, fetchPolicy: METAMODEL_FETCH_POLICY, skip: !entityType },
  )

  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language

  return useMemo(() => {
    /*
      `label` arriva già nella lingua di chi guarda. Secondo giro UI del 15 set
      2026 (V-7 e l'elenco delle change): `labelFor` c'era, ma venti chiamanti
      leggevano `byName.get(step).label` — la colonna «Fase» diceva «Scheduled»
      a chi aveva scelto l'italiano, accanto a un dettaglio che diceva
      «Pianificata». Tradurre qui chiude il difetto per tutti.
    */
    const raw         = (data?.workflowDefinition?.steps ?? []).map(withLocalizedLabel)
    // Sort by step.order so the timeline reflects the workflow flow rather
    // than whatever order the DB happened to return them in.
    const steps       = [...raw].sort((a, b) => a.order - b.order)
    const byName      = new Map(steps.map((s) => [s.name, s]))
    const terminalSet = new Set(steps.filter((s) => s.isTerminal).map((s) => s.name))
    const openSet     = new Set(steps.filter((s) => s.isOpen).map((s) => s.name))
    const initial     = steps.find((s) => s.isInitial)

    const isTerminal = (stepName: string | null | undefined) =>
      !!stepName && terminalSet.has(stepName)
    const isOpen = (stepName: string | null | undefined) =>
      !!stepName && openSet.has(stepName)
    const labelFor = (stepName: string | null | undefined) =>
      (stepName && byName.get(stepName) && localizedLabel(byName.get(stepName)!)) || stepName || ''
    const categoryOf = (stepName: string | null | undefined) =>
      (stepName && byName.get(stepName)?.category) || null
    /** Lo scopo di un passo, `null` se il passo non c'è o non lo dichiara. */
    const purposeOf = (stepName: string | null | undefined) =>
      (stepName && byName.get(stepName)?.purpose) || null
    /** True se il passo ha quello scopo: il modo giusto di dire «è l'approvazione». */
    const hasPurpose = (stepName: string | null | undefined, purpose: string) =>
      purposeOf(stepName) === purpose
    /** I passi con quello scopo, in ordine di flusso (un tenant può averne più di uno). */
    const stepsByPurpose = (purpose: string) => steps.filter((s) => s.purpose === purpose)

    /**
     * I passi RAGGIUNGIBILI da `from`, nell'ordine della definizione
     * (revisione totale · G-9): chi manda un articolo «in revisione»
     * scegliendo il primo passo non iniziale e non terminale scommetteva sulla
     * POSIZIONE — con un `rejected` inserito prima di `review` l'articolo
     * finiva rifiutato, o la transizione veniva rifiutata dal motore.
     */
    const transitions = data?.workflowDefinition?.transitions ?? []
    const reachableFrom = (from: string | null | undefined): WorkflowStepMeta[] => {
      if (!from) return []
      const targets = new Set(transitions.filter((tr) => tr.fromStepName === from).map((tr) => tr.toStepName))
      return steps.filter((st) => targets.has(st.name))
    }

    return {
      loading, error,
      steps,
      transitions,
      reachableFrom,
      byName,
      initialStep: initial ?? null,
      terminalSet,
      openSet,
      isTerminal,
      isOpen,
      labelFor,
      categoryOf,
      purposeOf,
      hasPurpose,
      stepsByPurpose,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` rifà le etichette quando cambia la lingua
  }, [data, loading, error, language])
}
