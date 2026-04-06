import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_FIELD_REQUIREMENT_RULES } from '@/graphql/queries'

interface RequirementRule {
  id:           string
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

/**
 * Returns a map of fieldName → required (boolean) for the given entity type
 * and optional workflow step. Rules with workflowStep=null apply to all steps.
 */
export function useFieldRequirements(
  entityType: string,
  workflowStep?: string | null,
): Record<string, boolean> {
  const { data } = useQuery<{ fieldRequirementRules: RequirementRule[] }>(
    GET_FIELD_REQUIREMENT_RULES,
    {
      variables:   { entityType, workflowStep: workflowStep ?? null },
      fetchPolicy: 'cache-first',
    },
  )

  const rules = data?.fieldRequirementRules ?? []

  return useMemo(() => {
    const required: Record<string, boolean> = {}
    for (const rule of rules) {
      if (rule.required) required[rule.fieldName] = true
    }
    return required
  }, [rules])
}
