import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_FIELD_VISIBILITY_RULES } from '@/graphql/queries'

interface VisibilityRule {
  id:           string
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

/**
 * Returns a map of fieldName → visible (boolean) for the given entity type
 * and current form values. Evaluated reactively on every formValues change.
 *
 * Rules:
 *   action="show": target is HIDDEN by default; shown only when trigger matches.
 *   action="hide": target is VISIBLE by default; hidden when trigger matches.
 */
export function useFieldVisibility(
  entityType: string,
  formValues: Record<string, unknown>,
): Record<string, boolean> {
  const { data } = useQuery<{ fieldVisibilityRules: VisibilityRule[] }>(
    GET_FIELD_VISIBILITY_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-first' },
  )

  const rules = data?.fieldVisibilityRules ?? []

  return useMemo(() => {
    const visibility: Record<string, boolean> = {}

    // "show" rules default their target to hidden until condition is met
    for (const rule of rules) {
      if (rule.action === 'show') {
        visibility[rule.targetField] ??= false
      }
    }

    for (const rule of rules) {
      const triggerMatches =
        String(formValues[rule.triggerField] ?? '') === rule.triggerValue

      if (rule.action === 'show') {
        if (triggerMatches) visibility[rule.targetField] = true
      } else {
        // hide: visible by default, hidden when trigger matches
        if (!triggerMatches) {
          visibility[rule.targetField] ??= true
        } else {
          visibility[rule.targetField] = false
        }
      }
    }

    return visibility
  }, [rules, formValues])
}
