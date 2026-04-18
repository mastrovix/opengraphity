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
    }
  }, [data, loading, error])
}
