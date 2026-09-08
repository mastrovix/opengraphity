import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_FIELD_VISIBILITY_RULES, GET_FIELD_REQUIREMENT_RULES } from './fieldRules.graphql.js'

export interface FieldRules {
  visible:  boolean
  required: boolean
}

export interface VisibilityRule {
  id:           string
  entityType?:  string
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

export interface RequirementRule {
  id:           string
  entityType?:  string
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

// ── Pure evaluation (testable without React/Apollo) ─────────────────────────

/**
 * fieldName → visible for the given form values.
 *   action="show": target is HIDDEN by default; shown only when trigger matches.
 *   action="hide": target is VISIBLE by default; hidden when trigger matches.
 */
export function evalVisibility(rules: readonly VisibilityRule[], formValues: Record<string, unknown>): Record<string, boolean> {
  const visibility: Record<string, boolean> = {}
  for (const rule of rules) {
    if (rule.action === 'show') visibility[rule.targetField] ??= false
  }
  for (const rule of rules) {
    const matches = String(formValues[rule.triggerField] ?? '') === rule.triggerValue
    if (rule.action === 'show') {
      if (matches) visibility[rule.targetField] = true
    } else if (matches) {
      visibility[rule.targetField] = false
    } else {
      visibility[rule.targetField] ??= true
    }
  }
  return visibility
}

/** fieldName → required. Rules with `workflowStep = null` apply to every step (the API already filters by step). */
export function evalRequirements(rules: readonly RequirementRule[]): Record<string, boolean> {
  const required: Record<string, boolean> = {}
  for (const rule of rules) {
    if (rule.required) required[rule.fieldName] = true
  }
  return required
}

/** A hidden field is never required (visibility takes precedence). Fields not mentioned default to visible/not required. */
export function mergeFieldRules(visibility: Record<string, boolean>, requirements: Record<string, boolean>): Record<string, FieldRules> {
  const result: Record<string, FieldRules> = {}
  const all = new Set([...Object.keys(visibility), ...Object.keys(requirements)])
  for (const field of all) {
    const visible  = visibility[field]   ?? true
    const required = requirements[field] ?? false
    result[field] = { visible, required: visible ? required : false }
  }
  return result
}

/**
 * Validates that all required (and visible) fields in the form have values.
 * Returns the names of the fields that are missing a value.
 */
export function validateFormFields(
  fieldRules: Record<string, FieldRules>,
  formValues: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  for (const [field, rules] of Object.entries(fieldRules)) {
    if (!rules.visible || !rules.required) continue
    const value = formValues[field]
    if (value === null || value === undefined || String(value).trim() === '') missing.push(field)
  }
  return missing
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export function useFieldVisibility(
  entityType: string,
  formValues: Record<string, unknown>,
): { visibility: Record<string, boolean>; error: Error | null } {
  const { data, error } = useQuery<{ fieldVisibilityRules: VisibilityRule[] }>(
    GET_FIELD_VISIBILITY_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-first' },
  )
  const rules      = useMemo(() => data?.fieldVisibilityRules ?? [], [data])
  const visibility = useMemo(() => evalVisibility(rules, formValues), [rules, formValues])
  return { visibility, error: error ?? null }
}

export function useFieldRequirements(
  entityType: string,
  workflowStep?: string | null,
): { requirements: Record<string, boolean>; error: Error | null } {
  const { data, error } = useQuery<{ fieldRequirementRules: RequirementRule[] }>(
    GET_FIELD_REQUIREMENT_RULES,
    { variables: { entityType, workflowStep: workflowStep ?? null }, fetchPolicy: 'cache-first' },
  )
  const rules        = useMemo(() => data?.fieldRequirementRules ?? [], [data])
  const requirements = useMemo(() => evalRequirements(rules), [rules])
  return { requirements, error: error ?? null }
}

/**
 * Combined hook: merges visibility and requirement rules.
 * Returns `{ rules: Record<fieldName, { visible, required }>, error }`.
 */
export function useFormFieldRules(
  entityType:   string,
  workflowStep: string | null | undefined,
  formValues:   Record<string, unknown>,
): { rules: Record<string, FieldRules>; error: Error | null } {
  const { visibility, error: visibilityError }     = useFieldVisibility(entityType, formValues)
  const { requirements, error: requirementsError } = useFieldRequirements(entityType, workflowStep)
  const rules = useMemo(() => mergeFieldRules(visibility, requirements), [visibility, requirements])
  return { rules, error: visibilityError ?? requirementsError ?? null }
}
