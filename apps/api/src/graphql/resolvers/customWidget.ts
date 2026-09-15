import { v4 as uuidv4 } from 'uuid'
import { GraphQLError } from 'graphql'
import { NotFoundError } from '../../lib/errors.js'
import { getSession } from '@opengraphity/neo4j'
import { audit } from '../../lib/audit.js'
import type { GraphQLContext } from '../../context.js'
import { widgetCatalog, type WidgetCatalogEntity } from '../../lib/widgetCatalog.js'
import { assertDashboardAccess, assertDashboardOwnerByWidget, resolveDashboardIdForWidget } from './reportAccess.js'

// ── Catalogo (injection-safe) ─────────────────────────────────────────────────
//
// Entità e campi vengono dal metamodello del cliente (lib/widgetCatalog.ts,
// ondata 5 di «Nulla cablato»): prima erano liste scritte qui e copiate nel web.
// La protezione resta: nella Cypher entrano solo l'etichetta di un'entità del
// catalogo e la proprietà di un suo campo.

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
    await assertDashboardAccess(session, args.dashboardId, ctx, 'read')
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

export interface ValidatedWidget {
  neo4jLabel: string
  /** field name → property, for the fields this widget uses. */
  property:   (field: string) => string
}

const badInput = (message: string, key: string, params: Record<string, string>) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', i18n: { key, params } } })

/** Validates the (entityType, metric, groupByField, filterField) against the tenant's catalog; throws BAD_USER_INPUT. */
export function validateWidgetConfig(
  cfg: Pick<WidgetConfig, 'entityType' | 'metric' | 'groupByField' | 'filterField'>,
  catalog: readonly WidgetCatalogEntity[],
): ValidatedWidget {
  const entity = catalog.find((e) => e.entityType === cfg.entityType)
  if (!entity) throw badInput(`Unsupported entity type: ${cfg.entityType}`, 'errors.widget.entityType', { entityType: cfg.entityType })
  if (!ALLOWED_METRICS.includes(cfg.metric)) throw badInput(`Unsupported metric: ${cfg.metric}`, 'errors.widget.metric', { metric: cfg.metric })

  const byName = new Map(entity.fields.map((f) => [f.name, f]))
  const numericFields = entity.fields.filter((f) => f.numeric).map((f) => f.name)
  const isAggregate   = cfg.metric === 'avg_field' || cfg.metric === 'sum_field'

  if (isAggregate) {
    if (!cfg.groupByField) {
      throw badInput(`groupByField is required for the '${cfg.metric}' metric`, 'errors.widget.groupByRequired', { metric: cfg.metric })
    }
    if (!byName.get(cfg.groupByField)?.numeric) {
      const message = `Field '${cfg.groupByField}' is not numeric for '${cfg.entityType}': ${cfg.metric} only takes ${numericFields.length ? numericFields.join(', ') : 'no field'}`
      throw numericFields.length
        ? badInput(message, 'errors.widget.notNumeric', { field: cfg.groupByField, entityType: cfg.entityType, metric: cfg.metric, allowed: numericFields.join(', ') })
        : badInput(message, 'errors.widget.noNumericField', { field: cfg.groupByField, entityType: cfg.entityType, metric: cfg.metric })
    }
  } else if (cfg.groupByField && !byName.get(cfg.groupByField)?.groupable) {
    throw badInput(`group_by field not allowed: ${cfg.groupByField}`, 'errors.widget.groupByNotAllowed', { field: cfg.groupByField })
  }
  if (cfg.filterField && !byName.get(cfg.filterField)?.groupable) {
    throw badInput(`filter field not allowed: ${cfg.filterField}`, 'errors.widget.filterNotAllowed', { field: cfg.filterField })
  }
  return {
    neo4jLabel: entity.neo4jLabel,
    property: (field: string) => {
      const f = byName.get(field)
      if (!f) throw new Error(`widget: field ${field} not validated`)
      return f.property
    },
  }
}

/** Aggregate value: null means "no numeric data" — an error, never a fabricated 0. */
function aggregateValue(records: Array<{ get: (k: string) => unknown }>, what: string): number {
  const raw = records[0]?.get('value')
  if (raw == null) {
    throw new GraphQLError(`${what}: no numeric value (no matching entity, or the field is empty)`, { extensions: { code: 'NO_DATA', i18n: { key: 'errors.widget.noData', params: { what } } } })
  }
  const n = typeof raw === 'object' && typeof (raw as { toNumber?: () => number }).toNumber === 'function'
    ? (raw as { toNumber: () => number }).toNumber()
    : Number(raw)
  if (!Number.isFinite(n)) throw new GraphQLError(`${what}: non-numeric result (${String(raw)})`)
  return n
}

async function executeWidgetQuery(cfg: WidgetConfig, tenantId: string) {
  const { neo4jLabel, property } = validateWidgetConfig(cfg, await widgetCatalog(tenantId))

  const whereClause: string[] = ['n.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId }

  if (cfg.timeRange && cfg.timeRange !== 'all' && TIME_RANGE_HOURS[cfg.timeRange]) {
    const hoursAgo = TIME_RANGE_HOURS[cfg.timeRange]
    const since = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
    whereClause.push('n.created_at >= $since')
    params['since'] = since
  }

  if (cfg.filterField && cfg.filterValue != null) {
    whereClause.push(`n.${property(cfg.filterField)} = $filterValue`)
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
      resultData = { value: aggregateValue(res.records, 'count'), label: cfg.title ?? '', series: [] }

    } else if (cfg.metric === 'count_by_field') {
      if (!cfg.groupByField) throw new GraphQLError("groupByField is required for the 'count_by_field' metric", { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.widget.groupByRequired', params: { metric: 'count_by_field' } } } })
      const field = cfg.groupByField
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN n.${property(field)} AS label, count(n) AS value ORDER BY value DESC LIMIT 20`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      const series = res.records.map((r) => ({
        label: (r.get('label') as string | null) ?? 'N/A',
        value: aggregateValue([r], `count_by_field ${field}`),
      }))
      resultData = { value: series.reduce((a, s) => a + s.value, 0), label: cfg.title ?? '', series }

    } else if (cfg.metric === 'avg_field') {
      // groupByField validated numeric by validateWidgetConfig
      const field = cfg.groupByField!
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN avg(n.${property(field)}) AS value`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      const val = aggregateValue(res.records, `avg(${field})`)
      resultData = { value: Math.round(val * 100) / 100, label: cfg.title ?? '', series: [] }

    } else {
      const field = cfg.groupByField!
      cypher = `MATCH (n:${neo4jLabel}) ${whereStr} RETURN sum(n.${property(field)}) AS value`
      const res = await session.executeRead((tx) => tx.run(cypher, params))
      resultData = { value: aggregateValue(res.records, `sum(${field})`), label: cfg.title ?? '', series: [] }
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
    const dashboardId = await resolveDashboardIdForWidget(session, args.widgetId, 'customWidget', ctx.tenantId)
    await assertDashboardAccess(session, dashboardId, ctx, 'read')
    const widgetRes = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: $id})
         RETURN properties(w) AS w`,
        { id: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    if (!widgetRes.records.length) throw new NotFoundError('Widget')
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

  // Same validation as execution (numeric whitelist for avg/sum included):
  // a widget that cannot run must never be stored.
  validateWidgetConfig({
    entityType: input.entityType, metric: input.metric,
    groupByField: input.groupByField ?? null, filterField: input.filterField ?? null,
  }, await widgetCatalog(ctx.tenantId))

  const session = getSession(undefined, 'WRITE')
  try {
    await assertDashboardAccess(session, input.dashboardId, ctx, 'write')

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
    await assertDashboardOwnerByWidget(session, args.id, 'customWidget', ctx)
    const res = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget {id: $id})
         SET ${setParts.join(', ')}
         RETURN properties(w) AS w`,
        params,
      ),
    )
    if (!res.records.length) throw new NotFoundError('Widget')
    void audit(ctx, 'customWidget.updated', 'CustomWidget', args.id)
    return mapWidget(res.records[0].get('w') as Props)
  } finally {
    await session.close()
  }
}

async function deleteCustomWidget(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    await assertDashboardOwnerByWidget(session, args.id, 'customWidget', ctx)
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
    await assertDashboardAccess(session, args.dashboardId, ctx, 'write')
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
    widgetCatalog: (_: unknown, __: unknown, ctx: GraphQLContext) => widgetCatalog(ctx.tenantId),
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
