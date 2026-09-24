/**
 * The tenant's field rules on a ticket creation form: which fields show, which
 * are required, and the marks and messages that say so.
 *
 * Review of 23 Sep 2026: only the incident form applied them, while the server
 * enforces them on every creation — a required category on a problem was
 * found out only from the server's error, and visibility rules had no effect.
 * The problem and request forms share this, so they cannot drift apart.
 */
import type { ReactNode } from 'react'
import { useFormFieldRules, validateFormFields, type FieldRules } from './useFormFieldRules'

export interface CreationFieldRules {
  rules: Record<string, FieldRules>
  error: Error | null
  /** False when a rule hides the field. */
  shown: (field: string) => boolean
  /** « *» after the label of a field a rule makes required. */
  requiredMark: (field: string) => ReactNode
  /** The field's message under it, from `errors`. */
  errorOf: (field: string) => ReactNode
  /** The required fields still empty, by name. */
  missing: () => string[]
}

export function useCreationFieldRules(
  entityType: string, values: Record<string, unknown>, errors: Record<string, string>,
): CreationFieldRules {
  const { rules, error } = useFormFieldRules(entityType, null, values)
  return {
    rules,
    error,
    shown: (field) => rules[field]?.visible !== false,
    requiredMark: (field) => (rules[field]?.required
      ? <span style={{ color: 'var(--color-trigger-sla-breach)' }}> *</span> : null),
    errorOf: (field) => (errors[field]
      ? <p role="alert" style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{errors[field]}</p> : null),
    missing: () => validateFormFields(rules, values),
  }
}
