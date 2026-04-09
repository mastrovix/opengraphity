import { GraphQLError } from 'graphql'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine, selectWorkflowForEntity } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { v4 as uuidv4 } from 'uuid'

// ── helpers ──────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

function mapCategory(props: Props, entryCount?: number) {
  return {
    id:          props['id']          as string,
    name:        props['name']        as string,
    description: (props['description'] ?? null) as string | null,
    icon:        (props['icon']       ?? null) as string | null,
    color:       (props['color']      ?? null) as string | null,
    order:       Number(props['order'] ?? 0),
    enabled:     props['enabled'] !== false,
    entryCount:  entryCount ?? 0,
  }
}

function mapEntry(props: Props) {
  const ciTypesRaw = props['ci_types']
  let ciTypes: string[] | null = null
  if (typeof ciTypesRaw === 'string') {
    try { ciTypes = JSON.parse(ciTypesRaw) as string[] } catch { ciTypes = null }
  } else if (Array.isArray(ciTypesRaw)) {
    ciTypes = ciTypesRaw as string[]
  }

  return {
    id:                         props['id']                           as string,
    name:                       props['name']                         as string,
    description:                props['description']                  as string,
    categoryId:                 props['category_id']                  as string,
    riskLevel:                  props['risk_level']                   as string,
    impact:                     props['impact']                       as string,
    defaultTitleTemplate:       props['default_title_template']       as string,
    defaultDescriptionTemplate: props['default_description_template'] as string,
    defaultPriority:            props['default_priority']             as string,
    ciTypes,
    checklist:                  (props['checklist']                   ?? null) as string | null,
    estimatedDurationHours:     props['estimated_duration_hours'] != null ? Number(props['estimated_duration_hours']) : null,
    requiresDowntime:           props['requires_downtime'] === true,
    rollbackProcedure:          (props['rollback_procedure']          ?? null) as string | null,
    icon:                       (props['icon']                        ?? null) as string | null,
    color:                      (props['color']                       ?? null) as string | null,
    workflowId:                 (props['workflow_id'] ?? null) as string | null,
    ciRequired:                 props['ci_required'] === true,
    maintenanceWindow:          (props['maintenance_window'] ?? null) as string | null,
    notifyTeam:                 props['notify_team'] === true,
    requireCompletionConfirm:   props['require_completion_confirm'] === true,
    usageCount:                 Number(props['usage_count'] ?? 0),
    enabled:                    props['enabled'] !== false,
    createdBy:                  (props['created_by']                  ?? null) as string | null,
    createdAt:                  props['created_at']                   as string,
    updatedAt:                  props['updated_at']                   as string,
    // populated by field resolver
    category:                   null,
  }
}

function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function changeCatalogCategories(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const rows = await runQuery<Row>(session, `
      MATCH (c:ChangeCatalogCategory {tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
      ORDER BY props.order ASC, props.name ASC
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => mapCategory(r.props, toInt(r.cnt)))
  } finally {
    await session.close()
  }
}

async function changeCatalogCategory(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const row = await runQueryOne<Row>(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapCategory(row.props, toInt(row.cnt)) : null
  } finally {
    await session.close()
  }
}

async function standardChangeCatalog(
  _: unknown,
  args: { categoryId?: string; search?: string; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    const conditions: string[] = ['e.tenant_id = $tenantId']

    if (args.categoryId) {
      conditions.push('e.category_id = $categoryId')
      params['categoryId'] = args.categoryId
    }
    if (args.search) {
      conditions.push('(toLower(e.name) CONTAINS toLower($search) OR toLower(e.description) CONTAINS toLower($search))')
      params['search'] = args.search
    }
    if (args.filters) {
      const allowedFields = new Set(['name', 'risk_level', 'impact', 'default_priority', 'enabled', 'category_id', 'requires_downtime'])
      const filterClause = buildAdvancedWhere(args.filters, params, allowedFields, 'e')
      if (filterClause) {
        conditions.push(filterClause)
      }
    }

    const sortMap: Record<string, string> = {
      name: 'e.name', riskLevel: 'e.risk_level', impact: 'e.impact',
      usageCount: 'e.usage_count', createdAt: 'e.created_at', updatedAt: 'e.updated_at',
    }
    const orderBy = sortMap[args.sortField ?? ''] ?? 'e.name'
    const orderDir = args.sortDirection === 'desc' ? 'DESC' : 'ASC'

    type Row = { props: Props }
    const rows = await runQuery<Row>(session, `
      MATCH (e:StandardChangeCatalogEntry)
      WHERE ${conditions.join(' AND ')}
      RETURN properties(e) AS props
      ORDER BY ${orderBy} ${orderDir}
    `, params)
    return rows.map((r) => mapEntry(r.props))
  } finally {
    await session.close()
  }
}

async function standardChangeCatalogEntry(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props }
    const row = await runQueryOne<Row>(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
      RETURN properties(e) AS props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapEntry(row.props) : null
  } finally {
    await session.close()
  }
}

// ── Category mutations ───────────────────────────────────────────────────────

async function createChangeCatalogCategory(
  _: unknown,
  args: { name: string; description?: string; icon?: string; color?: string; order?: number },
  ctx: GraphQLContext,
) {
  const id = uuidv4()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    // If no order provided, put it at the end
    let order = args.order
    if (order == null) {
      type Row = { maxOrder: unknown }
      const row = await runQueryOne<Row>(session, `
        MATCH (c:ChangeCatalogCategory {tenant_id: $tenantId})
        RETURN max(c.order) AS maxOrder
      `, { tenantId: ctx.tenantId })
      order = toInt(row?.maxOrder, 0) + 1
    }

    type Row = { props: Props }
    const rows = await runQuery<Row>(session, `
      CREATE (c:ChangeCatalogCategory {
        id:          $id,
        tenant_id:   $tenantId,
        name:        $name,
        description: $description,
        icon:        $icon,
        color:       $color,
        \`order\`:     $order,
        enabled:     true,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(c) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: args.name, description: args.description ?? null,
      icon: args.icon ?? null, color: args.color ?? null,
      order, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create category')
    void audit(ctx, 'catalog_category.created', 'ChangeCatalogCategory', id)
    return mapCategory(row.props, 0)
  } finally {
    await session.close()
  }
}

async function updateChangeCatalogCategory(
  _: unknown,
  args: { id: string; name?: string; description?: string; icon?: string; color?: string; order?: number; enabled?: boolean },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    const sets: string[] = ['c.updated_at = $now']
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }

    if (args.name != null)        { sets.push('c.name = $name');        params['name'] = args.name }
    if (args.description != null)  { sets.push('c.description = $desc'); params['desc'] = args.description }
    if (args.icon != null)         { sets.push('c.icon = $icon');        params['icon'] = args.icon }
    if (args.color != null)        { sets.push('c.color = $color');      params['color'] = args.color }
    if (args.order != null)        { sets.push('c.`order` = $order');    params['order'] = args.order }
    if (args.enabled != null)      { sets.push('c.enabled = $enabled');  params['enabled'] = args.enabled }

    type Row = { props: Props; cnt: unknown }
    const row = await runQueryOne<Row>(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      WITH c
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
    `, params)
    if (!row) throw new GraphQLError('Category not found')
    void audit(ctx, 'catalog_category.updated', 'ChangeCatalogCategory', args.id)
    return mapCategory(row.props, toInt(row.cnt))
  } finally {
    await session.close()
  }
}

async function deleteChangeCatalogCategory(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      DETACH DELETE c
    `, { id: args.id, tenantId: ctx.tenantId })
    void audit(ctx, 'catalog_category.deleted', 'ChangeCatalogCategory', args.id)
    return true
  } finally {
    await session.close()
  }
}

async function reorderChangeCatalogCategories(
  _: unknown,
  args: { categoryIds: string[] },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    for (let i = 0; i < args.categoryIds.length; i++) {
      await runQuery(session, `
        MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
        SET c.\`order\` = $order, c.updated_at = $now
      `, { id: args.categoryIds[i], tenantId: ctx.tenantId, order: i + 1, now: new Date().toISOString() })
    }
    type Row = { props: Props; cnt: unknown }
    const rows = await runQuery<Row>(session, `
      MATCH (c:ChangeCatalogCategory {tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
      ORDER BY props.order ASC
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => mapCategory(r.props, toInt(r.cnt)))
  } finally {
    await session.close()
  }
}

// ── Entry mutations ──────────────────────────────────────────────────────────

async function createStandardChangeCatalogEntry(
  _: unknown,
  args: {
    categoryId: string; name: string; description: string
    riskLevel: string; impact: string
    defaultTitleTemplate: string; defaultDescriptionTemplate: string; defaultPriority: string
    ciTypes?: string[]; checklist?: string; estimatedDurationHours?: number
    requiresDowntime?: boolean; rollbackProcedure?: string; icon?: string; color?: string
    workflowId?: string; ciRequired?: boolean; maintenanceWindow?: string
    notifyTeam?: boolean; requireCompletionConfirm?: boolean
  },
  ctx: GraphQLContext,
) {
  const id = uuidv4()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    // Validate workflowId if provided
    if (args.workflowId) {
      const wfCheck = await runQueryOne<{ et: string }>(session, `
        MATCH (w:WorkflowDefinition {id: $wfId, tenant_id: $tenantId})
        RETURN w.entity_type AS et
      `, { wfId: args.workflowId, tenantId: ctx.tenantId })
      if (!wfCheck) throw new GraphQLError('Workflow not found')
      if (wfCheck.et !== 'change') throw new GraphQLError('Workflow must be of type change')
    }

    type Row = { props: Props }
    const rows = await runQuery<Row>(session, `
      MATCH (cat:ChangeCatalogCategory {id: $categoryId, tenant_id: $tenantId})
      CREATE (e:StandardChangeCatalogEntry {
        id:                           $id,
        tenant_id:                    $tenantId,
        name:                         $name,
        description:                  $description,
        category_id:                  $categoryId,
        risk_level:                   $riskLevel,
        impact:                       $impact,
        default_title_template:       $defaultTitleTemplate,
        default_description_template: $defaultDescriptionTemplate,
        default_priority:             $defaultPriority,
        ci_types:                     $ciTypes,
        checklist:                    $checklist,
        estimated_duration_hours:     $estimatedDurationHours,
        requires_downtime:            $requiresDowntime,
        rollback_procedure:           $rollbackProcedure,
        icon:                         $icon,
        color:                        $color,
        workflow_id:                  $workflowId,
        ci_required:                  $ciRequired,
        maintenance_window:           $maintenanceWindow,
        notify_team:                  $notifyTeam,
        require_completion_confirm:   $requireCompletionConfirm,
        usage_count:                  0,
        enabled:                      true,
        created_by:                   $createdBy,
        created_at:                   $now,
        updated_at:                   $now
      })
      CREATE (e)-[:BELONGS_TO_CATEGORY]->(cat)
      RETURN properties(e) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: args.name, description: args.description,
      categoryId: args.categoryId, riskLevel: args.riskLevel, impact: args.impact,
      defaultTitleTemplate: args.defaultTitleTemplate,
      defaultDescriptionTemplate: args.defaultDescriptionTemplate,
      defaultPriority: args.defaultPriority,
      ciTypes: args.ciTypes ? JSON.stringify(args.ciTypes) : null,
      checklist: args.checklist ?? null,
      estimatedDurationHours: args.estimatedDurationHours ?? null,
      requiresDowntime: args.requiresDowntime ?? false,
      rollbackProcedure: args.rollbackProcedure ?? null,
      icon: args.icon ?? null, color: args.color ?? null,
      workflowId: args.workflowId ?? null,
      ciRequired: args.ciRequired ?? false,
      maintenanceWindow: args.maintenanceWindow ?? null,
      notifyTeam: args.notifyTeam ?? false,
      requireCompletionConfirm: args.requireCompletionConfirm ?? false,
      createdBy: ctx.userId, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create catalog entry — category not found?')

    // Create USES_WORKFLOW relationship if workflowId provided
    if (args.workflowId) {
      await runQuery(session, `
        MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
        MATCH (w:WorkflowDefinition {id: $wfId, tenant_id: $tenantId})
        CREATE (e)-[:USES_WORKFLOW]->(w)
      `, { id, tenantId: ctx.tenantId, wfId: args.workflowId })
    }

    void audit(ctx, 'catalog_entry.created', 'StandardChangeCatalogEntry', id)
    return mapEntry(row.props)
  } finally {
    await session.close()
  }
}

async function updateStandardChangeCatalogEntry(
  _: unknown,
  args: {
    id: string; name?: string; description?: string; categoryId?: string
    riskLevel?: string; impact?: string; defaultTitleTemplate?: string
    defaultDescriptionTemplate?: string; defaultPriority?: string
    ciTypes?: string[]; checklist?: string; estimatedDurationHours?: number
    requiresDowntime?: boolean; rollbackProcedure?: string
    icon?: string; color?: string; enabled?: boolean
    workflowId?: string; ciRequired?: boolean; maintenanceWindow?: string
    notifyTeam?: boolean; requireCompletionConfirm?: boolean
  },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    const sets: string[] = ['e.updated_at = $now']
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }

    if (args.name != null)                       { sets.push('e.name = $name');                                             params['name'] = args.name }
    if (args.description != null)                 { sets.push('e.description = $description');                               params['description'] = args.description }
    if (args.categoryId != null)                  { sets.push('e.category_id = $categoryId');                                params['categoryId'] = args.categoryId }
    if (args.riskLevel != null)                   { sets.push('e.risk_level = $riskLevel');                                  params['riskLevel'] = args.riskLevel }
    if (args.impact != null)                      { sets.push('e.impact = $impact');                                         params['impact'] = args.impact }
    if (args.defaultTitleTemplate != null)         { sets.push('e.default_title_template = $defaultTitleTemplate');           params['defaultTitleTemplate'] = args.defaultTitleTemplate }
    if (args.defaultDescriptionTemplate != null)   { sets.push('e.default_description_template = $defaultDescriptionTemplate'); params['defaultDescriptionTemplate'] = args.defaultDescriptionTemplate }
    if (args.defaultPriority != null)              { sets.push('e.default_priority = $defaultPriority');                      params['defaultPriority'] = args.defaultPriority }
    if (args.ciTypes !== undefined)                { sets.push('e.ci_types = $ciTypes');                                     params['ciTypes'] = args.ciTypes ? JSON.stringify(args.ciTypes) : null }
    if (args.checklist != null)                    { sets.push('e.checklist = $checklist');                                   params['checklist'] = args.checklist }
    if (args.estimatedDurationHours != null)        { sets.push('e.estimated_duration_hours = $estimatedDurationHours');      params['estimatedDurationHours'] = args.estimatedDurationHours }
    if (args.requiresDowntime != null)             { sets.push('e.requires_downtime = $requiresDowntime');                   params['requiresDowntime'] = args.requiresDowntime }
    if (args.rollbackProcedure != null)            { sets.push('e.rollback_procedure = $rollbackProcedure');                 params['rollbackProcedure'] = args.rollbackProcedure }
    if (args.icon != null)                         { sets.push('e.icon = $icon');                                            params['icon'] = args.icon }
    if (args.color != null)                        { sets.push('e.color = $color');                                          params['color'] = args.color }
    if (args.enabled != null)                      { sets.push('e.enabled = $enabled');                                      params['enabled'] = args.enabled }
    if (args.workflowId !== undefined)             { sets.push('e.workflow_id = $workflowId');                               params['workflowId'] = args.workflowId ?? null }
    if (args.ciRequired != null)                   { sets.push('e.ci_required = $ciRequired');                               params['ciRequired'] = args.ciRequired }
    if (args.maintenanceWindow !== undefined)       { sets.push('e.maintenance_window = $maintenanceWindow');                 params['maintenanceWindow'] = args.maintenanceWindow ?? null }
    if (args.notifyTeam != null)                   { sets.push('e.notify_team = $notifyTeam');                               params['notifyTeam'] = args.notifyTeam }
    if (args.requireCompletionConfirm != null)     { sets.push('e.require_completion_confirm = $requireCompletionConfirm');  params['requireCompletionConfirm'] = args.requireCompletionConfirm }

    type Row = { props: Props }
    const row = await runQueryOne<Row>(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(e) AS props
    `, params)
    if (!row) throw new GraphQLError('Catalog entry not found')

    // Update USES_WORKFLOW relationship if workflowId changed
    if (args.workflowId !== undefined) {
      // Remove existing relationship
      await runQuery(session, `
        MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})-[r:USES_WORKFLOW]->()
        DELETE r
      `, { id: args.id, tenantId: ctx.tenantId })
      // Create new relationship if workflowId is set
      if (args.workflowId) {
        await runQuery(session, `
          MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
          MATCH (w:WorkflowDefinition {id: $wfId, tenant_id: $tenantId})
          CREATE (e)-[:USES_WORKFLOW]->(w)
        `, { id: args.id, tenantId: ctx.tenantId, wfId: args.workflowId })
      }
    }

    // Update category relationship if categoryId changed
    if (args.categoryId != null) {
      await runQuery(session, `
        MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})-[r:BELONGS_TO_CATEGORY]->()
        DELETE r
      `, { id: args.id, tenantId: ctx.tenantId })
      await runQuery(session, `
        MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
        MATCH (cat:ChangeCatalogCategory {id: $categoryId, tenant_id: $tenantId})
        CREATE (e)-[:BELONGS_TO_CATEGORY]->(cat)
      `, { id: args.id, tenantId: ctx.tenantId, categoryId: args.categoryId })
    }

    void audit(ctx, 'catalog_entry.updated', 'StandardChangeCatalogEntry', args.id)
    return mapEntry(row.props)
  } finally {
    await session.close()
  }
}

async function deleteStandardChangeCatalogEntry(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
      DETACH DELETE e
    `, { id: args.id, tenantId: ctx.tenantId })
    void audit(ctx, 'catalog_entry.deleted', 'StandardChangeCatalogEntry', args.id)
    return true
  } finally {
    await session.close()
  }
}

// ── createChangeFromCatalog ──────────────────────────────────────────────────

async function createChangeFromCatalog(
  _: unknown,
  args: { catalogEntryId: string; title?: string; description?: string; ciIds?: string[] },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    // 1. Load catalog entry
    type EntryRow = { props: Props }
    const entryRow = await runQueryOne<EntryRow>(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId, enabled: true})
      RETURN properties(e) AS props
    `, { id: args.catalogEntryId, tenantId: ctx.tenantId })
    if (!entryRow) throw new GraphQLError('Catalog entry not found or disabled')
    const entry = entryRow.props

    // 2. Resolve CI details for template placeholders
    const ciNames: string[] = []
    const ciTypes: string[] = []
    const ciEnvs: string[] = []
    if (args.ciIds?.length) {
      type CIRow = { name: string; type: string | null; environment: string | null }
      const ciRows = await runQuery<CIRow>(session, `
        UNWIND $ciIds AS ciId
        MATCH (ci {id: ciId, tenant_id: $tenantId})
        RETURN ci.name AS name, ci.type AS type, ci.environment AS environment
      `, { ciIds: args.ciIds, tenantId: ctx.tenantId })
      for (const r of ciRows) {
        ciNames.push(r.name)
        if (r.type) ciTypes.push(r.type)
        if (r.environment) ciEnvs.push(r.environment)
      }
    }

    // 3. Apply title/description from enhanced templates
    function resolveTemplate(template: string, vars: Record<string, string>): string {
      return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`)
    }

    const mappedEntry = mapEntry(entry)
    const templateVars: Record<string, string> = {
      ci_name: ciNames.join(', ') || 'N/A',
      ci_type: ciTypes.join(', ') || 'N/A',
      ci_environment: ciEnvs.join(', ') || 'N/A',
      date: new Date().toLocaleDateString('it-IT'),
      operator_name: ctx.userId,
      category: mappedEntry.categoryId ?? '',
    }

    const templateTitle = (entry['default_title_template'] as string) ?? ''
    const templateDesc = (entry['default_description_template'] as string) ?? ''
    const title = args.title || resolveTemplate(templateTitle, templateVars)
    const description = args.description || resolveTemplate(templateDesc, templateVars)

    // 4. Create the Change node
    const changeId = uuidv4()
    const now = new Date().toISOString()
    type ChangeRow = { props: Props }
    const changeRows = await runQuery<ChangeRow>(session, `
      CREATE (c:Change {
        id:              $id,
        tenant_id:       $tenantId,
        title:           $title,
        description:     $description,
        type:            'standard',
        priority:        $priority,
        status:          'draft',
        catalog_entry_id: $catalogEntryId,
        created_at:      $now,
        updated_at:      $now
      })
      RETURN properties(c) AS props
    `, {
      id: changeId, tenantId: ctx.tenantId,
      title, description,
      priority: (entry['default_priority'] as string) ?? 'medium',
      catalogEntryId: args.catalogEntryId, now,
    })
    if (!changeRows[0]) throw new GraphQLError('Failed to create change')

    // 5. Link CIs via AFFECTS
    if (args.ciIds?.length) {
      for (const ciId of args.ciIds) {
        await runQuery(session, `
          MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          MERGE (c)-[:AFFECTS]->(ci)
        `, { changeId, tenantId: ctx.tenantId, ciId })
      }
    }

    // 6. Create ChangeTask nodes from checklist
    const checklistRaw = entry['checklist'] as string | null
    if (checklistRaw) {
      try {
        const checklist = JSON.parse(checklistRaw) as { title: string; description?: string }[]
        for (let i = 0; i < checklist.length; i++) {
          const item = checklist[i]!
          const taskId = uuidv4()
          await runQuery(session, `
            MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            CREATE (t:ChangeTask {
              id:          $taskId,
              tenant_id:   $tenantId,
              change_id:   $changeId,
              task_type:   'deploy',
              title:       $title,
              description: $description,
              status:      'pending',
              \`order\`:     $order,
              created_at:  $now,
              updated_at:  $now
            })
            CREATE (c)-[:HAS_TASK]->(t)
          `, {
            taskId, changeId, tenantId: ctx.tenantId,
            title: item.title, description: item.description ?? null,
            order: i + 1, now,
          })
        }
      } catch (err) {
        logger.warn({ err, catalogEntryId: args.catalogEntryId }, 'Failed to parse checklist JSON')
      }
    }

    // 7. Create WorkflowInstance — use entry's workflow or find default standard change workflow
    let definitionId: string | undefined
    const entryWorkflowId = (entry['workflow_id'] as string | null) ?? null
    if (entryWorkflowId) {
      // Validate the specific workflow exists and is active
      const wfRow = await runQueryOne<{ id: string }>(session, `
        MATCH (w:WorkflowDefinition {id: $wfId, tenant_id: $tenantId, active: true})
        WHERE w.entity_type = 'change'
        RETURN w.id AS id
      `, { wfId: entryWorkflowId, tenantId: ctx.tenantId })
      if (!wfRow) throw new GraphQLError('Configured workflow not found or inactive')
      definitionId = wfRow.id
    } else {
      // Default: find standard change workflow using selector
      const selected = await selectWorkflowForEntity(session, ctx.tenantId, 'change', null, 'standard')
      definitionId = selected?.definitionId
    }

    await workflowEngine.createInstance(session, ctx.tenantId, changeId, 'change', definitionId)

    // Auto-transition to approved (standard change)
    const wiRes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { changeId, tenantId: ctx.tenantId }))

    if (wiRes.records.length > 0) {
      const instanceId = wiRes.records[0]!.get('instanceId') as string
      await workflowEngine.transition(session, {
        instanceId, toStepName: 'approved',
        triggeredBy: 'system', triggerType: 'automatic',
        notes: 'Standard change da catalogo — auto-approvato',
      }, { userId: ctx.userId, entityData: {} })
    }

    // 8. Increment usage_count on catalog entry
    await runQuery(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
      SET e.usage_count = coalesce(e.usage_count, 0) + 1
    `, { id: args.catalogEntryId, tenantId: ctx.tenantId })

    // 9. Audit log
    void audit(ctx, 'change.created_from_catalog', 'Change', changeId)

    // 10. Return the change with full fields
    type FullRow = { props: Props }
    const fullRow = await runQueryOne<FullRow>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      RETURN properties(c) AS props
    `, { changeId, tenantId: ctx.tenantId })

    if (!fullRow) throw new GraphQLError('Change created but could not be retrieved')

    const p = fullRow.props
    return {
      id:             p['id']              as string,
      tenantId:       p['tenant_id']       as string,
      title:          p['title']           as string,
      description:    (p['description']    ?? null) as string | null,
      type:           p['type']            as string,
      priority:       (p['priority']       ?? 'medium') as string,
      status:         p['status']          as string,
      scheduledStart: (p['scheduled_start'] ?? null) as string | null,
      scheduledEnd:   (p['scheduled_end']   ?? null) as string | null,
      implementedAt:  (p['implemented_at']  ?? null) as string | null,
      createdAt:      p['created_at']      as string,
      updatedAt:      p['updated_at']      as string,
      assignedTeam: null, assignee: null,
      affectedCIs: [], relatedIncidents: [],
      changeTasks: [], createdBy: null, comments: [],
    }
  } finally {
    await session.close()
  }
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function categoryFieldResolver(
  parent: { categoryId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const row = await runQueryOne<Row>(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
    `, { id: parent.categoryId, tenantId: ctx.tenantId })
    return row ? mapCategory(row.props, toInt(row.cnt)) : null
  } finally {
    await session.close()
  }
}

async function workflowFieldResolver(
  parent: { workflowId: string | null },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.workflowId) return null
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (w:WorkflowDefinition {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: parent.workflowId, tenantId: ctx.tenantId })
    if (!row) return null
    return {
      id:         row.props['id']          as string,
      name:       row.props['name']        as string,
      entityType: row.props['entity_type'] as string,
      category:   (row.props['category'] ?? null) as string | null,
      active:     row.props['active'] !== false,
      version:    Number(row.props['version'] ?? 1),
    }
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const standardChangeCatalogResolvers = {
  Query: {
    changeCatalogCategories,
    changeCatalogCategory,
    standardChangeCatalog,
    standardChangeCatalogEntry,
  },
  Mutation: {
    createChangeCatalogCategory,
    updateChangeCatalogCategory,
    deleteChangeCatalogCategory,
    reorderChangeCatalogCategories,
    createStandardChangeCatalogEntry,
    updateStandardChangeCatalogEntry,
    deleteStandardChangeCatalogEntry,
    createChangeFromCatalog,
  },
  StandardChangeCatalogEntry: {
    category: categoryFieldResolver,
    workflow: workflowFieldResolver,
  },
}
