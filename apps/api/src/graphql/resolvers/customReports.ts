import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { Session, ManagedTransaction } from 'neo4j-driver'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { getNavigableEntities, getNavigableRelations } from '../../lib/navigableGraph.js'
import type { NavigableEntity } from '../../lib/navigableGraph.js'
import { executeReportSection } from '../../lib/reportExecutor.js'
import { validateReportSection, type ReportSectionDef } from '../../lib/reportQueryBuilder.js'
import { loadTemplateSections } from '../../lib/reportTemplates.js'
import { getReportWhitelist, STATIC_REPORT_LABELS } from '../../lib/reportWhitelist.js'
import { assertReportTemplateAccess } from './reportAccess.js'
import { withSession } from './ci-utils.js'

/**
 * Allowed Neo4j node labels that can be used in reachableEntities queries.
 * Same static set the report builder whitelist is built from (single source).
 */
const ALLOWED_NEO4J_LABELS: ReadonlySet<string> = new Set(STATIC_REPORT_LABELS)

type Props = Record<string, unknown>

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapTemplate(p: Props) {
  return {
    id:               p['id']                as string,
    name:             p['name']              as string,
    description:      p['description']       as string | null ?? null,
    icon:             p['icon']              as string | null ?? null,
    visibility:       p['visibility']        as string,
    scheduleEnabled:    (p['schedule_enabled']    as boolean) ?? false,
    scheduleCron:        p['schedule_cron']         as string | null ?? null,
    scheduleChannelId:   p['schedule_channel_id']   as string | null ?? null,
    scheduleRecipients: (p['schedule_recipients']   as string[] | null) ?? [],
    scheduleFormat:      p['schedule_format']       as string | null ?? null,
    lastScheduledRun:    p['last_scheduled_run']    as string | null ?? null,
    createdAt:           p['created_at']            as string,
    updatedAt:           p['updated_at']            as string | null ?? null,
  }
}

// ── Load full template (with sections + nodes + edges) ──────────────────────

export async function loadFullTemplate(id: string, tenantId: string) {
  const session = getSession(undefined, 'READ')
  try {
    const tplRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
        RETURN properties(r) AS props
      `, { id, tenantId }),
    )
    if (!tplRes.records.length) return null

    const tpl = mapTemplate(tplRes.records[0].get('props') as Props)

    // Sections + nodes + edges: the single shared loader (lib/reportTemplates).
    const sections: ReportSectionDef[] = await loadTemplateSections(session, id, tenantId)

    // sharedWith teams
    const teamRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})-[:SHARED_WITH]->(t:Team)
        RETURN properties(t) AS props ORDER BY t.name
      `, { id, tenantId }),
    )
    const sharedWith = teamRes.records.map(tr => {
      const p = tr.get('props') as Props
      return { id: p['id'] as string, name: p['name'] as string }
    })

    // createdBy user
    const userRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})-[:CREATED_BY]->(u:User)
        RETURN properties(u) AS props LIMIT 1
      `, { id, tenantId }),
    )
    const createdBy = userRes.records.length
      ? (() => {
          const p = userRes.records[0].get('props') as Props
          return { id: p['id'] as string, name: p['name'] as string, email: p['email'] as string }
        })()
      : null

    return { ...tpl, sections, sharedWith, createdBy }
  } finally {
    await session.close()
  }
}

// ── Section input type ────────────────────────────────────────────────────────

export interface SectionInput {
  title:         string
  chartType:     string
  groupByNodeId?: string | null
  groupByField?:  string | null
  metric:        string
  metricField?:  string | null
  limit?:        number | null
  sortDir?:      string | null
  nodes: Array<{
    id: string; entityType: string; neo4jLabel: string; label: string
    isResult: boolean; isRoot: boolean; positionX: number; positionY: number
    filters?: string | null; selectedFields?: string[]
  }>
  edges: Array<{
    id: string; sourceNodeId: string; targetNodeId: string
    relationshipType: string; direction: string; label: string
  }>
}

/** Converts a GraphQL SectionInput into the builder's ReportSectionDef shape. */
export function sectionInputToDef(input: SectionInput, id: string, order = 0): ReportSectionDef {
  return {
    id,
    order,
    title:         input.title,
    chartType:     input.chartType,
    groupByNodeId: input.groupByNodeId ?? null,
    groupByField:  input.groupByField ?? null,
    metric:        input.metric,
    metricField:   input.metricField ?? null,
    limit:         input.limit ?? null,
    sortDir:       input.sortDir ?? null,
    nodes: (input.nodes ?? []).map(n => ({
      id: n.id, entityType: n.entityType, neo4jLabel: n.neo4jLabel,
      label: n.label, isResult: n.isResult, isRoot: n.isRoot,
      positionX: n.positionX, positionY: n.positionY,
      filters: n.filters ?? null, selectedFields: n.selectedFields ?? [],
    })),
    edges: (input.edges ?? []).map(e => ({
      id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
      relationshipType: e.relationshipType, direction: e.direction, label: e.label,
    })),
  }
}

// ── Create section helper ─────────────────────────────────────────────────────

type WriteRunner = Session | ManagedTransaction

/**
 * Runs a write statement either as its own managed transaction (Session) or
 * inside the caller's transaction (ManagedTransaction) — the latter lets
 * duplicateReportTemplate clone template + sections + nodes + edges atomically.
 */
async function write(runner: WriteRunner, query: string, params: Record<string, unknown>) {
  if (typeof (runner as Session).executeWrite === 'function') {
    return (runner as Session).executeWrite(tx => tx.run(query, params))
  }
  return (runner as ManagedTransaction).run(query, params)
}

export async function createSectionWithNodesEdges(
  runner: WriteRunner,
  templateId: string,
  sectionId: string,
  order: number,
  input: SectionInput,
  tenantId: string,
) {
  // Fail-fast at persistence: a section that would not build must never be
  // stored, otherwise the scheduler/dashboards would execute it without a user.
  validateReportSection(sectionInputToDef(input, sectionId, order), await getReportWhitelist(tenantId))

  await write(runner, `
      MATCH (r:ReportTemplate {id: $templateId, tenant_id: $tenantId})
      CREATE (s:ReportSection {
        id:                $id,
        template_id:       $templateId,
        order:             $order,
        title:             $title,
        chart_type:        $chartType,
        group_by_node_id:  $groupByNodeId,
        group_by_field:    $groupByField,
        metric:            $metric,
        metric_field:      $metricField,
        limit_val:         $limit,
        sort_dir:          $sortDir
      })
      CREATE (r)-[:HAS_SECTION]->(s)
    `, {
      id: sectionId, templateId, tenantId, order,
      title: input.title, chartType: input.chartType,
      groupByNodeId: input.groupByNodeId ?? null,
      groupByField:  input.groupByField ?? null,
      metric: input.metric,
      metricField: input.metricField ?? null,
      limit: input.limit ?? null, sortDir: input.sortDir ?? null,
    })

  // Create nodes
  for (const node of input.nodes) {
    const nodeId = uuidv4()
    await write(runner, `
      MATCH (:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
      CREATE (s)-[:HAS_NODE]->(n:ReportNode {
        id:             $id,
        temp_id:        $tempId,
        section_id:     $sectionId,
        entity_type:    $entityType,
        neo4j_label:    $neo4jLabel,
        label:          $label,
        is_result:      $isResult,
        is_root:        $isRoot,
        position_x:     $positionX,
        position_y:     $positionY,
        filters:        $filters,
        selected_fields: $selectedFields
      })
    `, {
      sectionId, tenantId, id: nodeId, tempId: node.id,
      entityType: node.entityType, neo4jLabel: node.neo4jLabel,
      label: node.label, isResult: node.isResult, isRoot: node.isRoot,
      positionX: node.positionX, positionY: node.positionY,
      filters: node.filters ?? null,
      selectedFields: JSON.stringify(node.selectedFields ?? []),
    })
  }

  // Create edges
  for (const edge of input.edges) {
    await write(runner, `
      MATCH (src:ReportNode {temp_id: $sourceTempId, section_id: $sectionId})
      MATCH (tgt:ReportNode {temp_id: $targetTempId, section_id: $sectionId})
      CREATE (src)-[:REPORT_EDGE {
        id: randomUUID(),
        relationship_type: $relType,
        direction: $direction,
        label: $label
      }]->(tgt)
    `, {
      sectionId,
      sourceTempId: edge.sourceNodeId,
      targetTempId: edge.targetNodeId,
      relType: edge.relationshipType,
      direction: edge.direction,
      label: edge.label,
    })
  }
}

// ── Query resolvers ────────────────────────────────────────────────────────────

const Query = {
  async reportTemplates(_: unknown, __: unknown, ctx: GraphQLContext) {
    const session = getSession(undefined, 'READ')
    try {
      const res = await session.executeRead(tx =>
        tx.run(`
          MATCH (r:ReportTemplate {tenant_id: $tenantId})
          WHERE r.visibility = 'all'
            OR r.created_by = $userId
            OR (r.visibility = 'groups' AND EXISTS {
              MATCH (r)-[:SHARED_WITH]->(t:Team)<-[:MEMBER_OF]-(u:User {id: $userId})
            })
          RETURN properties(r) AS props ORDER BY r.created_at DESC
        `, { tenantId: ctx.tenantId, userId: ctx.userId }),
      )
      return Promise.all(
        res.records.map(r =>
          loadFullTemplate((r.get('props') as Props)['id'] as string, ctx.tenantId),
        ),
      )
    } finally {
      await session.close()
    }
  },

  async reportTemplate(_: unknown, args: { id: string }, ctx: GraphQLContext) {
    await withSession(s => assertReportTemplateAccess(s, args.id, ctx, 'read'))
    return loadFullTemplate(args.id, ctx.tenantId)
  },

  async navigableEntities(_: unknown, __: unknown, ctx: GraphQLContext) {
    return getNavigableEntities(ctx.tenantId)
  },

  async navigableRelations(
    _: unknown,
    args: { entityType: string; neo4jLabel: string },
    ctx: GraphQLContext,
  ) {
    return getNavigableRelations(args.entityType, args.neo4jLabel, ctx.tenantId)
  },

  async reachableEntities(
    _: unknown,
    args: { fromNeo4jLabel: string },
    ctx: GraphQLContext,
  ) {
    const { fromNeo4jLabel } = args

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fromNeo4jLabel)) {
      throw new GraphQLError('Invalid Neo4j label')
    }

    // Also allow dynamic CI type labels loaded from the metamodel
    const navigableEntities = await getNavigableEntities(ctx.tenantId)
    const dynamicLabels = new Set(navigableEntities.map(e => e.neo4jLabel))
    if (!ALLOWED_NEO4J_LABELS.has(fromNeo4jLabel) && !dynamicLabels.has(fromNeo4jLabel)) {
      throw new GraphQLError(`Invalid entity type: ${fromNeo4jLabel}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }

    const session = getSession(undefined, 'READ')
    try {
      const result = await session.executeRead(tx =>
        tx.run(`
          MATCH (n:${fromNeo4jLabel} {tenant_id: $tenantId})
          CALL {
            WITH n
            MATCH (n)-[r]->(d)
            RETURN type(r) AS relType, head([l IN labels(d) WHERE l <> 'ConfigurationItem']) AS targetLabel, 'outgoing' AS direction
            UNION
            WITH n
            MATCH (n)<-[r]-(d)
            RETURN type(r) AS relType, head([l IN labels(d) WHERE l <> 'ConfigurationItem']) AS targetLabel, 'incoming' AS direction
          }
          RETURN DISTINCT relType, targetLabel, direction, count(*) AS cnt
          ORDER BY cnt DESC
        `, { tenantId: ctx.tenantId }),
      )

      const allEntities = navigableEntities
      const allFixed: NavigableEntity[] = [
        { entityType: 'Incident', label: 'Incident', neo4jLabel: 'Incident', fields: [], relations: [] },
        { entityType: 'Change',   label: 'Change',   neo4jLabel: 'Change',   fields: [], relations: [] },
        { entityType: 'Team',     label: 'Team',     neo4jLabel: 'Team',     fields: [], relations: [] },
        { entityType: 'User',     label: 'User',     neo4jLabel: 'User',     fields: [], relations: [] },
      ]

      return result.records
        .map(r => ({
          neo4jLabel:       r.get('targetLabel') as string,
          relType:          r.get('relType')     as string,
          direction:        r.get('direction')   as string,
          cnt:              (r.get('cnt') as { toNumber?: () => number } | number),
        }))
        .filter(r => r.neo4jLabel)
        .map(r => {
          const count = typeof r.cnt === 'object' && r.cnt && 'toNumber' in r.cnt
            ? r.cnt.toNumber!()
            : Number(r.cnt)
          const found = allEntities.find(e => e.neo4jLabel === r.neo4jLabel || e.entityType === r.neo4jLabel)
          const fixed = allFixed.find(e => e.neo4jLabel === r.neo4jLabel || e.entityType === r.neo4jLabel)
          const base  = found ?? fixed ?? { entityType: r.neo4jLabel, label: r.neo4jLabel, neo4jLabel: r.neo4jLabel, fields: [], relations: [] }
          return {
            entityType:       base.entityType,
            label:            base.label,
            neo4jLabel:       base.neo4jLabel,
            fields:           base.fields,
            relationshipType: r.relType,
            direction:        r.direction,
            count,
          }
        })
    } finally {
      await session.close()
    }
  },

  async executeReport(_: unknown, args: { templateId: string }, ctx: GraphQLContext) {
    await withSession(s => assertReportTemplateAccess(s, args.templateId, ctx, 'read'))
    const template = await loadFullTemplate(args.templateId, ctx.tenantId)
    if (!template) throw new NotFoundError('ReportTemplate', args.templateId)

    const results = await Promise.all(
      template.sections.map(sec => executeReportSection(sec, ctx.tenantId)),
    )
    return { sections: results }
  },

  async previewReportSection(
    _: unknown,
    args: { input: SectionInput },
    ctx: GraphQLContext,
  ) {
    // Identifiers are validated inside executeReportSection (buildReportQuery)
    // against the tenant whitelist; a rejected preview surfaces as section error.
    return executeReportSection(sectionInputToDef(args.input, 'preview'), ctx.tenantId)
  },
}

// ── Import Mutation from reportMutations.ts ───────────────────────────────────
import { Mutation as ReportMutation } from './reportMutations.js'

async function updateReportSchedule(
  _: unknown,
  args: {
    templateId: string
    enabled:    boolean
    cron?:       string | null
    recipients?: string[] | null
    format?:     string | null
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await assertReportTemplateAccess(session, args.templateId, ctx, 'write')
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
         SET r.schedule_enabled    = $enabled,
             r.schedule_cron       = $cron,
             r.schedule_recipients = $recipients,
             r.schedule_format     = $format,
             r.updated_at          = $now
         RETURN properties(r) AS p`,
        {
          id: args.templateId, tenantId: ctx.tenantId,
          enabled:    args.enabled,
          cron:       args.cron       ?? null,
          recipients: args.recipients ?? [],
          format:     args.format     ?? 'pdf',
          now,
        },
      ),
    )
    if (!result.records.length) throw new GraphQLError('Template non trovato', { extensions: { code: 'NOT_FOUND' } })
    return mapTemplate(result.records[0].get('p') as Props)
  }, true)
}

const Mutation = { ...ReportMutation, updateReportSchedule }

export const customReportResolvers = { Query, Mutation }
