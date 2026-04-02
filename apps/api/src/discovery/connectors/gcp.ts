import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── GCP Connector ─────────────────────────────────────────────────────────────
// Discovers Compute Engine instances and Cloud SQL instances.
// Credentials: service_account_json (full JSON key as string).
// Config: project_ids (comma-separated), zones (comma-separated, optional).

type GcpConfig = {
  project_ids: string
  zones?:      string
}

function splitParam(s?: string): string[] {
  if (!s) return []
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

export const gcpConnector: Connector = {
  type:             'gcp',
  displayName:      'Google Cloud Platform',
  supportedCITypes: ['server', 'database', 'database_instance'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg        = config.config as GcpConfig
    const projectIds = splitParam(cfg.project_ids)
    const zoneFilter = splitParam(cfg.zones)

    const serviceAccountJson = creds['service_account_json']
    if (!serviceAccountJson) throw new Error('GCP connector: service_account_json credential is required')

    const keyFile = JSON.parse(serviceAccountJson) as Record<string, unknown>

    const { InstancesClient, ZonesClient }    = await import('@google-cloud/compute')
    const gcpSql = await import('@google-cloud/sql')
    const SqlInstancesServiceClient = (gcpSql as unknown as { SqlInstancesServiceClient: unknown }).SqlInstancesServiceClient ?? gcpSql.default

    for (const projectId of projectIds) {
      // ── Compute Engine Instances ────────────────────────────────────────
      try {
        const instancesClient = new InstancesClient({ credentials: keyFile })
        const zonesClient     = new ZonesClient({ credentials: keyFile })

        // Get all zones for the project
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

      // ── Cloud SQL Instances ──────────────────────────────────────────────
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlClient = new (SqlInstancesServiceClient as any)({ credentials: keyFile })
        const [sqlInstances] = await sqlClient.list({ project: projectId })

        for (const inst of (sqlInstances as unknown[]) ?? []) {
          if (!inst || typeof inst !== 'object') continue
          const sqlInst = inst as Record<string, unknown>
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
              engine:           String(sqlInst['databaseVersion'] ?? '').toLowerCase().includes('postgres') ? 'postgres' : 'mysql',
            },
            tags:          {},
            relationships: [],
          }
        }
      } catch (err) {
        logger.warn({ err, projectId }, '[gcp] Cloud SQL scan error')
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
        name:      'zones',
        label:     'Zones',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of zones (leave empty to scan all zones)',
      },
    ]
  },
}
