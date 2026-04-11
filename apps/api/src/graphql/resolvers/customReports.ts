import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { getNavigableEntities, getNavigableRelations } from '../../lib/navigableGraph.js'
import type { NavigableEntity } from '../../lib/navigableGraph.js'
import { executeReportSection } from '../../lib/reportExecutor.js'
import type { ReportSectionDef } from '../../lib/reportQueryBuilder.js'

/**
 * Allowed Neo4j node labels that can be used in reachableEntities queries.
 * This whitelist prevents Cypher label injection from user-supplied input.
 */
const ALLOWED_NEO4J_LABELS = new Set([
  'ConfigurationItem',
  'Application',
  'Server',
  'Database',
  'DatabaseInstance',
  'Certificate',
  'Incident',
  'Change',
  'Problem',
  'ServiceRequest',
  'Team',
  'User',
  'WorkflowDefinition',
  'WorkflowInstance',
  'ReportTemplate',
])

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

function mapSection(p: Props): ReportSectionDef {
  return {
    id:            p['id']               as string,
    order:         Math.round(Number(p['order'] ?? 0)),
    title:         p['title']            as string,
    chartType:     p['chart_type']       as string,
    groupByNodeId: p['group_by_node_id'] as string | null ?? null,
    groupByField:  p['group_by_field']   as string | null ?? null,
    metric:        p['metric']           as string,
    metricField:   p['metric_field']     as string | null ?? null,
    limit:         p['limit_val']        as number | null ?? null,
    sortDir:       p['sort_dir']         as string | null ?? null,
    nodes:         [],
    edges:         [],
  }
}

function mapNode(p: Props) {
  return {
    id:             p['id']             as string,
    entityType:     p['entity_type']    as string,
    neo4jLabel:     p['neo4j_label']    as string,
    label:          p['label']          as string,
    isResult:       (p['is_result']     as boolean) ?? false,
    isRoot:         (p['is_root']       as boolean) ?? false,
    positionX:      Number(p['position_x'] ?? 0),
    positionY:      Number(p['position_y'] ?? 0),
    filters:        p['filters']        as string | null ?? null,
    selectedFields: p['selected_fields']
      ? JSON.parse(p['selected_fields'] as string) as string[]
      : [],
  }
}

function mapEdge(eProps: Props, sourceId: string, targetId: string) {
  return {
    id:               eProps['id']                as string,
    sourceNodeId:     sourceId,
    targetNodeId:     targetId,
    relationshipType: eProps['relationship_type'] as string,
    direction:        eProps['direction']         as string,
    label:            eProps['label']             as string,
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

    // Sections
    const secRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id})-[:HAS_SECTION]->(s:ReportSection)
        RETURN properties(s) AS props ORDER BY s.order ASC
      `, { id }),
    )
    const sections: ReportSectionDef[] = []

    for (const secRow of secRes.records) {
      const sec = mapSection(secRow.get('props') as Props)

      // Nodes and edges
      const nodeEdgeRes = await session.executeRead(tx =>
        tx.run(`
          MATCH (s:ReportSection {id: $sectionId})
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          OPTIONAL MATCH (n)-[e:REPORT_EDGE]->(m:ReportNode)
            WHERE (s)-[:HAS_NODE]->(m)
          RETURN
            collect(DISTINCT properties(n)) AS nodes,
            collect(DISTINCT {
              edgeProps: properties(e),
              sourceId: n.id,
              targetId: m.id
            }) AS edges
        `, { sectionId: sec.id }),
      )

      if (nodeEdgeRes.records.length) {
        const row = nodeEdgeRes.records[0]
        const rawNodes = row.get('nodes') as Props[]
        const rawEdges = row.get('edges') as Array<{ edgeProps: Props; sourceId: string; targetId: string }>

        sec.nodes = rawNodes.filter(n => n && n['id']).map(n => mapNode(n))
        sec.edges = rawEdges
          .filter(e => e && e.edgeProps && e.edgeProps['id'] && e.sourceId && e.targetId)
          .map(e => mapEdge(e.edgeProps, e.sourceId, e.targetId))
      }

      sections.push(sec)
    }

    // sharedWith teams
    const teamRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id})-[:SHARED_WITH]->(t:Team)
        RETURN properties(t) AS props ORDER BY t.name
      `, { id }),
    )
    const sharedWith = teamRes.records.map(tr => {
      const p = tr.get('props') as Props
      return { id: p['id'] as string, name: p['name'] as string }
    })

    // createdBy user
    const userRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id})-[:CREATED_BY]->(u:User)
        RETURN properties(u) AS props LIMIT 1
      `, { id }),
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

// ── Create section helper ─────────────────────────────────────────────────────

export async function createSectionWithNodesEdges(
  session: ReturnType<typeof getSession>,
  templateId: string,
  sectionId: string,
  order: number,
  input: SectionInput,
) {
  await session.executeWrite(tx =>
    tx.run(`
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
      WITH s
      MATCH (r:ReportTemplate {id: $templateId})
      CREATE (r)-[:HAS_SECTION]->(s)
    `, {
      id: sectionId, templateId, order,
      title: input.title, chartType: input.chartType,
      groupByNodeId: input.groupByNodeId ?? null,
      groupByField:  input.groupByField ?? null,
      metric: input.metric,
      metricField: input.metricField ?? null,
      limit: input.limit ?? null, sortDir: input.sortDir ?? null,
    }),
  )

  // Create nodes
  for (const node of input.nodes) {
    const nodeId = uuidv4()
    await session.executeWrite(tx => tx.run(`
      MATCH (s:ReportSection {id: $sectionId})
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
      sectionId, id: nodeId, tempId: node.id,
      entityType: node.entityType, neo4jLabel: node.neo4jLabel,
      label: node.label, isResult: node.isResult, isRoot: node.isRoot,
      positionX: node.positionX, positionY: node.positionY,
      filters: node.filters ?? null,
      selectedFields: JSON.stringify(node.selectedFields ?? []),
    }))
  }

  // Create edges
  for (const edge of input.edges) {
    await session.executeWrite(tx => tx.run(`
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
    }))
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
            RETURN type(r) AS relType, labels(d)[0] AS targetLabel, 'outgoing' AS direction
            UNION
            WITH n
            MATCH (n)<-[r]-(d)
            RETURN type(r) AS relType, labels(d)[0] AS targetLabel, 'incoming' AS direction
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
    const sec: ReportSectionDef = {
      id:            'preview',
      order:         0,
      title:         args.input.title,
      chartType:     args.input.chartType,
      groupByNodeId: args.input.groupByNodeId ?? null,
      groupByField:  args.input.groupByField ?? null,
      metric:        args.input.metric,
      metricField:   args.input.metricField ?? null,
      limit:         args.input.limit ?? null,
      sortDir:       args.input.sortDir ?? null,
      nodes: (args.input.nodes ?? []).map(n => ({
        id: n.id, entityType: n.entityType, neo4jLabel: n.neo4jLabel,
        label: n.label, isResult: n.isResult, isRoot: n.isRoot,
        positionX: n.positionX, positionY: n.positionY,
        filters: n.filters ?? null, selectedFields: n.selectedFields ?? [],
      })),
      edges: (args.input.edges ?? []).map(e => ({
        id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
        relationshipType: e.relationshipType, direction: e.direction, label: e.label,
      })),
    }
    return executeReportSection(sec, ctx.tenantId)
  },
}

// ── Import Mutation from reportMutations.ts ───────────────────────────────────
import { Mutation as ReportMutation } from './reportMutations.js'
import { withSession } from './ci-utils.js'

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
    if (!result.records.length) throw new Error('Template non trovato')
    return mapTemplate(result.records[0].get('p') as Props)
  }, true)
}

const Mutation = { ...ReportMutation, updateReportSchedule }

export const customReportResolvers = { Query, Mutation }
