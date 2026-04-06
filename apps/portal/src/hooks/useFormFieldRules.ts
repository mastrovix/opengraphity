import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_FIELD_VISIBILITY_RULES, GET_FIELD_REQUIREMENT_RULES } from '@/graphql/queries'

export interface FieldRules {
  visible:  boolean
  required: boolean
}

interface VisibilityRule {
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

interface RequirementRule {
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

function evalVisibility(rules: VisibilityRule[], formValues: Record<string, unknown>): Record<string, boolean> {
  const vis: Record<string, boolean> = {}
  for (const r of rules) {
    if (r.action === 'show') vis[r.targetField] ??= false
  }
  for (const r of rules) {
    const matches = String(formValues[r.triggerField] ?? '') === r.triggerValue
    if (r.action === 'show') {
      if (matches) vis[r.targetField] = true
    } else {
      vis[r.targetField] = !matches ? (vis[r.targetField] ?? true) : false
    }
  }
  return vis
}

export function useFormFieldRules(
  entityType:   string,
  workflowStep: string | null | undefined,
  formValues:   Record<string, unknown>,
): Record<string, FieldRules> {
  const { data: visData } = useQuery<{ fieldVisibilityRules: VisibilityRule[] }>(
    GET_FIELD_VISIBILITY_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-first' },
  )
  const { data: reqData } = useQuery<{ fieldRequirementRules: RequirementRule[] }>(
    GET_FIELD_REQUIREMENT_RULES,
    { variables: { entityType, workflowStep: workflowStep ?? null }, fetchPolicy: 'cache-first' },
  )

  const visRules = visData?.fieldVisibilityRules ?? []
  const reqRules = reqData?.fieldRequirementRules ?? []

  return useMemo(() => {
    const visibility = evalVisibility(visRules, formValues)
    const required: Record<string, boolean> = {}
    for (const r of reqRules) {
      if (r.required) required[r.fieldName] = true
    }

    const result: Record<string, FieldRules> = {}
    const all = new Set([...Object.keys(visibility), ...Object.keys(required)])
    for (const f of all) {
      const vis = visibility[f] ?? true
      result[f] = { visible: vis, required: vis ? (required[f] ?? false) : false }
    }
    return result
  }, [visRules, reqRules, formValues])
}

export function validateFormFields(
  fieldRules: Record<string, FieldRules>,
  formValues: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  for (const [field, rules] of Object.entries(fieldRules)) {
    if (!rules.visible || !rules.required) continue
    const v = formValues[field]
    if (v === null || v === undefined || String(v).trim() === '') missing.push(field)
  }
  return missing
}
