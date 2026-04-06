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
    const stepSuffix = toStep ? ` per lo step "${toStep}"` : ''
    const messages = missing.map((f) => `Il campo "${f}" è obbligatorio${stepSuffix}`)
    throw new GraphQLError(messages.join('; '), {
      extensions: { code: 'VALIDATION_ERROR', fields: missing },
    })
  }
}
