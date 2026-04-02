import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── GCP Connector ─────────────────────────────────────────────────────────────
// Discovers Compute Engine, Cloud SQL, GKE clusters, and forwarding rules (LBs).
// Credentials: service_account_json (full JSON key as string).
// Config: project_ids (comma-sep), zones (comma-sep optional), resource_types (comma-sep).

type GcpConfig = {
  project_ids:     string
  zones?:          string
  resource_types?: string
}

const ALL_RESOURCE_TYPES = ['compute', 'cloudsql', 'gke', 'lb'] as const

function splitParam(s?: string): string[] {
  if (!s) return []
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

function getResourceTypes(config: GcpConfig): Set<string> {
  const raw = config.resource_types
  if (!raw) return new Set(ALL_RESOURCE_TYPES)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

export const gcpConnector: Connector = {
  type:             'gcp',
  displayName:      'Google Cloud Platform',
  supportedCITypes: ['server', 'database_instance', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg        = config.config as GcpConfig
    const projectIds = splitParam(cfg.project_ids)
    const zoneFilter = splitParam(cfg.zones)
    const types      = getResourceTypes(cfg)

    const serviceAccountJson = creds['service_account_json']
    if (!serviceAccountJson) throw new Error('GCP connector: service_account_json credential is required')

    const keyFile = JSON.parse(serviceAccountJson) as Record<string, unknown>

    for (const projectId of projectIds) {
      // ── Compute Engine Instances ──────────────────────────────────────
      if (types.has('compute')) {
        try {
          const { InstancesClient, ZonesClient } = await import('@google-cloud/compute')
          const instancesClient = new InstancesClient({ credentials: keyFile })
          const zonesClient     = new ZonesClient({ credentials: keyFile })

          let zones: string[] = zoneFilter
          if (!zones.length) {
            const [zoneList] = await zonesClient.list({ project: projectId })
            zones = (zoneList ?? [])
              .map((z: { name?: string | null }) => z.name ?? '')
              .filter((n): n is string => Boolean(n))
          }

          for (const zone of zones) {
            try {
              const [instancesPage] = await instancesClient.list({ project: projectId, zone })
              const instances = Array.isArray(instancesPage) ? instancesPage : []

              for (const inst of instances) {
                if (!inst.id || !inst.name) continue

                const tags: Record<string, string> = {}
                for (const [k, v] of Object.entries(inst.labels ?? {})) {
                  tags[k] = v as string
                }

                const networkIf = inst.networkInterfaces?.[0]
                const privateIp = networkIf?.networkIP
                const publicIp  = networkIf?.accessConfigs?.[0]?.natIP

                yield {
                  external_id: `gce::${projectId}::${zone}::${inst.id}`,
                  source:      'gcp',
                  ci_type:     'server',
                  name:        inst.name,
                  properties:  {
                    machine_type: (inst.machineType as string | undefined)?.split('/').pop(),
                    zone,
                    project_id:  projectId,
                    status:      inst.status,
                    private_ip:  privateIp,
                    public_ip:   publicIp,
                    os_image:    (inst.disks?.[0] as { source?: string } | undefined)?.source?.split('/').pop(),
                  },
                  tags,
                  relationships: [],
                }
              }
            } catch (err) {
              logger.debug({ err, zone, projectId }, '[gcp] Zone scan skip')
            }
          }
        } catch (err) {
          logger.warn({ err, projectId }, '[gcp] Compute scan error')
        }
      }

      // ── Cloud SQL Instances ───────────────────────────────────────────
      if (types.has('cloudsql')) {
        try {
          const gcpSql = await import('@google-cloud/sql')
          const SqlInstancesServiceClient =
            (gcpSql as unknown as { SqlInstancesServiceClient: unknown }).SqlInstancesServiceClient ?? gcpSql.default

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sqlClient  = new (SqlInstancesServiceClient as any)({ credentials: keyFile })
          const [sqlInstances] = await sqlClient.list({ project: projectId })

          for (const inst of (sqlInstances as unknown[]) ?? []) {
            if (!inst || typeof inst !== 'object') continue
            const sqlInst  = inst as Record<string, unknown>
            const instName = sqlInst['name'] as string | undefined
            if (!instName) continue

            yield {
              external_id: `cloudsql::${projectId}::${instName}`,
              source:      'gcp',
              ci_type:     'database_instance',
              name:        instName,
              properties:  {
                database_version: sqlInst['databaseVersion'],
                tier:             (sqlInst['settings'] as Record<string, unknown> | undefined)?.['tier'],
                region:           sqlInst['region'],
                project_id:       projectId,
                state:            sqlInst['state'],
                engine: String(sqlInst['databaseVersion'] ?? '').toLowerCase().includes('postgres')
                  ? 'postgres'
                  : 'mysql',
              },
              tags:          {},
              relationships: [],
            }
          }
        } catch (err) {
          logger.warn({ err, projectId }, '[gcp] Cloud SQL scan error')
        }
      }

      // ── GKE Clusters ─────────────────────────────────────────────────
      if (types.has('gke')) {
        try {
          const { ClusterManagerClient } = await import('@google-cloud/container')
          const containerClient = new ClusterManagerClient({ credentials: keyFile })

          const [clusterResp] = await containerClient.listClusters({ parent: `projects/${projectId}/locations/-` })

          for (const cluster of clusterResp.clusters ?? []) {
            if (!cluster.name) continue

            const pool       = cluster.nodePools?.[0]
            const nodeCount  = pool?.autoscaling?.enabled
              ? pool.autoscaling.maxNodeCount
              : (pool?.initialNodeCount ?? 0)

            yield {
              external_id: `gke::${projectId}::${cluster.location}::${cluster.name}`,
              source:      'gcp',
              ci_type:     'application',
              name:        cluster.name,
              properties:  {
                cluster_name:        cluster.name,
                node_count:          nodeCount,
                kubernetes_version:  cluster.currentMasterVersion,
                location:            cluster.location,
                status:              cluster.status,
                endpoint:            cluster.endpoint,
                project_id:          projectId,
              },
              tags:          {},
              relationships: [],
            }
          }
        } catch (err) {
          logger.warn({ err, projectId }, '[gcp] GKE scan error')
        }
      }

      // ── Load Balancers (Forwarding Rules) ────────────────────────────
      if (types.has('lb')) {
        try {
          const { GlobalForwardingRulesClient, ForwardingRulesClient } = await import('@google-cloud/compute')

          // Global forwarding rules
          const globalClient = new GlobalForwardingRulesClient({ credentials: keyFile })
          const [globalRules] = await globalClient.list({ project: projectId })

          for (const rule of Array.isArray(globalRules) ? globalRules : []) {
            if (!rule.id || !rule.name) continue
            yield {
              external_id: `lb::${projectId}::global::${rule.id}`,
              source:      'gcp',
              ci_type:     'load_balancer',
              name:        rule.name,
              properties:  {
                ip_address:  rule.IPAddress,
                target:      (rule.target as string | undefined)?.split('/').pop(),
                scheme:      rule.loadBalancingScheme,
                port_range:  rule.portRange,
                project_id:  projectId,
                scope:       'global',
              },
              tags:          {},
              relationships: [],
            }
          }

          // Regional forwarding rules — only if zones specified (infer regions from zones)
          const regions = zoneFilter.length
            ? [...new Set(zoneFilter.map(z => z.replace(/-[a-z]$/, '')))]
            : []

          if (regions.length) {
            const regionalClient = new ForwardingRulesClient({ credentials: keyFile })
            for (const region of regions) {
              try {
                const [regRules] = await regionalClient.list({ project: projectId, region })
                for (const rule of Array.isArray(regRules) ? regRules : []) {
                  if (!rule.id || !rule.name) continue
                  yield {
                    external_id: `lb::${projectId}::${region}::${rule.id}`,
                    source:      'gcp',
                    ci_type:     'load_balancer',
                    name:        rule.name,
                    properties:  {
                      ip_address:  rule.IPAddress,
                      target:      (rule.target as string | undefined)?.split('/').pop(),
                      scheme:      rule.loadBalancingScheme,
                      port_range:  rule.portRange,
                      project_id:  projectId,
                      scope:       region,
                    },
                    tags:          {},
                    relationships: [],
                  }
                }
              } catch (err) {
                logger.debug({ err, region }, '[gcp] Regional LB scan skip')
              }
            }
          }
        } catch (err) {
          logger.warn({ err, projectId }, '[gcp] LB scan error')
        }
      }
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg        = config.config as GcpConfig
      const projectIds = splitParam(cfg.project_ids)
      if (!projectIds.length) return { ok: false, message: 'No project_ids configured' }

      const keyFile = JSON.parse(creds['service_account_json'] ?? '{}') as Record<string, unknown>
      const { ZonesClient } = await import('@google-cloud/compute')

      const zonesClient = new ZonesClient({ credentials: keyFile })
      await zonesClient.list({ project: projectIds[0]!, maxResults: 1 } as unknown as Parameters<typeof zonesClient.list>[0])

      return { ok: true, message: `Connected to GCP projects: ${projectIds.join(', ')}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `GCP connection failed: ${msg}` }
    }
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
      {
        name:          'resource_types',
        label:         'Resource Types',
        type:          'text',
        required:      false,
        default_value: ALL_RESOURCE_TYPES.join(', '),
        help_text:     'Comma-separated: compute, cloudsql, gke, lb (leave empty for all)',
      },
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
