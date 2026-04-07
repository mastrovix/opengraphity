import type { Session } from 'neo4j-driver'
import pino from 'pino'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow:selector' })

export interface SelectedWorkflow {
  definitionId: string
  name:         string
  category:     string | null
}

/**
 * Selects the best WorkflowDefinition for an entity based on entity_type and category.
 *
 * Resolution order:
 *   1. Active definition matching entity_type + category (most specific)
 *   2. Active definition matching entity_type + category IS NULL (default)
 *   3. null (no workflow found)
 */
export async function selectWorkflowForEntity(
  session: Session,
  tenantId:   string,
  entityType: string,
  category:   string | null,
): Promise<SelectedWorkflow | null> {
  const result = await session.executeRead(tx =>
    tx.run(`
      MATCH (wd:WorkflowDefinition {
        tenant_id:   $tenantId,
        entity_type: $entityType,
        active:      true
      })
      WITH wd,
        CASE
          WHEN wd.category IS NOT NULL AND wd.category = $category THEN 0
          WHEN wd.category IS NULL THEN 1
          ELSE 2
        END AS priority
      WHERE priority < 2
      RETURN wd.id AS id, wd.name AS name, wd.category AS category, priority
      ORDER BY priority ASC
      LIMIT 1
    `, { tenantId, entityType, category: category ?? null }),
  )

  if (result.records.length === 0) {
    log.warn({ tenantId, entityType, category }, 'No matching workflow definition found')
    return null
  }

  const rec = result.records[0]
  const selected: SelectedWorkflow = {
    definitionId: rec.get('id')       as string,
    name:         rec.get('name')     as string,
    category:     rec.get('category') as string | null,
  }

  log.info({ tenantId, entityType, category, selected: selected.name }, 'Workflow selected')
  return selected
}
