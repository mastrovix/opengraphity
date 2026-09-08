import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import {
  connectorError, guardScan, probeConnection,
  requireConfigString, requireCreds, resourceTypeSet, resourceTypesField, tagsToRecord,
} from './base.js'
import { splitList } from './normalize.js'

// ── GCP Connector ─────────────────────────────────────────────────────────────
// Discovers Compute Engine, Cloud SQL, GKE clusters, and forwarding rules (LBs).
// Credentials: service_account_json (full JSON key as string).
// Config: project_ids (comma-sep), zones (comma-sep optional), resource_types (comma-sep).

const TYPE = 'gcp'

type GcpConfig = {
  project_ids:     string
  zones?:          string
  resource_types?: string
}

const ALL_RESOURCE_TYPES = ['compute', 'cloudsql', 'gke', 'lb'] as const

function parseKeyFile(creds: Record<string, string>): Record<string, unknown> {
  requireCreds(TYPE, creds, ['service_account_json'])
  try {
    const parsed = JSON.parse(creds['service_account_json']!) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('deve essere un oggetto JSON')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw connectorError(TYPE, 'service_account_json parse', err)
  }
}

function projectIdsOf(cfg: GcpConfig): string[] {
  const ids = splitList(requireConfigString(TYPE, cfg, 'project_ids'))
  if (!ids.length) throw connectorError(TYPE, 'config', new Error('project_ids non contiene alcun progetto'))
  return ids
}

interface GcpScanContext {
  keyFile:    Record<string, unknown>
  projectId:  string
  /** Empty = all zones. */
  zoneFilter: string[]
}

function base(ctx: GcpScanContext, externalId: string, ciType: string, name: string, properties: Record<string, unknown>): DiscoveredCI {
  return {
    external_id: externalId,
    source:      TYPE,
    ci_type:     ciType,
    name,
    properties:  { ...properties, project_id: ctx.projectId },
    tags:        {},
    relationships: [],
  }
}

/** Last path segment of a GCP resource URL ("…/machineTypes/n1-standard-1" → "n1-standard-1"). */
function lastSegment(url: unknown): string | undefined {
  return typeof url === 'string' ? url.split('/').pop() : undefined
}

// ── Per-resource scanners ─────────────────────────────────────────────────────

async function* scanCompute(ctx: GcpScanContext): AsyncIterable<DiscoveredCI> {
  const { InstancesClient, ZonesClient } = await import('@google-cloud/compute')
  const instancesClient = new InstancesClient({ credentials: ctx.keyFile })
  const zonesClient     = new ZonesClient({ credentials: ctx.keyFile })

  let zones: string[] = ctx.zoneFilter
  if (!zones.length) {
    const [zoneList] = await zonesClient.list({ project: ctx.projectId })
    zones = (zoneList ?? [])
      .map((z: { name?: string | null }) => z.name ?? '')
      .filter((n): n is string => Boolean(n))
  }

  for (const zone of zones) {
    yield* guardScan(TYPE, `Compute instance list (project ${ctx.projectId}, zone ${zone})`, async function* () {
      const [instancesPage] = await instancesClient.list({ project: ctx.projectId, zone })
      const instances = Array.isArray(instancesPage) ? instancesPage : []

      for (const inst of instances) {
        if (!inst.id || !inst.name) continue
        const networkIf = inst.networkInterfaces?.[0]
        yield {
          ...base(ctx, `gce::${ctx.projectId}::${zone}::${inst.id}`, 'server', inst.name, {
            machine_type: lastSegment(inst.machineType),
            zone,
            status:       inst.status,
            private_ip:   networkIf?.networkIP,
            public_ip:    networkIf?.accessConfigs?.[0]?.natIP,
            os_image:     lastSegment((inst.disks?.[0] as { source?: string } | undefined)?.source),
          }),
          tags: tagsToRecord(inst.labels as Record<string, string | null | undefined> | undefined),
        }
      }
    })
  }
}

async function* scanCloudSql(ctx: GcpScanContext): AsyncIterable<DiscoveredCI> {
  const gcpSql = await import('@google-cloud/sql')
  const SqlInstancesServiceClient =
    (gcpSql as unknown as { SqlInstancesServiceClient: unknown }).SqlInstancesServiceClient ?? gcpSql.default

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlClient = new (SqlInstancesServiceClient as any)({ credentials: ctx.keyFile })
  const [sqlInstances] = await sqlClient.list({ project: ctx.projectId })

  for (const inst of (sqlInstances as unknown[]) ?? []) {
    if (!inst || typeof inst !== 'object') continue
    const sqlInst  = inst as Record<string, unknown>
    const instName = sqlInst['name'] as string | undefined
    if (!instName) continue

    const version = String(sqlInst['databaseVersion'] ?? '').toLowerCase()
    yield base(ctx, `cloudsql::${ctx.projectId}::${instName}`, 'database_instance', instName, {
      database_version: sqlInst['databaseVersion'],
      tier:             (sqlInst['settings'] as Record<string, unknown> | undefined)?.['tier'],
      region:           sqlInst['region'],
      state:            sqlInst['state'],
      engine:           version.includes('postgres') ? 'postgres' : 'mysql',
    })
  }
}

async function* scanGke(ctx: GcpScanContext): AsyncIterable<DiscoveredCI> {
  const { ClusterManagerClient } = await import('@google-cloud/container')
  const containerClient = new ClusterManagerClient({ credentials: ctx.keyFile })
  const [clusterResp] = await containerClient.listClusters({ parent: `projects/${ctx.projectId}/locations/-` })

  for (const cluster of clusterResp.clusters ?? []) {
    if (!cluster.name) continue
    const pool      = cluster.nodePools?.[0]
    const nodeCount = pool?.autoscaling?.enabled ? pool.autoscaling.maxNodeCount : (pool?.initialNodeCount ?? 0)

    yield base(ctx, `gke::${ctx.projectId}::${cluster.location}::${cluster.name}`, 'application', cluster.name, {
      cluster_name:       cluster.name,
      node_count:         nodeCount,
      kubernetes_version: cluster.currentMasterVersion,
      location:           cluster.location,
      status:             cluster.status,
      endpoint:           cluster.endpoint,
    })
  }
}

type ForwardingRule = {
  id?: unknown; name?: string | null; IPAddress?: string | null; target?: unknown
  loadBalancingScheme?: string | null; portRange?: string | null
}

function forwardingRuleCI(ctx: GcpScanContext, rule: ForwardingRule, scope: string): DiscoveredCI {
  return base(ctx, `lb::${ctx.projectId}::${scope}::${String(rule.id)}`, 'load_balancer', rule.name!, {
    ip_address: rule.IPAddress,
    target:     lastSegment(rule.target),
    scheme:     rule.loadBalancingScheme,
    port_range: rule.portRange,
    scope,
  })
}

async function* scanLbs(ctx: GcpScanContext): AsyncIterable<DiscoveredCI> {
  const { GlobalForwardingRulesClient, ForwardingRulesClient } = await import('@google-cloud/compute')

  // Global forwarding rules
  const globalClient  = new GlobalForwardingRulesClient({ credentials: ctx.keyFile })
  const [globalRules] = await globalClient.list({ project: ctx.projectId })
  for (const rule of Array.isArray(globalRules) ? globalRules : []) {
    if (!rule.id || !rule.name) continue
    yield forwardingRuleCI(ctx, rule as ForwardingRule, 'global')
  }

  // Regional forwarding rules — only if zones specified (infer regions from zones)
  const regions = [...new Set(ctx.zoneFilter.map(z => z.replace(/-[a-z]$/, '')))]
  if (!regions.length) return

  const regionalClient = new ForwardingRulesClient({ credentials: ctx.keyFile })
  for (const region of regions) {
    yield* guardScan(TYPE, `Regional LB scan (project ${ctx.projectId}, region ${region})`, async function* () {
      const [regRules] = await regionalClient.list({ project: ctx.projectId, region })
      for (const rule of Array.isArray(regRules) ? regRules : []) {
        if (!rule.id || !rule.name) continue
        yield forwardingRuleCI(ctx, rule as ForwardingRule, region)
      }
    })
  }
}

const SCANNERS: Record<typeof ALL_RESOURCE_TYPES[number], { label: string; run: (ctx: GcpScanContext) => AsyncIterable<DiscoveredCI> }> = {
  compute:  { label: 'Compute scan',   run: scanCompute },
  cloudsql: { label: 'Cloud SQL scan', run: scanCloudSql },
  gke:      { label: 'GKE scan',       run: scanGke },
  lb:       { label: 'LB scan',        run: scanLbs },
}

// ── Connector ─────────────────────────────────────────────────────────────────

export const gcpConnector: Connector = {
  type:             TYPE,
  displayName:      'Google Cloud Platform',
  supportedCITypes: ['server', 'database_instance', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg        = config.config as GcpConfig
    const projectIds = projectIdsOf(cfg)
    const zoneFilter = splitList(cfg.zones)
    const types      = resourceTypeSet(TYPE, cfg.resource_types, ALL_RESOURCE_TYPES)
    const keyFile    = parseKeyFile(creds)

    for (const projectId of projectIds) {
      const ctx: GcpScanContext = { keyFile, projectId, zoneFilter }
      for (const type of ALL_RESOURCE_TYPES) {
        if (!types.has(type)) continue
        const { label, run } = SCANNERS[type]
        yield* guardScan(TYPE, `${label} (project ${projectId})`, () => run(ctx))
      }
    }
  },

  testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    return probeConnection('GCP', async () => {
      const projectIds = projectIdsOf(config.config as GcpConfig)
      const keyFile    = parseKeyFile(creds)
      const { ZonesClient } = await import('@google-cloud/compute')
      const zonesClient = new ZonesClient({ credentials: keyFile })
      await zonesClient.list({ project: projectIds[0]!, maxResults: 1 } as unknown as Parameters<typeof zonesClient.list>[0])
      return `Connected to GCP projects: ${projectIds.join(', ')}`
    })
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return [
      {
        name:      'service_account_json',
        label:     'Service Account JSON',
        type:      'password',
        required:  true,
        help_text: 'Paste the full JSON content of your GCP service account key file',
      },
    ]
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'project_ids',
        label:     'Project IDs',
        type:      'text',
        required:  true,
        help_text: 'Comma-separated list of GCP project IDs to scan',
      },
      resourceTypesField(ALL_RESOURCE_TYPES),
      {
        name:      'zones',
        label:     'Zones',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of zones (leave empty to scan all). Also enables regional LB scan.',
      },
    ]
  },
}
