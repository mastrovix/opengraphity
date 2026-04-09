import type { Session } from 'neo4j-driver'
import pino from 'pino'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow:selector' })

export interface SelectedWorkflow {
  definitionId: string
  name:         string
  category:     string | null
}

/**
 * Selects the best WorkflowDefinition for an entity based on entity_type, category,
 * and (for changes) change_subtype.
 *
 * For entityType='change' with a changeSubtype:
 *   1. (entity_type='change', change_subtype=subtype, category=category) ORDER BY version DESC
 *   2. (entity_type='change', change_subtype=subtype, category IS NULL) ORDER BY version DESC
 *   3. Fallback to generic logic (no subtype filter)
 *
 * For all other entities (or changes without subtype):
 *   1. Active definition matching entity_type + category (most specific)
 *   2. Active definition matching entity_type + category IS NULL (default)
 *   3. null (no workflow found)
 */
export async function selectWorkflowForEntity(
  session: Session,
  tenantId:       string,
  entityType:     string,
  category:       string | null,
  changeSubtype?: string | null,
): Promise<SelectedWorkflow | null> {

  // ── Change-specific: try matching by change_subtype first ──────────────
  if (entityType === 'change' && changeSubtype) {
    // Try 1: subtype + category
    const r1 = await session.executeRead(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {
          tenant_id:      $tenantId,
          entity_type:    'change',
          change_subtype: $changeSubtype,
          active:         true
        })
        WHERE wd.category IS NOT NULL AND wd.category = $category
        RETURN wd.id AS id, wd.name AS name, wd.category AS category
        ORDER BY wd.version DESC
        LIMIT 1
      `, { tenantId, changeSubtype, category: category ?? null }),
    )
    if (r1.records.length > 0) {
      const rec = r1.records[0]
      const selected: SelectedWorkflow = {
        definitionId: rec.get('id')       as string,
        name:         rec.get('name')     as string,
        category:     rec.get('category') as string | null,
      }
      log.info({ tenantId, entityType, changeSubtype, category, selected: selected.name }, 'Workflow selected (subtype+category)')
      return selected
    }

    // Try 2: subtype + category IS NULL
    const r2 = await session.executeRead(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {
          tenant_id:      $tenantId,
          entity_type:    'change',
          change_subtype: $changeSubtype,
          active:         true
        })
        WHERE wd.category IS NULL
        RETURN wd.id AS id, wd.name AS name, wd.category AS category
        ORDER BY wd.version DESC
        LIMIT 1
      `, { tenantId, changeSubtype }),
    )
    if (r2.records.length > 0) {
      const rec = r2.records[0]
      const selected: SelectedWorkflow = {
        definitionId: rec.get('id')       as string,
        name:         rec.get('name')     as string,
        category:     rec.get('category') as string | null,
      }
      log.info({ tenantId, entityType, changeSubtype, selected: selected.name }, 'Workflow selected (subtype, no category)')
      return selected
    }

    // Try 3: fall through to generic logic below
    log.debug({ tenantId, entityType, changeSubtype, category }, 'No subtype-specific workflow found, falling back to generic logic')
  }

  // ── Generic logic (all entity types) ───────────────────────────────────
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
      ORDER BY priority ASC, wd.version DESC
      LIMIT 1
    `, { tenantId, entityType, category: category ?? null }),
  )

  if (result.records.length === 0) {
    log.warn({ tenantId, entityType, category, changeSubtype }, 'No matching workflow definition found')
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
