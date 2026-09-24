/**
 * THE FIELDS A STEP WRITES WHEN ENTERED (`on_enter_fields`), for every path
 * (wave 7 · B1): they lived in the manual transition and were applied to
 * incidents and articles moved by hand only. The pipeline of the transitions
 * (services/ticketTransition.ts) applies them to every ticket, on every path.
 */
import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { ENTITY_LABELS } from '@opengraphity/workflow'

/**
 * Apply the `on_enter_fields` metadata of the newly-entered step to the
 * underlying entity. Value tokens:
 *   '$now'    → current ISO timestamp
 *   '$userId' → current user id
 *   '$notes'  → transition notes (can be null)
 * Any other string is taken verbatim.
 *
 * The entity label is resolved from the WorkflowInstance.entity_type.
 */
export async function applyOnEnterFields(
  session: Session,
  instanceId: string,
  stepName: string,
  userId: string,
  notes?: string,
  expectedTenantId?: string,
): Promise<void> {
  const fieldsRow = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName AND ($tenantId IS NULL OR wi.tenant_id = $tenantId)
    RETURN step.on_enter_fields AS fields,
           wi.entity_id   AS entityId,
           wi.tenant_id   AS tenantId,
           wi.entity_type AS entityType
  `, { instanceId, stepName, tenantId: expectedTenantId ?? null }))
  if (!fieldsRow.records.length) return
  const rec       = fieldsRow.records[0]
  const raw       = rec.get('fields')     as string | null
  if (!raw) return
  const entityId   = rec.get('entityId')   as string
  const tenantId   = rec.get('tenantId')   as string
  const entityType = rec.get('entityType') as string
  const label      = ENTITY_LABELS[entityType]
  // B-28: niente fallback silenzioso. Se il passo dichiara campi da scrivere e
  // non sappiamo su quale nodo scriverli, la transizione non è riuscita.
  if (!label) {
    throw new GraphQLError(`Step "${stepName}" writes fields on enter, but entity type "${entityType}" is not writable`, {
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.workflow.onEnterFieldsEntity', params: { step: stepName, entityType } } },
    })
  }

  let parsed: Record<string, string>
  try { parsed = JSON.parse(raw) as Record<string, string> }
  catch (e) {
    // Corrupt on_enter_fields must fail the transition, not silently skip the
    // step's side effects while reporting success.
    throw new GraphQLError(`Corrupt on_enter_fields JSON on step "${stepName}": ${e instanceof Error ? e.message : String(e)}`)
  }
  const keys = Object.keys(parsed)
  if (keys.length === 0) return

  const nowIso = new Date().toISOString()
  const resolveValue = (v: string) => {
    if (v === '$now')    return nowIso
    if (v === '$userId') return userId
    if (v === '$notes')  return notes ?? null
    return v
  }
  const setClauses = keys.map((k) => `e.\`${k}\` = $__val_${k}`)
  const params: Record<string, unknown> = { entityId, tenantId, now: nowIso }
  for (const [k, v] of Object.entries(parsed)) params[`__val_${k}`] = resolveValue(v)
  await session.executeWrite((tx) => tx.run(
    `MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
     SET ${setClauses.join(', ')}, e.updated_at = $now`,
    params,
  ))
}
