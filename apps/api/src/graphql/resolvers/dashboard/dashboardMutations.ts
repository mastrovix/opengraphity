import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { audit } from '../../../lib/audit.js'
import { mapDashboardConfig, type Props } from './helpers.js'

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createDashboard(
  _: unknown,
  args: {
    input: {
      name: string
      description?: string | null
      role?: string | null
      visibility: string
      isShared?: boolean | null
      sharedWithTeamIds?: string[] | null
    }
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { name, description, role, visibility, isShared, sharedWithTeamIds } = args.input
  const session = getSession(undefined, 'WRITE')
  try {
    // Check if this is the first dashboard for this user
    const countResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) RETURN count(d) AS cnt`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    const isFirst = Math.round(Number(countResult.records[0].get('cnt'))) === 0

    const created = await session.executeWrite((tx) =>
      tx.run(
        `
        CREATE (d:DashboardConfig {
          id: randomUUID(),
          tenant_id: $tenantId,
          user_id: $userId,
          name: $name,
          description: $description,
          role: $role,
          visibility: $visibility,
          is_default: $isDefault,
          is_personal: true,
          is_shared: $isShared,
          created_at: $now,
          updated_at: $now
        })
        RETURN properties(d) AS props
        `,
        {
          tenantId: ctx.tenantId, userId: ctx.userId,
          name, description: description ?? null, role: role ?? null,
          visibility, isDefault: isFirst, isShared: isShared ?? false, now,
        },
      ),
    )
    if (!created.records.length) throw new Error('Failed to create dashboard')

    // Create CREATED_BY rel (best-effort)
    await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (d:DashboardConfig {id: $dashId})
        OPTIONAL MATCH (u:User {id: $userId})
        FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
          CREATE (d)-[:CREATED_BY]->(u)
        )
        `,
        { dashId: (created.records[0].get('props') as Props)['id'] as string, userId: ctx.userId },
      ),
    )
    const props = created.records[0].get('props') as Props
    const dashId = props['id'] as string
    void audit(ctx, 'dashboard.created', 'DashboardConfig', dashId)

    // Create SHARED_WITH rels
    if (sharedWithTeamIds && sharedWithTeamIds.length > 0) {
      await session.executeWrite((tx) =>
        tx.run(
          `
          MATCH (d:DashboardConfig {id: $dashId})
          UNWIND $teamIds AS teamId
          MATCH (t:Team {id: teamId, tenant_id: $tenantId})
          MERGE (d)-[:SHARED_WITH]->(t)
          `,
          { dashId, teamIds: sharedWithTeamIds, tenantId: ctx.tenantId },
        ),
      )
    }

    return mapDashboardConfig(props)
  } finally {
    await session.close()
  }
}

export async function updateDashboard(
  _: unknown,
  args: {
    id: string
    input: {
      name?: string | null
      description?: string | null
      role?: string | null
      visibility?: string | null
      isShared?: boolean | null
      sharedWithTeamIds?: string[] | null
      isDefault?: boolean | null
    }
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { name, description, role, visibility, isShared, sharedWithTeamIds, isDefault } = args.input
  const session = getSession(undefined, 'WRITE')
  try {
    const setParts: string[] = ['d.updated_at = $now']
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, now }

    if (name        != null) { setParts.push('d.name = $name');               params['name'] = name }
    if (description != null) { setParts.push('d.description = $description'); params['description'] = description }
    if (role        != null) { setParts.push('d.role = $role');               params['role'] = role }
    if (visibility  != null) { setParts.push('d.visibility = $visibility');   params['visibility'] = visibility }
    if (isShared    != null) { setParts.push('d.is_shared = $isShared');      params['isShared'] = isShared }

    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId, user_id: $userId})
         SET ${setParts.join(', ')}
         RETURN properties(d) AS props`,
        params,
      ),
    )
    if (!result.records.length) throw new Error('Dashboard not found or access denied')

    // Set as default: unset others, then set this
    if (isDefault) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) SET d.is_default = false`,
          { tenantId: ctx.tenantId, userId: ctx.userId },
        ),
      )
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) SET d.is_default = true`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
    }

    // Re-create SHARED_WITH rels if provided
    if (sharedWithTeamIds != null) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {id: $id})-[r:SHARED_WITH]->() DELETE r`,
          { id: args.id },
        ),
      )
      if (sharedWithTeamIds.length > 0) {
        await session.executeWrite((tx) =>
          tx.run(
            `
            MATCH (d:DashboardConfig {id: $id})
            UNWIND $teamIds AS teamId
            MATCH (t:Team {id: teamId, tenant_id: $tenantId})
            MERGE (d)-[:SHARED_WITH]->(t)
            `,
            { id: args.id, teamIds: sharedWithTeamIds, tenantId: ctx.tenantId },
          ),
        )
      }
    }

    // Refetch updated props
    const updated = await session.executeRead((tx) =>
      tx.run(`MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS props`, { id: args.id, tenantId: ctx.tenantId }),
    )
    void audit(ctx, 'dashboard.updated', 'DashboardConfig', args.id)
    return mapDashboardConfig(updated.records[0].get('props') as Props)
  } finally {
    await session.close()
  }
}

export async function deleteDashboard(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    // Check user has more than one dashboard
    const countResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) RETURN count(d) AS cnt`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    const cnt = Math.round(Number(countResult.records[0].get('cnt')))
    if (cnt <= 1) throw new Error('Non puoi eliminare l\'unica dashboard')

    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId, user_id: $userId}) DETACH DELETE d`,
        { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    void audit(ctx, 'dashboard.deleted', 'DashboardConfig', args.id)
    return true
  } finally {
    await session.close()
  }
}

export async function cloneDashboard(_: unknown, args: { id: string; newName: string }, ctx: GraphQLContext) {
  const newId = uuidv4()
  const now   = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    // Load source dashboard
    const src = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS p`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    if (!src.records.length) throw new Error('Dashboard non trovata')
    const sp = src.records[0].get('p') as Props

    // Create cloned dashboard
    await session.executeWrite((tx) =>
      tx.run(
        `CREATE (d:DashboardConfig {
           id: $newId, tenant_id: $tenantId, user_id: $userId,
           name: $name, description: $description, role: $role,
           visibility: $visibility, is_default: false,
           is_personal: true, is_shared: $isShared,
           created_at: $now, updated_at: $now
         })`,
        {
          newId, tenantId: ctx.tenantId, userId: ctx.userId,
          name:        args.newName,
          description: (sp['description'] ?? null) as string | null,
          role:        (sp['role']        ?? null) as string | null,
          visibility:  (sp['visibility']  ?? 'private') as string,
          isShared:    (sp['is_shared']   ?? false) as boolean,
          now,
        },
      ),
    )

    // Clone legacy DashboardWidget nodes
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (src:DashboardConfig {id: $srcId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget)
         MATCH (dst:DashboardConfig {id: $dstId, tenant_id: $tenantId})
         CREATE (wc:DashboardWidget {
           id: randomUUID(), dashboard_id: $dstId,
           report_template_id: w.report_template_id,
           report_section_id:  w.report_section_id,
           col_span: w.col_span, order: w.order, created_at: $now
         })
         CREATE (dst)-[:HAS_WIDGET]->(wc)`,
        { srcId: args.id, dstId: newId, tenantId: ctx.tenantId, now },
      ),
    )

    // Clone CustomWidget nodes
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (src:DashboardConfig {id: $srcId, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
         MATCH (dst:DashboardConfig {id: $dstId, tenant_id: $tenantId})
         CREATE (wc:CustomWidget {
           id: randomUUID(), tenant_id: $tenantId, dashboard_id: $dstId,
           title: w.title, widget_type: w.widget_type, entity_type: w.entity_type,
           metric: w.metric, group_by_field: w.group_by_field,
           filter_field: w.filter_field, filter_value: w.filter_value,
           time_range: w.time_range, size: w.size, color: w.color,
           position: w.position, created_by: $userId, created_at: $now
         })
         CREATE (dst)-[:HAS_CUSTOM_WIDGET]->(wc)`,
        { srcId: args.id, dstId: newId, tenantId: ctx.tenantId, userId: ctx.userId, now },
      ),
    )

    void audit(ctx, 'dashboard.cloned', 'DashboardConfig', newId, { sourceDashboardId: args.id })

    const res = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS p`,
        { id: newId, tenantId: ctx.tenantId },
      ),
    )
    return mapDashboardConfig(res.records[0].get('p') as Props)
  } finally {
    await session.close()
  }
}
