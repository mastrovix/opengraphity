export type Props = Record<string, unknown>

// Neo4j DateTime/Date objects come back as structured objects instead of strings.
// This helper normalises them to ISO 8601 strings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function neo4jDateToISO(val: any): string | null {
  if (!val) return null
  if (typeof val === 'string') return val
  if (typeof val.toStandardDate === 'function') return val.toStandardDate().toISOString()
  if (val.year !== undefined) {
    const y   = typeof val.year   === 'object' ? val.year.low   : val.year
    const m   = typeof val.month  === 'object' ? val.month.low  : val.month
    const d   = typeof val.day    === 'object' ? val.day.low    : val.day
    const h   = typeof val.hour   === 'object' ? val.hour.low   : (val.hour   ?? 0)
    const min = typeof val.minute === 'object' ? val.minute.low : (val.minute ?? 0)
    const s   = typeof val.second === 'object' ? val.second.low : (val.second ?? 0)
    return new Date(y, m - 1, d, h, min, s).toISOString()
  }
  return String(val)
}

export function mapUser(props: Props) {
  return {
    id:        props['id']        as string,
    tenantId:  props['tenant_id'] as string,
    email:     props['email']     as string,
    name:      props['name']      as string,
    role:      props['role']      as string,
    active:    (props['active']   ?? true) as boolean,
    createdAt: neo4jDateToISO(props['created_at']),
  }
}

export function mapIncident(props: Props) {
  return {
    id:           props['id']          as string,
    tenantId:     props['tenant_id']   as string,
    title:        props['title']       as string,
    description:  props['description'] as string | undefined,
    severity:     props['severity']    as string,
    category:     (props['category']   ?? null) as string | null,
    status:       props['status']      as string,
    createdAt:    props['created_at']  as string,
    updatedAt:    props['updated_at']  as string,
    resolvedAt:   props['resolved_at'] as string | undefined,
    rootCause:    (props['root_cause'] ?? null) as string | null,
    assignee:        null,
    assignedTeam:    null,
    affectedCIs:     [],
    causedByProblem: null,
    comments:        [],
  }
}

export function mapTeam(props: Props) {
  return {
    id:          props['id']         as string,
    tenantId:    props['tenant_id']  as string,
    name:        props['name']       as string,
    description: (props['description'] ?? null) as string | null,
    type:        (props['type']        ?? null) as string | null,
    createdAt:   neo4jDateToISO(props['created_at']),
  }
}
