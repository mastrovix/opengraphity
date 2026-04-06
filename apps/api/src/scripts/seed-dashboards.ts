/**
 * Seeds 3 default role-based dashboards for a tenant.
 * Usage: npx tsx src/scripts/seed-dashboards.ts --tenant-id c-one
 */
import { getSession } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

const tenantId = (() => {
  const idx = process.argv.indexOf('--tenant-id')
  if (idx < 0 || !process.argv[idx + 1]) {
    process.stderr.write('Usage: seed-dashboards.ts --tenant-id <id>\n')
    process.exit(1)
  }
  return process.argv[idx + 1]
})()

interface WidgetSpec {
  title:        string
  widgetType:   string
  entityType:   string
  metric:       string
  groupByField: string | null
  filterField:  string | null
  filterValue:  string | null
  timeRange:    string | null
  size:         string
  color:        string
}

interface DashboardSpec {
  name:        string
  description: string
  role:        string | null
  isDefault:   boolean
  isShared:    boolean
  widgets:     WidgetSpec[]
}

const DASHBOARDS: DashboardSpec[] = [
  {
    name:        'IT Manager Overview',
    description: 'Vista operativa per il responsabile IT',
    role:        'admin',
    isDefault:   true,
    isShared:    true,
    widgets: [
      { title: 'Incident Aperti',       widgetType: 'counter',    entityType: 'incident', metric: 'count',          groupByField: null,       filterField: 'status', filterValue: 'new',      timeRange: null,  size: 'small',  color: '#ef4444' },
      { title: 'Change in Corso',        widgetType: 'counter',    entityType: 'change',   metric: 'count',          groupByField: null,       filterField: 'status', filterValue: 'deploying',timeRange: null,  size: 'small',  color: '#f59e0b' },
      { title: 'Incident per Priority',  widgetType: 'chart_pie',  entityType: 'incident', metric: 'count_by_field', groupByField: 'priority', filterField: null,     filterValue: null,       timeRange: '30d', size: 'medium', color: '#8b5cf6' },
      { title: 'Trend Incident (30gg)',  widgetType: 'counter',    entityType: 'incident', metric: 'count',          groupByField: null,       filterField: null,     filterValue: null,       timeRange: '30d', size: 'medium', color: '#0EA5E9' },
      { title: 'Incident per Severity',  widgetType: 'chart_bar',  entityType: 'incident', metric: 'count_by_field', groupByField: 'severity', filterField: null,     filterValue: null,       timeRange: '7d',  size: 'medium', color: '#0EA5E9' },
    ],
  },
  {
    name:        'Helpdesk Operativo',
    description: 'Dashboard per gli agenti del helpdesk',
    role:        'operator',
    isDefault:   true,
    isShared:    true,
    widgets: [
      { title: 'Incident Aperti',        widgetType: 'counter',   entityType: 'incident', metric: 'count',          groupByField: null,     filterField: 'status', filterValue: 'new',  timeRange: null, size: 'small',  color: '#ef4444' },
      { title: 'Incident Non Assegnati', widgetType: 'counter',   entityType: 'incident', metric: 'count',          groupByField: null,     filterField: 'status', filterValue: 'new',  timeRange: '24h', size: 'small', color: '#f59e0b' },
      { title: 'Incident per Status',    widgetType: 'chart_bar', entityType: 'incident', metric: 'count_by_field', groupByField: 'status', filterField: null,     filterValue: null,   timeRange: '7d',  size: 'large',  color: '#10b981' },
    ],
  },
  {
    name:        'Executive Summary',
    description: 'Vista di alto livello per il management',
    role:        null,
    isDefault:   false,
    isShared:    true,
    widgets: [
      { title: 'Incident (90gg)',  widgetType: 'counter',    entityType: 'incident', metric: 'count',          groupByField: null,       filterField: null, filterValue: null, timeRange: '90d', size: 'small',  color: '#0EA5E9' },
      { title: 'Change Completate',widgetType: 'counter',    entityType: 'change',   metric: 'count',          groupByField: null,       filterField: null, filterValue: null, timeRange: '30d', size: 'small',  color: '#10b981' },
      { title: 'Incident per Categoria', widgetType: 'chart_pie', entityType: 'incident', metric: 'count_by_field', groupByField: 'category', filterField: null, filterValue: null, timeRange: '90d', size: 'medium', color: '#8b5cf6' },
    ],
  },
]

async function main() {
  const session = getSession()
  const now     = new Date().toISOString()
  let created = 0

  try {
    // Use a sentinel user id for shared dashboards (no user owner)
    const SYSTEM_USER = `system-${tenantId}`

    for (const spec of DASHBOARDS) {
      // Skip if already exists
      const existing = await session.executeRead((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {tenant_id: $tenantId, name: $name}) RETURN d.id LIMIT 1`,
          { tenantId, name: spec.name },
        ),
      )
      if (existing.records.length > 0) {
        process.stdout.write(`  skip: "${spec.name}" already exists\n`)
        continue
      }

      const dashId = uuidv4()

      // Create dashboard
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (d:DashboardConfig {
             id:          $id,
             tenant_id:   $tenantId,
             user_id:     $userId,
             name:        $name,
             description: $description,
             role:        $role,
             visibility:  'all',
             is_default:  $isDefault,
             is_personal: false,
             is_shared:   $isShared,
             created_at:  $now,
             updated_at:  $now
           })`,
          {
            id: dashId, tenantId, userId: SYSTEM_USER,
            name: spec.name, description: spec.description,
            role: spec.role ?? null,
            isDefault: spec.isDefault, isShared: spec.isShared, now,
          },
        ),
      )

      // Create CustomWidget nodes
      for (let i = 0; i < spec.widgets.length; i++) {
        const w = spec.widgets[i]!
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
              id: uuidv4(), dashId, tenantId,
              title: w.title, widgetType: w.widgetType,
              entityType: w.entityType, metric: w.metric,
              groupByField: w.groupByField ?? null,
              filterField:  w.filterField  ?? null,
              filterValue:  w.filterValue  ?? null,
              timeRange:    w.timeRange    ?? null,
              size: w.size, color: w.color, position: i,
              userId: SYSTEM_USER, now,
            },
          ),
        )
      }

      process.stdout.write(`  created: "${spec.name}" (${spec.widgets.length} widget/s)\n`)
      created++
    }

    process.stdout.write(`\nDone: ${created} dashboard/s created for tenant=${tenantId}\n`)
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1) })
