import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { loadFullTemplate, createSectionWithNodesEdges, type SectionInput } from './customReports.js'

export const Mutation = {
  async createReportTemplate(
    _: unknown,
    args: { input: {
      name: string; description?: string; icon?: string; visibility: string
      sharedWithTeamIds?: string[]
      scheduleEnabled?: boolean; scheduleCron?: string; scheduleChannelId?: string
    } },
    ctx: GraphQLContext,
  ) {
    const id = uuidv4()
    const now = new Date().toISOString()
    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite(tx =>
        tx.run(`
          CREATE (r:ReportTemplate {
            id:                  $id,
            tenant_id:           $tenantId,
            name:                $name,
            description:         $description,
            icon:                $icon,
            visibility:          $visibility,
            created_by:          $userId,
            schedule_enabled:    $scheduleEnabled,
            schedule_cron:       $scheduleCron,
            schedule_channel_id: $scheduleChannelId,
            created_at:          $now,
            updated_at:          $now
          })
          WITH r
          MATCH (u:User {id: $userId})
          CREATE (r)-[:CREATED_BY]->(u)
        `, {
          id, tenantId: ctx.tenantId, name: args.input.name,
          description: args.input.description ?? null,
          icon: args.input.icon ?? null,
          visibility: args.input.visibility,
          userId: ctx.userId,
          scheduleEnabled: args.input.scheduleEnabled ?? false,
          scheduleCron: args.input.scheduleCron ?? null,
          scheduleChannelId: args.input.scheduleChannelId ?? null,
          now,
        }),
      )

      if (args.input.sharedWithTeamIds?.length) {
        const shareSession = getSession(undefined, 'WRITE')
        try {
          await shareSession.executeWrite(tx =>
            tx.run(`
              MATCH (r:ReportTemplate {id: $id})
              UNWIND $teamIds AS teamId
              MATCH (t:Team {id: teamId})
              MERGE (r)-[:SHARED_WITH]->(t)
            `, { id, teamIds: args.input.sharedWithTeamIds }),
          )
        } finally {
          await shareSession.close()
        }
      }
    } finally {
      await session.close()
    }

    void audit(ctx, 'report.created', 'ReportTemplate', id)
    return loadFullTemplate(id, ctx.tenantId)
  },

  async updateReportTemplate(
    _: unknown,
    args: { id: string; input: {
      name?: string; description?: string; icon?: string; visibility?: string
      sharedWithTeamIds?: string[]
      scheduleEnabled?: boolean; scheduleCron?: string; scheduleChannelId?: string
    } },
    ctx: GraphQLContext,
  ) {
    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
          SET r.name                = COALESCE($name, r.name),
              r.description         = COALESCE($description, r.description),
              r.icon                = COALESCE($icon, r.icon),
              r.visibility          = COALESCE($visibility, r.visibility),
              r.schedule_enabled    = COALESCE($scheduleEnabled, r.schedule_enabled),
              r.schedule_cron       = COALESCE($scheduleCron, r.schedule_cron),
              r.schedule_channel_id = COALESCE($scheduleChannelId, r.schedule_channel_id),
              r.updated_at          = $now
        `, {
          id: args.id, tenantId: ctx.tenantId,
          name: args.input.name ?? null,
          description: args.input.description ?? null,
          icon: args.input.icon ?? null,
          visibility: args.input.visibility ?? null,
          scheduleEnabled: args.input.scheduleEnabled ?? null,
          scheduleCron: args.input.scheduleCron ?? null,
          scheduleChannelId: args.input.scheduleChannelId ?? null,
          now: new Date().toISOString(),
        }),
      )

      if (args.input.sharedWithTeamIds !== undefined) {
        const shareSession = getSession(undefined, 'WRITE')
        try {
          await shareSession.executeWrite(tx =>
            tx.run(`
              MATCH (r:ReportTemplate {id: $id})-[rel:SHARED_WITH]->()
              DELETE rel
            `, { id: args.id }),
          )
          if (args.input.sharedWithTeamIds!.length > 0) {
            await shareSession.executeWrite(tx =>
              tx.run(`
                MATCH (r:ReportTemplate {id: $id})
                UNWIND $teamIds AS teamId
                MATCH (t:Team {id: teamId})
                MERGE (r)-[:SHARED_WITH]->(t)
              `, { id: args.id, teamIds: args.input.sharedWithTeamIds }),
            )
          }
        } finally {
          await shareSession.close()
        }
      }
    } finally {
      await session.close()
    }

    void audit(ctx, 'report.updated', 'ReportTemplate', args.id)
    return loadFullTemplate(args.id, ctx.tenantId)
  },

  async deleteReportTemplate(_: unknown, args: { id: string }, ctx: GraphQLContext) {
    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
          OPTIONAL MATCH (r)-[:HAS_SECTION]->(s:ReportSection)
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          DETACH DELETE r, s, n
        `, { id: args.id, tenantId: ctx.tenantId }),
      )
      void audit(ctx, 'report.deleted', 'ReportTemplate', args.id)
      return true
    } finally {
      await session.close()
    }
  },

  async addReportSection(
    _: unknown,
    args: { templateId: string; input: SectionInput },
    ctx: GraphQLContext,
  ) {
    const sectionId = uuidv4()
    const session = getSession(undefined, 'WRITE')
    try {
      const orderRes = await session.executeRead(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {id: $templateId})-[:HAS_SECTION]->(s:ReportSection)
          RETURN coalesce(max(s.order), -1) + 1 AS nextOrder
        `, { templateId: args.templateId }),
      )
      const order = Math.round(Number(orderRes.records[0]?.get('nextOrder') ?? 0))

      await createSectionWithNodesEdges(session, args.templateId, sectionId, order, args.input)
    } finally {
      await session.close()
    }
    return loadFullTemplate(args.templateId, ctx.tenantId)
  },

  async updateReportSection(
    _: unknown,
    args: { sectionId: string; input: SectionInput },
    ctx: GraphQLContext,
  ) {
    const session = getSession(undefined, 'WRITE')
    let templateId: string
    try {
      const res = await session.executeRead(tx =>
        tx.run(`
          MATCH (r:ReportTemplate)-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
          RETURN r.id AS templateId, s.order AS order
        `, { sectionId: args.sectionId }),
      )
      if (!res.records.length) throw new NotFoundError('ReportSection', args.sectionId)
      templateId = res.records[0].get('templateId') as string
      const order = Math.round(Number(res.records[0].get('order') ?? 0))

      // Delete old section nodes (DETACH DELETE cascades REPORT_EDGE relationships)
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (s:ReportSection {id: $sectionId})-[:HAS_NODE]->(n:ReportNode)
          DETACH DELETE n
        `, { sectionId: args.sectionId }),
      )
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (s:ReportSection {id: $sectionId})
          DETACH DELETE s
        `, { sectionId: args.sectionId }),
      )

      await createSectionWithNodesEdges(session, templateId, args.sectionId, order, args.input)
    } finally {
      await session.close()
    }
    return loadFullTemplate(templateId!, ctx.tenantId)
  },

  async removeReportSection(
    _: unknown,
    args: { templateId: string; sectionId: string },
    ctx: GraphQLContext,
  ) {
    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (s:ReportSection {id: $sectionId})
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          DETACH DELETE s, n
        `, { sectionId: args.sectionId }),
      )
    } finally {
      await session.close()
    }
    return loadFullTemplate(args.templateId, ctx.tenantId)
  },

  async reorderReportSections(
    _: unknown,
    args: { templateId: string; sectionIds: string[] },
    ctx: GraphQLContext,
  ) {
    const session = getSession(undefined, 'WRITE')
    try {
      for (let i = 0; i < args.sectionIds.length; i++) {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (s:ReportSection {id: $sectionId})
            SET s.order = $order
          `, { sectionId: args.sectionIds[i], order: i }),
        )
      }
    } finally {
      await session.close()
    }
    return loadFullTemplate(args.templateId, ctx.tenantId)
  },
}
