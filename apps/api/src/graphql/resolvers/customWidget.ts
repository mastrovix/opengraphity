import { v4 as uuidv4 } from 'uuid'
import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import { audit } from '../../lib/audit.js'
import type { GraphQLContext } from '../../context.js'

// ── Whitelists (injection-safe) ───────────────────────────────────────────────

const ENTITY_LABEL_MAP: Record<string, string> = {
  incident:        'Incident',
  problem:         'Problem',
  change:          'Change',
  service_request: 'ServiceRequest',
  server:          'Server',
  application:     'Application',
  database:        'Database',
  certificate:     'Certificate',
  network_device:  'NetworkDevice',
  vm:              'VirtualMachine',
}

// Fields allowed for groupBy / filter (per entity type)
const ALLOWED_FIELDS: Record<string, string[]> = {
  incident:        ['status', 'severity', 'priority', 'category', 'environment'],
  problem:         ['status', 'priority', 'category'],
  change:          ['status', 'type', 'priority', 'environment'],
  service_request: ['status', 'priority', 'category'],
  server:          ['status', 'environment', 'os', 'type'],
  application:     ['status', 'environment', 'category', 'type'],
  database:        ['status', 'environment', 'type'],
  certificate:     ['status', 'environment'],
  network_device:  ['status', 'environment', 'type'],
  vm:              ['status', 'environment'],
}

const ALLOWED_METRICS = ['count', 'count_by_field', 'avg_field', 'sum_field']

// Time range → ISO duration filter (relative to created_at)
const TIME_RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '7d':  24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
  '1y':  24 * 365,
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

function mapWidget(p: Props) {
  return {
    id:           p['id']            as string,
    title:        p['title']         as string,
    widgetType:   p['widget_type']   as string,
    entityType:   p['entity_type']   as string,
    metric:       p['metric']        as string,
    groupByField: (p['group_by_field'] ?? null) as string | null,
    filterField:  (p['filter_field']   ?? null) as string | null,
    filterValue:  (p['filter_value']   ?? null) as string | null,
    timeRange:    (p['time_range']     ?? null) as string | null,
    size:         (p['size']           ?? 'medium') as string,
    color:        (p['color']          ?? '#0EA5E9') as string,
    position:     Math.round(Number(p['position'] ?? 0)),
    dashboardId:  p['dashboard_id']  as string,
  }
}

// ── Query: customWidgets ──────────────────────────────────────────────────────

async function customWidgets(
  _: unknown,
  args: { dashboardId: string },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
         RETURN properties(w) AS w ORDER BY w.position ASC`,
        { dashId: args.dashboardId, tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapWidget(r.get('w') as Props))
  } finally {
    await session.close()
  }
}

// ── Shared: build + execute widget data query ─────────────────────────────────

interface WidgetConfig {
  entityType:   string
  metric:       string
  groupByField: string | null
  filterField:  string | null
  filterValue:  string | null
  timeRange:    string | null
  title?:       string
}

async function executeWidgetQuery(cfg: WidgetConfig, tenantId: string) {
  const neo4jLabel = ENTITY_LABEL_MAP[cfg.entityType]
  if (!neo4jLabel) throw new GraphQLError(`Tipo entità non supportato: ${cfg.entityType}`)
  if (!ALLOWED_METRICS.includes(cfg.metric)) throw new GraphQLError(`Metrica non supportata: ${cfg.metric}`)

  const allowedFields = ALLOWED_FIELDS[cfg.entityType] ?? []
  if (cfg.groupByField && !allowedFields.includes(cfg.groupByField)) {
    throw new GraphQLError(`Campo group_by non consentito: ${cfg.groupByField}`)
  }
  if (cfg.filterField && !allowedFields.includes(cfg.filterField)) {
    throw new GraphQLError(`Campo filtro non consentito: ${cfg.filterField}`)
  }

  const whereClause: string[] = ['n.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId }

  if (cfg.timeRange && cfg.timeRange !== 'all' && TIME_RANGE_HOURS[cfg.timeRange]) {
    const hoursAgo = TIME_RANGE_HOURS[cfg.timeRange]
    const since = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
    whereClause.push('n.created_at >= $since')
    params['since'] = since
  }

  if (cfg.filterField && cfg.filterValue != null) {
    whereClause.push(`n.${cfg.filterField} = $filterValue`)
    params['filterValue'] = cfg.filterValue
  }

  const whereStr = `WHERE ${whereClause.join(' AND ')}`

  const session = getSession(undefined, 'READ')
  try {
    let cypher: string
    let resultData: { value?: number; label?: string; series?: { label: string; value: number }[] }

    if (cfg.metric === 'count') {
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN count(n) AS value`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      resultData = { value: Number(res.records[0]?.get('value') ?? 0), label: cfg.title ?? '', series: [] }

    } else if (cfg.metric === 'count_by_field') {
      const field = cfg.groupByField ?? 'status'
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN n.${field} AS label, count(n) AS value ORDER BY value DESC LIMIT 20`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      const series = res.records.map((r) => ({
        label: (r.get('label') as string | null) ?? 'N/A',
        value: Number(r.get('value') ?? 0),
      }))
      resultData = { value: series.reduce((a, s) => a + s.value, 0), label: cfg.title ?? '', series }

    } else if (cfg.metric === 'avg_field') {
      const field = cfg.groupByField ?? 'affected_users'
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN avg(n.${field}) AS value`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      const val = Number(res.records[0]?.get('value') ?? 0)
      resultData = { value: Math.round(val * 100) / 100, label: cfg.title ?? '', series: [] }

    } else {
      const field = cfg.groupByField ?? 'affected_users'
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN sum(n.${field}) AS value`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      resultData = { value: Number(res.records[0]?.get('value') ?? 0), label: cfg.title ?? '', series: [] }
    }

    return {
      value:  resultData.value  ?? null,
      label:  resultData.label  ?? null,
      series: resultData.series ?? [],
    }
  } finally {
    await session.close()
  }
}

// ── Query: widgetData ─────────────────────────────────────────────────────────

async function widgetData(_: unknown, args: { widgetId: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const widgetRes = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: $id})
         RETURN properties(w) AS w`,
        { id: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    if (!widgetRes.records.length) throw new GraphQLError('Widget non trovato')
    const w = mapWidget(widgetRes.records[0].get('w') as Props)
    return executeWidgetQuery(w, ctx.tenantId)
  } finally {
    await session.close()
  }
}

// ── Query: widgetDataPreview (inline config, no widget ID needed) ─────────────

async function widgetDataPreview(
  _: unknown,
  args: {
    entityType:   string
    metric:       string
    groupByField?: string | null
    filterField?:  string | null
    filterValue?:  string | null
    timeRange?:    string | null
  },
  ctx: GraphQLContext,
) {
  return executeWidgetQuery({
    entityType:   args.entityType,
    metric:       args.metric,
    groupByField: args.groupByField ?? null,
    filterField:  args.filterField  ?? null,
    filterValue:  args.filterValue  ?? null,
    timeRange:    args.timeRange    ?? null,
    title:        'Preview',
  }, ctx.tenantId)
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createCustomWidget(
  _: unknown,
  args: {
    input: {
      dashboardId: string
      title: string
      widgetType: string
      entityType: string
      metric: string
      groupByField?: string | null
      filterField?: string | null
      filterValue?: string | null
      timeRange?: string | null
      size?: string | null
      color?: string | null
    }
  },
  ctx: GraphQLContext,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()
  const { input } = args

  if (!ENTITY_LABEL_MAP[input.entityType]) throw new GraphQLError('Tipo entità non supportato')
  if (!ALLOWED_METRICS.includes(input.metric)) throw new GraphQLError('Metrica non supportata')

  const session = getSession(undefined, 'WRITE')
  try {
    // Get next position
    const posRes = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
         RETURN coalesce(max(w.position), -1) AS maxPos`,
        { dashId: input.dashboardId, tenantId: ctx.tenantId },
      ),
    )
    const position = Math.round(Number(posRes.records[0]?.get('maxPos') ?? -1)) + 1

    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})
         CREATE (w:CustomWidget {
           id:             $id,
           tenant_id:      $tenantId,
           dashboard_id:   $dashId,
           title:          $title,
           widget_type:    $widgetType,
           entity_type:    $entityType,
           metric:         $metric,
           group_by_field: $groupByField,
           filter_field:   $filterField,
           filter_value:   $filterValue,
           time_range:     $timeRange,
           size:           $size,
           color:          $color,
           position:       $position,
           created_by:     $userId,
           created_at:     $now
         })
         CREATE (d)-[:HAS_CUSTOM_WIDGET]->(w)`,
        {
          id, tenantId: ctx.tenantId, dashId: input.dashboardId,
          title:        input.title,
          widgetType:   input.widgetType,
          entityType:   input.entityType,
          metric:       input.metric,
          groupByField: input.groupByField   ?? null,
          filterField:  input.filterField    ?? null,
          filterValue:  input.filterValue    ?? null,
          timeRange:    input.timeRange      ?? null,
          size:         input.size           ?? 'medium',
          color:        input.color          ?? '#0EA5E9',
          position, userId: ctx.userId, now,
        },
      ),
    )
    void audit(ctx, 'customWidget.created', 'CustomWidget', id, { title: input.title })
    return {
      id, title: input.title, widgetType: input.widgetType,
      entityType: input.entityType, metric: input.metric,
      groupByField: input.groupByField ?? null,
      filterField:  input.filterField  ?? null,
      filterValue:  input.filterValue  ?? null,
      timeRange:    input.timeRange    ?? null,
      size:   input.size  ?? 'medium',
      color:  input.color ?? '#0EA5E9',
      position, dashboardId: input.dashboardId,
    }
  } finally {
    await session.close()
  }
}

async function updateCustomWidget(
  _: unknown,
  args: {
    id: string
    input: {
      title?: string | null
      widgetType?: string | null
      entityType?: string | null
      metric?: string | null
      groupByField?: string | null
      filterField?: string | null
      filterValue?: string | null
      timeRange?: string | null
      size?: string | null
      color?: string | null
      position?: number | null
    }
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { input } = args
  const setParts = ['w.updated_at = $now']
  const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now }

  if (input.title        != null) { setParts.push('w.title = $title');               params['title'] = input.title }
  if (input.widgetType   != null) { setParts.push('w.widget_type = $widgetType');    params['widgetType'] = input.widgetType }
  if (input.entityType   != null) { setParts.push('w.entity_type = $entityType');    params['entityType'] = input.entityType }
  if (input.metric       != null) { setParts.push('w.metric = $metric');             params['metric'] = input.metric }
  if (input.groupByField != null) { setParts.push('w.group_by_field = $gbf');        params['gbf'] = input.groupByField }
  if (input.filterField  != null) { setParts.push('w.filter_field = $ff');           params['ff'] = input.filterField }
  if (input.filterValue  != null) { setParts.push('w.filter_value = $fv');           params['fv'] = input.filterValue }
  if (input.timeRange    != null) { setParts.push('w.time_range = $timeRange');      params['timeRange'] = input.timeRange }
  if (input.size         != null) { setParts.push('w.size = $size');                 params['size'] = input.size }
  if (input.color        != null) { setParts.push('w.color = $color');               params['color'] = input.color }
  if (input.position     != null) { setParts.push('w.position = $position');         params['position'] = input.position }

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: $id})
         SET ${setParts.join(', ')}
         RETURN properties(w) AS w`,
        params,
      ),
    )
    if (!res.records.length) throw new GraphQLError('Widget non trovato')
    void audit(ctx, 'customWidget.updated', 'CustomWidget', args.id)
    return mapWidget(res.records[0].get('w') as Props)
  } finally {
    await session.close()
  }
}

async function deleteCustomWidget(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: $id}) DETACH DELETE w`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    void audit(ctx, 'customWidget.deleted', 'CustomWidget', args.id)
    return true
  } finally {
    await session.close()
  }
}

async function reorderCustomWidgets(
  _: unknown,
  args: { dashboardId: string; widgetIds: string[] },
  ctx: GraphQLContext,
) {
  const items = args.widgetIds.map((id, i) => ({ id, position: i }))
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `UNWIND $items AS item
         MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: item.id})
         SET w.position = item.position`,
        { items, dashId: args.dashboardId, tenantId: ctx.tenantId },
      ),
    )
    return (await customWidgets(_, { dashboardId: args.dashboardId }, ctx))
  } finally {
    await session.close()
  }
}

// ── Field resolver: DashboardConfig.customWidgets ─────────────────────────────

export async function dashboardCustomWidgets(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
         RETURN properties(w) AS w ORDER BY w.position ASC`,
        { id: parent.id, tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapWidget(r.get('w') as Props))
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const customWidgetResolvers = {
  Query: {
    customWidgets,
    widgetData,
    widgetDataPreview,
  },
  Mutation: {
    createCustomWidget,
    updateCustomWidget,
    deleteCustomWidget,
    reorderCustomWidgets,
  },
}
