import { useQuery } from '@apollo/client/react'
import { useMemo } from 'react'
import { GET_WORKFLOW_DEFINITION } from '@/graphql/queries/workflow'

export interface WorkflowStepMeta {
  id:         string
  name:       string
  label:      string
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
export function useWorkflowSteps(entityType: string) {
  const { data, loading, error } = useQuery<{ workflowDefinition: { steps: WorkflowStepMeta[] } | null }>(
    GET_WORKFLOW_DEFINITION,
    { variables: { entityType }, fetchPolicy: 'cache-first' },
  )

  return useMemo(() => {
    const raw         = data?.workflowDefinition?.steps ?? []
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
      (stepName && byName.get(stepName)?.label) || stepName || ''
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

    return {
      loading, error,
      steps,
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
  }, [data, loading, error])
}
