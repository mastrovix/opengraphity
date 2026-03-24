import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'

interface TopologyArgs {
  types?:        string[]
  environment?:  string
  status?:       string
  selectedCiId?: string
  maxHops?:      number | null
}

// All known CI labels in Neo4j
const CI_LABELS = [
  'Application', 'Server', 'Database', 'DatabaseInstance',
  'Certificate', 'SslCertificate', 'VirtualMachine', 'NetworkDevice',
  'Storage', 'CloudService', 'ApiEndpoint', 'Microservice',
]

const NODE_LIMIT = 2000
const EDGE_LIMIT = 5000

function labelFromType(t: string): string {
  const map: Record<string, string> = {
    application:        'Application',
    server:             'Server',
    database:           'Database',
    database_instance:  'DatabaseInstance',
    db_instance:        'DatabaseInstance',
    certificate:        'Certificate',
    ssl_certificate:    'SslCertificate',
    virtual_machine:    'VirtualMachine',
    network_device:     'NetworkDevice',
    storage:            'Storage',
    cloud_service:      'CloudService',
    api_endpoint:       'ApiEndpoint',
    microservice:       'Microservice',
  }
  return map[t.toLowerCase()] ?? t
}

function mapNode(r: { get: (k: string) => unknown }) {
  return {
    id:            r.get('id')           as string,
    name:          r.get('name')         as string,
    type:          ciTypeFromLabels([r.get('type') as string]),
    status:        r.get('status')       as string,
    environment:   r.get('environment')  as string | null,
    ownerGroup:    r.get('ownerGroup')   as string | null,
    incidentCount: (r.get('incidentCount') as { toNumber(): number }).toNumber(),
    changeCount:   (r.get('changeCount')   as { toNumber(): number }).toNumber(),
  }
}

export const topologyResolvers = {
  Query: {
    topology: async (
      _: unknown,
      args: TopologyArgs,
      ctx: GraphQLContext,
    ) => {
      const session = getSession(undefined, 'READ')
      try {

        // ── BRANCH A: ego-network from a specific CI ──────────────────────
        if (args.selectedCiId) {
          // Clamp maxHops: null/"tutti" → 10, valid range 1-10
          const depth = args.maxHops == null
            ? 10
            : Math.min(Math.max(Math.floor(args.maxHops), 1), 10)

          const environment = args.environment ?? null
          const status      = args.status      ?? null

          // 1. Collect all reachable CI ids up to requested depth
          //    Origin is always included; neighbors are filtered by env/status if provided
          const reachableResult = await session.executeRead((tx) => tx.run(`
            MATCH (origin)
            WHERE origin.id = $ciId AND origin.tenant_id = $tenantId
              AND ANY(lbl IN labels(origin) WHERE lbl IN $ciLabels)
            CALL apoc.path.subgraphNodes(origin, {
              relationshipFilter: null,
              labelFilter:        '+Application|+Server|+Database|+DatabaseInstance|+Certificate|+SslCertificate|+VirtualMachine|+NetworkDevice|+Storage|+CloudService|+ApiEndpoint|+Microservice',
              maxLevel:           $depth,
              limit:              ${NODE_LIMIT}
            }) YIELD node
            WHERE node.id = $ciId
               OR (($environment IS NULL OR node.environment = $environment)
                   AND ($status IS NULL OR node.status = $status))
            RETURN node.id AS id
          `, { ciId: args.selectedCiId, tenantId: ctx.tenantId, ciLabels: CI_LABELS, depth, environment, status }))

          let nodeIds: string[]
          let truncated = false

          if (reachableResult.records.length > 0) {
            nodeIds = reachableResult.records.map((r) => r.get('id') as string)
            truncated = nodeIds.length >= NODE_LIMIT
          } else {
            // APOC not available — fallback with variable-length path
            const fallbackResult = await session.executeRead((tx) => tx.run(`
              MATCH (origin)
              WHERE origin.id = $ciId AND origin.tenant_id = $tenantId
              MATCH (origin)-[*1..${depth}]-(connected)
              WHERE connected.tenant_id = $tenantId
                AND ANY(lbl IN labels(connected) WHERE lbl IN $ciLabels)
                AND ($environment IS NULL OR connected.environment = $environment)
                AND ($status IS NULL OR connected.status = $status)
              WITH collect(DISTINCT connected.id) + [origin.id] AS ids
              UNWIND ids AS id
              RETURN DISTINCT id
              LIMIT ${NODE_LIMIT}
            `, { ciId: args.selectedCiId, tenantId: ctx.tenantId, ciLabels: CI_LABELS, environment, status }))

            nodeIds = fallbackResult.records.map((r) => r.get('id') as string)
            truncated = nodeIds.length >= NODE_LIMIT
          }

          if (nodeIds.length === 0) return { nodes: [], edges: [], truncated: false }

          // 2. Load full node data with incident/change counts
          //    Re-apply filter here too (origin always passes via ci.id = $ciId exception)
          const nodesResult = await session.executeRead((tx) => tx.run(`
            MATCH (ci)
            WHERE ci.id IN $nodeIds AND ci.tenant_id = $tenantId
              AND (ci.id = $ciId
                OR (($environment IS NULL OR ci.environment = $environment)
                    AND ($status IS NULL OR ci.status = $status)))
            OPTIONAL MATCH (ci)<-[:AFFECTS]-(i:Incident)
              WHERE i.tenant_id = $tenantId
                AND i.status IN ['new', 'assigned', 'in_progress', 'escalated', 'pending']
            OPTIONAL MATCH (ci)<-[:AFFECTS]-(ch:Change)
              WHERE ch.tenant_id = $tenantId
                AND NOT ch.current_step IN ['completed', 'failed', 'rejected']
            WITH ci,
                 count(DISTINCT i)  AS incidentCount,
                 count(DISTINCT ch) AS changeCount
            RETURN
              ci.id          AS id,
              ci.name        AS name,
              labels(ci)[0]  AS type,
              coalesce(ci.status, 'active') AS status,
              ci.environment AS environment,
              ci.owner_group AS ownerGroup,
              incidentCount,
              changeCount
            ORDER BY ci.name
          `, { nodeIds, tenantId: ctx.tenantId, ciId: args.selectedCiId, environment, status }))

          const nodes = nodesResult.records.map(mapNode)

          // 3. Edges between the loaded nodes
          const edgesResult = await session.executeRead((tx) => tx.run(`
            MATCH (a)-[r]->(b)
            WHERE a.id IN $nodeIds AND b.id IN $nodeIds
              AND a.tenant_id = $tenantId
            RETURN DISTINCT a.id AS source, b.id AS target, type(r) AS relType
            LIMIT ${EDGE_LIMIT}
          `, { nodeIds, tenantId: ctx.tenantId }))

          const edges = edgesResult.records.map((r) => ({
            source: r.get('source') as string,
            target: r.get('target') as string,
            type:   r.get('relType') as string,
          }))

          return { nodes, edges, truncated }
        }

        // ── BRANCH B: full topology with type/env/status filters ──────────
        const params: Record<string, unknown> = {
          tenantId: ctx.tenantId,
          ciLabels: args.types && args.types.length > 0
            ? args.types.map(labelFromType)
            : CI_LABELS,
        }

        const extraConditions: string[] = []
        if (args.environment) {
          extraConditions.push('ci.environment = $environment')
          params['environment'] = args.environment
        }
        if (args.status) {
          extraConditions.push('ci.status = $status')
          params['status'] = args.status
        }
        const extraWhere = extraConditions.length > 0
          ? 'AND ' + extraConditions.join(' AND ')
          : ''

        const nodesResult = await session.executeRead((tx) => tx.run(`
          MATCH (ci)
          WHERE ci.tenant_id = $tenantId
            AND ANY(lbl IN labels(ci) WHERE lbl IN $ciLabels)
            ${extraWhere}
          OPTIONAL MATCH (ci)<-[:AFFECTS]-(i:Incident)
            WHERE i.tenant_id = $tenantId
              AND i.status IN ['new', 'assigned', 'in_progress', 'escalated', 'pending']
          OPTIONAL MATCH (ci)<-[:AFFECTS]-(ch:Change)
            WHERE ch.tenant_id = $tenantId
              AND NOT ch.current_step IN ['completed', 'failed', 'rejected']
          WITH ci,
               count(DISTINCT i)  AS incidentCount,
               count(DISTINCT ch) AS changeCount
          RETURN
            ci.id          AS id,
            ci.name        AS name,
            labels(ci)[0]  AS type,
            coalesce(ci.status, 'active') AS status,
            ci.environment AS environment,
            ci.owner_group AS ownerGroup,
            incidentCount,
            changeCount
          ORDER BY ci.name
          LIMIT ${NODE_LIMIT}
        `, params))

        const nodes = nodesResult.records.map(mapNode)
        const truncated = nodes.length >= NODE_LIMIT

        if (nodes.length === 0) return { nodes: [], edges: [], truncated: false }

        const nodeIds = nodes.map((n) => n.id)
        const edgesResult = await session.executeRead((tx) => tx.run(`
          MATCH (a)-[r]->(b)
          WHERE a.tenant_id = $tenantId
            AND b.tenant_id = $tenantId
            AND a.id IN $nodeIds
            AND b.id IN $nodeIds
            AND ANY(lbl IN labels(a) WHERE lbl IN $ciLabels)
            AND ANY(lbl IN labels(b) WHERE lbl IN $ciLabels)
          RETURN a.id AS source, b.id AS target, type(r) AS relType
          LIMIT ${EDGE_LIMIT}
        `, { tenantId: ctx.tenantId, nodeIds, ciLabels: CI_LABELS }))

        const edges = edgesResult.records.map((r) => ({
          source: r.get('source') as string,
          target: r.get('target') as string,
          type:   r.get('relType') as string,
        }))

        return { nodes, edges, truncated }

      } finally {
        await session.close()
      }
    },
  },
}
