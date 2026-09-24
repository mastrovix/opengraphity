import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'

/**
 * Valida i metadati JSON dello step di arrivo (on_enter_fields, enter_actions)
 * prima di transizionare: se corrotti, la mutation fallisce SENZA aver
 * avanzato il workflow.
 */
export async function preflightStepMetadata(
  session: Session,
  instanceId: string,
  toStep: string,
  tenantId: string,
): Promise<void> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    // tenant-ok(traversal): step della definizione dell'istanza scopata
    MATCH (s:WorkflowStep {definition_id: wi.definition_id, name: $toStep})
    RETURN s.on_enter_fields AS fields, s.enter_actions AS enterActions
  `, { instanceId, toStep, tenantId }))
  if (!res.records.length) return // lo step non esiste: sarà l'engine a rifiutare la transizione
  const rec = res.records[0]
  for (const [key, label] of [['fields', 'on_enter_fields'], ['enterActions', 'enter_actions']] as const) {
    const raw = rec.get(key) as string | null
    if (!raw) continue
    try { JSON.parse(raw) } catch (e) {
      throw new GraphQLError(`Misconfigured workflow: ${label} of step "${toStep}" is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.stepActionsNotJson', params: { field: label, step: toStep, reason: e instanceof Error ? e.message : String(e) } } } })
    }
  }
}
