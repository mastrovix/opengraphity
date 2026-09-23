import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { loadFullTemplate, createSectionWithNodesEdges, type SectionInput } from './customReports.js'
import { loadTemplateSections } from '../../lib/reportTemplates.js'
import { getReportWhitelist } from '../../lib/reportWhitelist.js'
import { assertReportTemplateAccess } from './reportAccess.js'
import { requirePermission } from '../../lib/permissions.js'

/** The schedule a template runs on: off, or on with its cron and its Slack channel. */
interface EffectiveSchedule { enabled: boolean; cron: string | null; channelId: string | null }

const effective = (s: EffectiveSchedule): string =>
  s.enabled ? JSON.stringify([s.cron, s.channelId]) : 'off'

/**
 * THE SCHEDULE IS report.schedule's (review of 23 Sep 2026). A template save
 * may carry the schedule fields, and until then report.write alone turned it
 * on: the scheduled run posts to Slack and notifies the whole tenant, which
 * is exactly what `updateReportSchedule` keeps behind report.schedule. The
 * web sends the schedule back with every save, so a save that leaves the
 * EFFECTIVE schedule as it is needs nothing more; one that changes it does.
 */
function requireScheduleChangeRight(ctx: GraphQLContext, before: EffectiveSchedule, after: EffectiveSchedule): void {
  if (effective(before) !== effective(after)) requirePermission(ctx, 'report.schedule')
}

export const Mutation = {
  /**
   * F-07: "Duplica" used to create an EMPTY template client-side. This clones
   * template + sections + nodes + edges with fresh ids in ONE transaction; the
   * copy is private to the caller and never inherits the source schedule.
   */
  async duplicateReportTemplate(_: unknown, args: { id: string; name?: string | null }, ctx: GraphQLContext) {
    const newId = uuidv4()
    const now   = new Date().toISOString()
    let sectionCount: number
    const session = getSession(undefined, 'WRITE')
    try {
      await assertReportTemplateAccess(session, args.id, ctx, 'read')
      const sections = await loadTemplateSections(session, args.id, ctx.tenantId)
      sectionCount = sections.length
      // Warm the whitelist cache outside the write tx (createSectionWithNodesEdges validates each section).
      await getReportWhitelist(ctx.tenantId)

      await session.executeWrite(async (tx) => {
        const created = await tx.run(`
          MATCH (src:ReportTemplate {id: $srcId, tenant_id: $tenantId})
          MATCH (u:User {id: $userId, tenant_id: $tenantId})
          CREATE (r:ReportTemplate {
            id:                  $newId,
            tenant_id:           $tenantId,
            name:                coalesce($name, src.name + ' (copia)'),
            description:         src.description,
            icon:                src.icon,
            visibility:          'private',
            created_by:          $userId,
            schedule_enabled:    false,
            schedule_cron:       null,
            schedule_channel_id: null,
            schedule_recipients: [],
            schedule_format:     src.schedule_format,
            created_at:          $now,
            updated_at:          $now
          })
          CREATE (r)-[:CREATED_BY]->(u)
          RETURN r.id AS id
        `, { srcId: args.id, tenantId: ctx.tenantId, userId: ctx.userId, newId, name: args.name ?? null, now })
        if (!created.records.length) throw new NotFoundError('ReportTemplate', args.id)

        for (const sec of sections) {
          // Node ids become temp_id on the clones; edges are re-linked by temp_id.
          await createSectionWithNodesEdges(tx, newId, uuidv4(), sec.order, sec, ctx.tenantId)
        }
      })
    } finally {
      await session.close()
    }

    void audit(ctx, 'report.duplicated', 'ReportTemplate', newId, { sourceTemplateId: args.id, sections: sectionCount })
    return loadFullTemplate(newId, ctx.tenantId)
  },

  async createReportTemplate(
    _: unknown,
    args: { input: {
      name: string; description?: string; icon?: string; visibility: string
      sharedWithTeamIds?: string[]
      scheduleEnabled?: boolean; scheduleCron?: string; scheduleChannelId?: string
    } },
    ctx: GraphQLContext,
  ) {
    requireScheduleChangeRight(ctx, { enabled: false, cron: null, channelId: null }, {
      enabled: args.input.scheduleEnabled ?? false, cron: args.input.scheduleCron ?? null, channelId: args.input.scheduleChannelId ?? null,
    })
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
          MATCH (u:User {id: $userId, tenant_id: $tenantId})
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
              MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
              UNWIND $teamIds AS teamId
              MATCH (t:Team {id: teamId, tenant_id: $tenantId})
              MERGE (r)-[:SHARED_WITH]->(t)
            `, { id, tenantId: ctx.tenantId, teamIds: args.input.sharedWithTeamIds }),
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

  /**
   * A field PRESENT as null clears it, an absent one is left alone — the
   * convention of the other update mutations (review M-9, workflowMutations).
   * `COALESCE($x, r.x)` everywhere meant a description or a Slack channel,
   * once set, could never be removed: the settings form sends null for «no
   * description» and «no channel», and the old value stayed (tour of 23 Sep
   * 2026). Name, visibility and the schedule switch cannot be empty: for
   * them null still keeps the value.
   */
  async updateReportTemplate(
    _: unknown,
    args: { id: string; input: {
      name?: string | null; description?: string | null; icon?: string | null; visibility?: string | null
      sharedWithTeamIds?: string[]
      scheduleEnabled?: boolean | null; scheduleCron?: string | null; scheduleChannelId?: string | null
    } },
    ctx: GraphQLContext,
  ) {
    const given = (field: keyof typeof args.input) => Object.prototype.hasOwnProperty.call(args.input, field)
    const session = getSession(undefined, 'WRITE')
    try {
      await assertReportTemplateAccess(session, args.id, ctx, 'write')
      const stored = await session.executeRead(tx => tx.run(`
        MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
        RETURN coalesce(r.schedule_enabled, false) AS enabled, r.schedule_cron AS cron, r.schedule_channel_id AS channelId
      `, { id: args.id, tenantId: ctx.tenantId }))
      const row = stored.records[0]
      if (!row) throw new NotFoundError('ReportTemplate', args.id)
      const before: EffectiveSchedule = {
        enabled: row.get('enabled') === true, cron: (row.get('cron') as string | null) ?? null, channelId: (row.get('channelId') as string | null) ?? null,
      }
      requireScheduleChangeRight(ctx, before, {
        enabled:   args.input.scheduleEnabled ?? before.enabled,
        cron:      given('scheduleCron') ? args.input.scheduleCron ?? null : before.cron,
        channelId: given('scheduleChannelId') ? args.input.scheduleChannelId ?? null : before.channelId,
      })
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
          SET r.name                = COALESCE($name, r.name),
              r.description         = CASE WHEN $descriptionGiven THEN $description ELSE r.description END,
              r.icon                = CASE WHEN $iconGiven THEN $icon ELSE r.icon END,
              r.visibility          = COALESCE($visibility, r.visibility),
              r.schedule_enabled    = COALESCE($scheduleEnabled, r.schedule_enabled),
              r.schedule_cron       = CASE WHEN $scheduleCronGiven THEN $scheduleCron ELSE r.schedule_cron END,
              r.schedule_channel_id = CASE WHEN $scheduleChannelIdGiven THEN $scheduleChannelId ELSE r.schedule_channel_id END,
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
          descriptionGiven:       given('description'),
          iconGiven:              given('icon'),
          scheduleCronGiven:      given('scheduleCron'),
          scheduleChannelIdGiven: given('scheduleChannelId'),
          now: new Date().toISOString(),
        }),
      )

      if (args.input.sharedWithTeamIds !== undefined) {
        const shareSession = getSession(undefined, 'WRITE')
        try {
          await shareSession.executeWrite(tx =>
            tx.run(`
              MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})-[rel:SHARED_WITH]->()
              DELETE rel
            `, { id: args.id, tenantId: ctx.tenantId }),
          )
          if (args.input.sharedWithTeamIds!.length > 0) {
            await shareSession.executeWrite(tx =>
              tx.run(`
                MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
                UNWIND $teamIds AS teamId
                MATCH (t:Team {id: teamId, tenant_id: $tenantId})
                MERGE (r)-[:SHARED_WITH]->(t)
              `, { id: args.id, tenantId: ctx.tenantId, teamIds: args.input.sharedWithTeamIds }),
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
      await assertReportTemplateAccess(session, args.id, ctx, 'write')
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
      await assertReportTemplateAccess(session, args.templateId, ctx, 'write')
      const orderRes = await session.executeRead(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {id: $templateId, tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection)
          RETURN coalesce(max(s.order), -1) + 1 AS nextOrder
        `, { templateId: args.templateId, tenantId: ctx.tenantId }),
      )
      const order = Math.round(Number(orderRes.records[0]?.get('nextOrder') ?? 0))

      // One transaction: a node or edge that fails leaves no half section behind.
      await session.executeWrite((tx) => createSectionWithNodesEdges(tx, args.templateId, sectionId, order, args.input, ctx.tenantId))
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
          MATCH (r:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
          RETURN r.id AS templateId, s.order AS order
        `, { sectionId: args.sectionId, tenantId: ctx.tenantId }),
      )
      if (!res.records.length) throw new NotFoundError('ReportSection', args.sectionId)
      templateId = res.records[0].get('templateId') as string
      await assertReportTemplateAccess(session, templateId, ctx, 'write')
      const order = Math.round(Number(res.records[0].get('order') ?? 0))

      // Old section out and new one in, in ONE transaction: the new one is
      // validated inside it, so a section that would not build rolls the
      // delete back. Before, the old section was deleted first and an invalid
      // edit left the report without it (review of 23 Sep 2026).
      await session.executeWrite(async (tx) => {
        await tx.run(`
          MATCH (:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          DETACH DELETE s, n
        `, { sectionId: args.sectionId, tenantId: ctx.tenantId })
        await createSectionWithNodesEdges(tx, templateId, args.sectionId, order, args.input, ctx.tenantId)
      })
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
      await assertReportTemplateAccess(session, args.templateId, ctx, 'write')
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (:ReportTemplate {id: $templateId, tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          DETACH DELETE s, n
        `, { sectionId: args.sectionId, templateId: args.templateId, tenantId: ctx.tenantId }),
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
      await assertReportTemplateAccess(session, args.templateId, ctx, 'write')
      for (let i = 0; i < args.sectionIds.length; i++) {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (:ReportTemplate {id: $templateId, tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
            SET s.order = $order
          `, { sectionId: args.sectionIds[i], templateId: args.templateId, tenantId: ctx.tenantId, order: i }),
        )
      }
    } finally {
      await session.close()
    }
    return loadFullTemplate(args.templateId, ctx.tenantId)
  },
}
