import { getSession } from '@opengraphity/neo4j'

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
  /** Il calendario con cui conta l'orario di servizio; null quando conta 24×7. */
  calendar_id:      string | null
  warning_minutes:  number
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
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (p:SLAPolicyNode {tenant_id: $tenantId, entity_type: $entityType, enabled: true})
        OPTIONAL MATCH (t:Tenant {id: $tenantId})
        // QUANTI criteri la policy fissa, non QUALI (revisione totale · E-1).
        // Prima il CASE elencava cinque combinazioni e tutto il resto cadeva in
        // un ramo di scarto, escluso dal WHERE: una policy «priorità + team» o «solo
        // team» — che la pagina SLA Policies e createSLAPolicy accettano — non
        // veniva MAI scelta, e il ticket riceveva la policy generica (o nessuno
        // SLA) senza un avviso. Ogni criterio dichiarato deve combaciare;
        // vince chi ne dichiara di più, e a pari numero l'ordine è
        // priorità → categoria → team (la priorità è il criterio più forte).
        WITH p, t.timezone AS tenantTimezone,
          (CASE WHEN p.priority IS NULL THEN 0 ELSE 1 END)
          + (CASE WHEN p.category IS NULL THEN 0 ELSE 1 END)
          + (CASE WHEN p.team_id  IS NULL THEN 0 ELSE 1 END) AS criteria,
          (CASE WHEN p.priority IS NULL THEN 0 ELSE 4 END)
          + (CASE WHEN p.category IS NULL THEN 0 ELSE 2 END)
          + (CASE WHEN p.team_id  IS NULL THEN 0 ELSE 1 END) AS weight
        WHERE (p.priority IS NULL OR p.priority = $priority)
          AND (p.category IS NULL OR p.category = $category)
          AND (p.team_id  IS NULL OR p.team_id  = $teamId)
        RETURN p, criteria, weight, tenantTimezone
        ORDER BY criteria DESC, weight DESC
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

    // Fail-loud on corrupt policy config: a policy without minutes would
    // produce a 0-minute SLA (deadline = now → instant breach) and a missing
    // timezone would silently shift every deadline.
    const responseMinutes = Number(props['response_minutes'])
    const resolveMinutes  = Number(props['resolve_minutes'])
    if (!Number.isFinite(responseMinutes) || responseMinutes <= 0) {
      throw new Error(`SLA policy "${String(props['name'])}" (${String(props['id'])}) has invalid response_minutes: ${String(props['response_minutes'])}`)
    }
    if (!Number.isFinite(resolveMinutes) || resolveMinutes <= 0) {
      throw new Error(`SLA policy "${String(props['name'])}" (${String(props['id'])}) has invalid resolve_minutes: ${String(props['resolve_minutes'])}`)
    }
    const warningMinutes = Number(props['warning_minutes'])
    if (!Number.isInteger(warningMinutes) || warningMinutes <= 0) {
      throw new Error(`SLA policy "${String(props['name'])}" (${String(props['id'])}) has invalid warning_minutes: ${String(props['warning_minutes'])}`)
    }
    /*
      Revisione del 14 set 2026 · F7: una policy senza fuso proprio segue il
      fuso del cliente, che si cambia dalla pagina Organizzazione. Prima la
      creazione ne copiava il valore, e cambiare il fuso del cliente non
      spostava nessuna policy.
    */
    const ownTimezone    = typeof props['timezone'] === 'string' && props['timezone'] !== '' ? props['timezone'] : null
    const tenantTimezone = result.records[0].get('tenantTimezone') as unknown
    const timezone = ownTimezone ?? (typeof tenantTimezone === 'string' && tenantTimezone !== '' ? tenantTimezone : null)
    if (!timezone) {
      throw new Error(`SLA policy "${String(props['name'])}" (${String(props['id'])}) has no time zone of its own and tenant ${tenantId} has no time zone configured`)
    }

    const policy: SLAPolicyRecord = {
      id:               props['id']               as string,
      name:             props['name']             as string,
      entity_type:      props['entity_type']      as string,
      priority:         (props['priority']         ?? null) as string | null,
      category:         (props['category']         ?? null) as string | null,
      team_id:          (props['team_id']          ?? null) as string | null,
      timezone,
      response_minutes: responseMinutes,
      resolve_minutes:  resolveMinutes,
      business_hours:   (props['business_hours']  ?? false) as boolean,
      calendar_id:      typeof props['calendar_id'] === 'string' && props['calendar_id'] !== '' ? props['calendar_id'] : null,
      warning_minutes:  warningMinutes,
    }

    // SLA policy selected
    return policy
  } finally {
    await session.close()
  }
}
