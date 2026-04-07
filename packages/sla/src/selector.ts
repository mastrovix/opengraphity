import { getDriver } from '@opengraphity/neo4j'

export interface SLAPolicyRecord {
  id:               string
  name:             string
  entity_type:      string
  priority:         string | null
  category:         string | null
  team_id:          string | null
  timezone:         string
  response_minutes: number
  resolve_minutes:  number
  business_hours:   boolean
}

/**
 * Selects the most specific SLA policy for an entity.
 *
 * Resolution order (most → least specific):
 *   1. entity_type + priority + category + team
 *   2. entity_type + priority + category
 *   3. entity_type + priority
 *   4. entity_type + category
 *   5. entity_type only (default)
 *
 * Returns null if no policy found.
 */
export async function selectSLAForEntity(
  tenantId:   string,
  entityType: string,
  priority:   string | null,
  category:   string | null,
  teamId:     string | null,
): Promise<SLAPolicyRecord | null> {
  const session = getDriver().session({ defaultAccessMode: 'READ' as const })
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (p:SLAPolicyNode {tenant_id: $tenantId, entity_type: $entityType, enabled: true})
        WITH p,
          CASE
            WHEN p.priority = $priority AND p.category = $category AND p.team_id = $teamId THEN 0
            WHEN p.priority = $priority AND p.category = $category AND p.team_id IS NULL    THEN 1
            WHEN p.priority = $priority AND p.category IS NULL     AND p.team_id IS NULL    THEN 2
            WHEN p.priority IS NULL     AND p.category = $category AND p.team_id IS NULL    THEN 3
            WHEN p.priority IS NULL     AND p.category IS NULL     AND p.team_id IS NULL    THEN 4
            ELSE 99
          END AS specificity
        WHERE specificity < 99
        RETURN p, specificity
        ORDER BY specificity ASC
        LIMIT 1
      `, {
        tenantId,
        entityType,
        priority: priority ?? null,
        category: category ?? null,
        teamId:   teamId   ?? null,
      }),
    )

    if (result.records.length === 0) {
      // No SLA policy found
      return null
    }

    const props = result.records[0].get('p').properties as Record<string, unknown>
    const policy: SLAPolicyRecord = {
      id:               props['id']               as string,
      name:             props['name']             as string,
      entity_type:      props['entity_type']      as string,
      priority:         (props['priority']         ?? null) as string | null,
      category:         (props['category']         ?? null) as string | null,
      team_id:          (props['team_id']          ?? null) as string | null,
      timezone:         (props['timezone']         ?? 'Europe/Rome') as string,
      response_minutes: Number(props['response_minutes'] ?? 0),
      resolve_minutes:  Number(props['resolve_minutes']  ?? 0),
      business_hours:   (props['business_hours']  ?? false) as boolean,
    }

    // SLA policy selected
    return policy
  } finally {
    await session.close()
  }
}
