// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportNodeDef {
  id:             string
  entityType:     string
  neo4jLabel:     string
  label:          string
  isResult:       boolean
  isRoot:         boolean
  positionX:      number
  positionY:      number
  filters:        string | null
  selectedFields: string[]
}

export interface ReportEdgeDef {
  id:               string
  sourceNodeId:     string
  targetNodeId:     string
  relationshipType: string
  direction:        string
  label:            string
}

export interface ReportSectionDef {
  id:            string
  order:         number
  title:         string
  chartType:     string
  groupByNodeId: string | null
  groupByField:  string | null
  metric:        string
  metricField:   string | null
  limit:         number | null
  sortDir:       string | null
  nodes:         ReportNodeDef[]
  edges:         ReportEdgeDef[]
}

interface FilterClause {
  field:    string
  operator: string
  value:    unknown
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
}

function varName(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9]/g, '_')}`
}

function buildWhereClause(
  nodeVar: string,
  filtersJson: string | null,
  params: Record<string, unknown>,
  paramPrefix: string,
): string {
  if (!filtersJson) return ''
  let clauses: FilterClause[]
  try { clauses = JSON.parse(filtersJson) as FilterClause[] } catch { return '' }
  if (!clauses.length) return ''

  const parts: string[] = []
  clauses.forEach((f, i) => {
    const field    = toSnakeCase(f.field)
    const paramKey = `${paramPrefix}_f${i}`
    switch (f.operator) {
      case 'eq':
        params[paramKey] = f.value
        parts.push(`${nodeVar}.${field} = $${paramKey}`)
        break
      case 'neq':
        params[paramKey] = f.value
        parts.push(`${nodeVar}.${field} <> $${paramKey}`)
        break
      case 'contains':
        params[paramKey] = String(f.value)
        parts.push(`toLower(${nodeVar}.${field}) CONTAINS toLower($${paramKey})`)
        break
      case 'in':
        params[paramKey] = f.value
        parts.push(`${nodeVar}.${field} IN $${paramKey}`)
        break
      case 'last_n_days':
        params[paramKey] = Number(f.value)
        parts.push(`${nodeVar}.${field} > datetime() - duration({days: $${paramKey}})`)
        break
      case 'is_null':
        parts.push(`${nodeVar}.${field} IS NULL`)
        break
      case 'is_not_null':
        parts.push(`${nodeVar}.${field} IS NOT NULL`)
        break
    }
  })
  return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildReportQuery(
  section: ReportSectionDef,
  tenantId: string,
): { query: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { tenantId }
  const { nodes, edges, chartType, metric, groupByNodeId, groupByField, limit, sortDir } = section

  // 1. Find root node
  const rootNode = nodes.find(n => n.isRoot)
  if (!rootNode) throw new Error('No root node found in section')

  // 2. BFS to build match clauses in order
  const matchLines: string[] = []
  const visited = new Set<string>()
  const queue: string[] = [rootNode.id]

  // Root match
  const rootVar = varName(rootNode.id)
  matchLines.push(`MATCH (${rootVar}:${rootNode.neo4jLabel} {tenant_id: $tenantId})`)
  const rootWhere = buildWhereClause(rootVar, rootNode.filters, params, rootVar)
  if (rootWhere) matchLines.push(rootWhere)
  visited.add(rootNode.id)

  while (queue.length) {
    const currentId = queue.shift()!
    const outEdges = edges.filter(e => e.sourceNodeId === currentId && !visited.has(e.targetNodeId))
    const inEdges  = edges.filter(e => e.targetNodeId === currentId && !visited.has(e.sourceNodeId))

    for (const edge of outEdges) {
      const childNode = nodes.find(n => n.id === edge.targetNodeId)
      if (!childNode) continue
      const parentVar = varName(currentId)
      const childVar  = varName(childNode.id)
      if (edge.direction === 'outgoing') {
        matchLines.push(`MATCH (${parentVar})-[:${edge.relationshipType}]->(${childVar}:${childNode.neo4jLabel})`)
      } else {
        matchLines.push(`MATCH (${parentVar})<-[:${edge.relationshipType}]-(${childVar}:${childNode.neo4jLabel})`)
      }
      const childWhere = buildWhereClause(childVar, childNode.filters, params, childVar)
      if (childWhere) matchLines.push(childWhere)
      visited.add(childNode.id)
      queue.push(childNode.id)
    }

    for (const edge of inEdges) {
      const childNode = nodes.find(n => n.id === edge.sourceNodeId)
      if (!childNode) continue
      const parentVar = varName(currentId)
      const childVar  = varName(childNode.id)
      if (edge.direction === 'incoming') {
        matchLines.push(`MATCH (${parentVar})<-[:${edge.relationshipType}]-(${childVar}:${childNode.neo4jLabel})`)
      } else {
        matchLines.push(`MATCH (${parentVar})-[:${edge.relationshipType}]->(${childVar}:${childNode.neo4jLabel})`)
      }
      const childWhere = buildWhereClause(childVar, childNode.filters, params, childVar)
      if (childWhere) matchLines.push(childWhere)
      visited.add(childNode.id)
      queue.push(childNode.id)
    }
  }

  // 3. Determine group node
  const groupNode = groupByNodeId
    ? (nodes.find(n => n.id === groupByNodeId) ?? rootNode)
    : rootNode
  const groupVar   = varName(groupNode.id)
  const groupField = groupByField ? toSnakeCase(groupByField) : null

  // 4. Build RETURN clause
  const limitVal   = limit ?? 20
  const sortDirVal = (sortDir ?? 'DESC').toUpperCase()
  params['limit']  = limitVal

  let returnClause = ''

  if (chartType === 'kpi') {
    returnClause = `RETURN count(${rootVar}) AS value`

  } else if (['pie', 'donut', 'bar', 'bar_horizontal'].includes(chartType)) {
    const field = groupField ?? 'status'
    returnClause = [
      `RETURN ${groupVar}.${field} AS label, count(${rootVar}) AS value`,
      `ORDER BY value ${sortDirVal}`,
      `LIMIT toInteger($limit)`,
    ].join('\n')

  } else if (['line', 'area'].includes(chartType)) {
    const field = groupField ?? 'created_at'
    returnClause = [
      `RETURN date(${groupVar}.${field}) AS label, count(${rootVar}) AS value`,
      `ORDER BY label ASC`,
    ].join('\n')

  } else if (chartType === 'table') {
    const resultNodes = nodes.filter(n => n.isResult)
    const cols: string[] = []
    for (const rn of resultNodes) {
      const rv = varName(rn.id)
      for (const sf of (rn.selectedFields ?? [])) {
        const snakeSf = toSnakeCase(sf)
        const alias   = `${rn.label.replace(/\s+/g, '_')}_${sf}`
        cols.push(`${rv}.${snakeSf} AS ${alias}`)
      }
    }
    if (!cols.length) cols.push(`${rootVar}.id AS id`)
    returnClause = [
      `RETURN ${cols.join(', ')}`,
      `LIMIT toInteger($limit)`,
    ].join('\n')

  } else {
    returnClause = `RETURN count(${rootVar}) AS value`
  }

  const query = [...matchLines, returnClause].join('\n')
  return { query, params }
}
