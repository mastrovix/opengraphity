// Shared advanced-filter WHERE builder — used by all list resolvers

export interface AdvFilterRule {
  field:    string
  operator: string
  value:    string | string[] | null
  value2?:  string
  logic:    'AND' | 'OR'
}

export interface AdvFilterGroup {
  rules: AdvFilterRule[]
}

export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

/** Defines how a relation-based field should be queried (EXISTS subquery) */
export interface RelationFieldDef {
  relType:     string   // Neo4j relationship type, e.g. 'ASSIGNED_TO_TEAM'
  targetLabel: string   // Neo4j label of the target node, e.g. 'Team'
  searchProp:  string   // Property to match on, e.g. 'name'
}

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * Builds a Cypher WHERE fragment from a JSON-encoded FilterGroup.
 *
 * @param filtersJson   - JSON string of { rules: AdvFilterRule[] }
 * @param params        - Mutated in-place: query parameters are added here
 * @param allowedFields - Field whitelist; rules with unknown fields are skipped
 * @param nodeAlias     - The Cypher node variable name (default 'n')
 * @param relationFields - Optional relation-based fields (e.g. ownerGroup, assignedTeam)
 */
export function buildAdvancedWhere(
  filtersJson: string,
  params: Record<string, unknown>,
  allowedFields: Set<string>,
  nodeAlias = 'n',
  relationFields: Record<string, RelationFieldDef> = {},
): string {
  let group: AdvFilterGroup
  try { group = JSON.parse(filtersJson) as AdvFilterGroup }
  catch { return '' }
  if (!group.rules?.length) return ''

  const conditions: string[] = []

  for (let i = 0; i < group.rules.length; i++) {
    const rule = group.rules[i]
    const pk   = `af_${i}`
    const pk2  = `af_${i}_2`

    if (!FIELD_NAME_RE.test(rule.field)) continue
    if (!allowedFields.has(rule.field)) continue

    // Relation field: generate EXISTS subquery
    const relDef = relationFields[rule.field]
    if (relDef) {
      const ta = `_af_t${i}`
      if (rule.operator === 'is_empty') {
        conditions.push(`NOT EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}]->(:${relDef.targetLabel}) }`)
      } else if (rule.operator === 'is_not_empty') {
        conditions.push(`EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}]->(:${relDef.targetLabel}) }`)
      } else if ((rule.operator === 'equals' || rule.operator === 'contains') && rule.value) {
        params[pk] = rule.operator === 'contains'
          ? (rule.value as string).toLowerCase()
          : rule.value
        const cond = rule.operator === 'contains'
          ? `toLower(${ta}.${relDef.searchProp}) CONTAINS $${pk}`
          : `${ta}.${relDef.searchProp} = $${pk}`
        conditions.push(`EXISTS { MATCH (${nodeAlias})-[:${relDef.relType}]->(${ta}:${relDef.targetLabel}) WHERE ${cond} }`)
      }
      continue
    }

    const prop = `${nodeAlias}.${toSnakeCase(rule.field)}`

    switch (rule.operator) {
      case 'contains':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) CONTAINS toLower($${pk})`)
        break
      case 'starts_with':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) STARTS WITH toLower($${pk})`)
        break
      case 'ends_with':
        params[pk] = rule.value
        conditions.push(`toLower(${prop}) ENDS WITH toLower($${pk})`)
        break
      case 'equals':
        params[pk] = rule.value
        conditions.push(`${prop} = $${pk}`)
        break
      case 'not_equals':
        params[pk] = rule.value
        conditions.push(`${prop} <> $${pk}`)
        break
      case 'is_empty':
        conditions.push(`(${prop} IS NULL OR ${prop} = '')`)
        break
      case 'is_not_empty':
        conditions.push(`(${prop} IS NOT NULL AND ${prop} <> '')`)
        break
      case 'after':
        params[pk] = rule.value
        conditions.push(`datetime(${prop}) > datetime($${pk})`)
        break
      case 'before':
        params[pk] = rule.value
        conditions.push(`datetime(${prop}) < datetime($${pk})`)
        break
      case 'between':
        params[pk]  = rule.value
        params[pk2] = rule.value2
        conditions.push(`datetime(${prop}) >= datetime($${pk}) AND datetime(${prop}) <= datetime($${pk2})`)
        break
      case 'today':
        conditions.push(`date(${prop}) = date()`)
        break
      case 'last_7_days':
        conditions.push(`datetime(${prop}) > datetime() - duration('P7D')`)
        break
      case 'last_30_days':
        conditions.push(`datetime(${prop}) > datetime() - duration('P30D')`)
        break
      case 'in':
        params[pk] = rule.value
        conditions.push(`${prop} IN $${pk}`)
        break
      case 'not_in':
        params[pk] = rule.value
        conditions.push(`NOT ${prop} IN $${pk}`)
        break
    }
  }

  if (!conditions.length) return ''

  // Group OR chains in parens; AND separates groups.
  // rule[i].logic describes the connector between rule[i] and rule[i+1].
  //   OR  → continue into the same group
  //   AND → close current group, start a new one
  const orGroups: string[][] = []
  let current: string[] = []

  for (let i = 0; i < conditions.length; i++) {
    current.push(conditions[i])
    const isLast    = i === conditions.length - 1
    const connector = group.rules[i]?.logic ?? 'AND'
    if (isLast || connector === 'AND') {
      orGroups.push(current)
      current = []
    }
  }

  return orGroups
    .map((g) => g.length === 1 ? g[0] : `(${g.join(' OR ')})`)
    .join(' AND ')
}
