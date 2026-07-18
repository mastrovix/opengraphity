import { useMemo } from 'react'
import { useFieldVisibility } from './useFieldVisibility.js'
import { useFieldRequirements } from './useFieldRequirements.js'

export interface FieldRules {
  visible:  boolean
  required: boolean
}

/**
 * Combined hook: merges visibility and requirement rules.
 *
 * A hidden field is never required (visibility takes precedence).
 *
 * Returns: { rules: Record<fieldName, { visible, required }>, error }
 * Fields not mentioned by any rule default to { visible: true, required: false }.
 */
export function useFormFieldRules(
  entityType:   string,
  workflowStep: string | null | undefined,
  formValues:   Record<string, unknown>,
): { rules: Record<string, FieldRules>; error: Error | null } {
  const { visibility, error: visibilityError }     = useFieldVisibility(entityType, formValues)
  const { requirements, error: requirementsError } = useFieldRequirements(entityType, workflowStep)

  const rules = useMemo(() => {
    const result: Record<string, FieldRules> = {}
    const allFields = new Set([...Object.keys(visibility), ...Object.keys(requirements)])

    for (const field of allFields) {
      const visible  = visibility[field]  ?? true
      const required = requirements[field] ?? false
      result[field] = { visible, required: visible ? required : false }
    }

    return result
  }, [visibility, requirements])

  return { rules, error: visibilityError ?? requirementsError ?? null }
}

/**
 * Validates that all required (and visible) fields in the form have values.
 * Returns an array of field names that are missing values.
 */
export function validateFormFields(
  fieldRules: Record<string, FieldRules>,
  formValues: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  for (const [field, rules] of Object.entries(fieldRules)) {
    if (!rules.visible || !rules.required) continue
    const value = formValues[field]
    if (value === null || value === undefined || String(value).trim() === '') {
      missing.push(field)
    }
  }
  return missing
}
