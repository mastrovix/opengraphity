import { GraphQLError } from 'graphql'
import { runQuery } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'

interface RequirementRule {
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

/**
 * Validates that all required fields for an entity have non-null, non-empty values.
 *
 * Loads FieldRequirementRule nodes from Neo4j. Rules with workflow_step = null apply
 * globally. Rules with a specific workflow_step apply only when toStep matches.
 *
 * Hidden fields (visibilityExclusions) are skipped even if marked required —
 * a hidden field cannot be required.
 *
 * Throws GraphQLError with code VALIDATION_ERROR if any required field is missing.
 */
export async function validateRequiredFields(
  session: Session,
  opts: {
    entityType:           string
    fieldValues:          Record<string, unknown>
    tenantId:             string
    toStep?:              string | null
    visibilityExclusions?: string[]   // field names currently hidden — skip them
  },
): Promise<void> {
  const { entityType, fieldValues, tenantId, toStep, visibilityExclusions = [] } = opts

  type Row = { r: { properties: Record<string, unknown> } }
  const rows = await runQuery<Row>(session, `
    MATCH (r:FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType})
    WHERE r.required = true
    RETURN r
  `, { tenantId, entityType })

  const rules: RequirementRule[] = rows.map((row) => {
    const p = row.r.properties
    return {
      fieldName:    p['field_name']     as string,
      required:     (p['required']      ?? false) as boolean,
      workflowStep: (p['workflow_step'] ?? null)  as string | null,
    }
  })

  const missing: string[] = []

  for (const rule of rules) {
    // Skip rules for other workflow steps
    if (rule.workflowStep !== null && rule.workflowStep !== toStep) continue
    // Skip hidden fields
    if (visibilityExclusions.includes(rule.fieldName)) continue

    const value = fieldValues[rule.fieldName]
    const isEmpty =
      value === null || value === undefined ||
      (typeof value === 'string' && value.trim() === '')

    if (isEmpty) missing.push(rule.fieldName)
  }

  if (missing.length > 0) {
    // Revisione del 14 set 2026 · IT-14: il messaggio era italiano per tutti.
    // Ora inglese per log e integrazioni, e una chiave per chi legge.
    const stepSuffix = toStep ? ` for step "${toStep}"` : ''
    const messages = missing.map((f) => `Field "${f}" is required${stepSuffix}`)
    throw new GraphQLError(messages.join('; '), {
      extensions: {
        code: 'VALIDATION_ERROR', fields: missing,
        i18n: toStep
          ? { key: 'errors.fields.requiredForStep', params: { fields: missing.join(', '), step: toStep } }
          : { key: 'errors.fields.required', params: { fields: missing.join(', ') } },
      },
    })
  }
}

/**
 * Proprietà persistite (snake_case) → valori campo per validateRequiredFields,
 * esposti sia in snake_case sia in camelCase, così le regole trovano il campo
 * qualunque convenzione usino. Da unire alla patch: la validazione si fa sullo
 * stato risultante, non sulla sola patch.
 */
export function propsToFieldValues(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    out[k] = v
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  }
  return out
}

/**
 * The requirement rules of the step being ENTERED, checked on the ticket as it
 * is stored plus the notes of the transition (they count as the resolution or
 * root cause). One place for every path that moves a ticket: the rules with a
 * `workflow_step` were checked by the generic transition and by the change's
 * (B-21), and skipped by the problem's and by resolveIncident — a rule «root
 * cause required entering Resolved» held for one button and not for the
 * problem page or the bulk resolve (review of 23 Sep 2026).
 */
export async function validateStepRequirements(
  session: Session,
  opts: { entityType: string; entityProps: Record<string, unknown>; notes?: string | null; tenantId: string; toStep: string },
): Promise<void> {
  const fieldValues = propsToFieldValues(opts.entityProps)
  if (opts.notes) {
    // In both conventions, like the stored fields.
    for (const f of ['resolution_notes', 'resolutionNotes', 'root_cause', 'rootCause']) fieldValues[f] = opts.notes
  }
  await validateRequiredFields(session, { entityType: opts.entityType, fieldValues, tenantId: opts.tenantId, toStep: opts.toStep })
}
