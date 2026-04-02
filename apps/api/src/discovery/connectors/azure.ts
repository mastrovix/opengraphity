import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── Azure Connector ───────────────────────────────────────────────────────────
// Discovers VMs, SQL databases, AKS clusters, and Load Balancers.
// Credentials: tenant_id, client_id, client_secret.
// Config: subscription_id, resource_groups (comma-sep), resource_types (comma-sep).

type AzureConfig = {
  subscription_id:  string
  resource_groups?: string
  resource_types?:  string
}

const ALL_RESOURCE_TYPES = ['vm', 'sql', 'aks', 'lb'] as const

function parseResourceGroups(rg?: string): string[] {
  if (!rg) return []
  return rg.split(',').map(s => s.trim()).filter(Boolean)
}

function getResourceTypes(config: AzureConfig): Set<string> {
  const raw = config.resource_types
  if (!raw) return new Set(ALL_RESOURCE_TYPES)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

function rgFromId(id: string): string {
  return id.split('/')[4] ?? ''
}

export const azureConnector: Connector = {
  type:             'azure',
  displayName:      'Microsoft Azure',
  supportedCITypes: ['server', 'database_instance', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg            = config.config as AzureConfig
    const subscriptionId = cfg.subscription_id
    const rgFilter       = parseResourceGroups(cfg.resource_groups)
    const types          = getResourceTypes(cfg)

    const { ClientSecretCredential } = await import('@azure/identity')
    const credential = new ClientSecretCredential(
      creds['tenant_id']!,
      creds['client_id']!,
      creds['client_secret']!,
    )

    // ── Virtual Machines ─────────────────────────────────────────────────
    if (types.has('vm')) {
      try {
        const { ComputeManagementClient } = await import('@azure/arm-compute')
        const computeClient = new ComputeManagementClient(credential, subscriptionId)

        for await (const vm of computeClient.virtualMachines.listAll()) {
          if (!vm.id || !vm.name) continue

          const rg = rgFromId(vm.id)
          if (rgFilter.length && !rgFilter.includes(rg)) continue

          const tags: Record<string, string> = {}
          for (const [k, v] of Object.entries(vm.tags ?? {})) {
            if (v) tags[k] = v
          }

          yield {
            external_id: vm.id,
            source:      'azure',
            ci_type:     'server',
            name:        vm.name,
            properties:  {
              vm_size:         vm.hardwareProfile?.vmSize,
              os_type:         vm.storageProfile?.osDisk?.osType,
              location:        vm.location,
              resource_group:  rg,
              provisioning:    vm.provisioningState,
              subscription_id: subscriptionId,
            },
            tags,
            relationships: [],
          }
        }
      } catch (err) {
        logger.warn({ err }, '[azure] VM scan error')
      }
    }

    // ── SQL Servers & Databases ─────────────────────────────────────────
    if (types.has('sql')) {
      try {
        const { SqlManagementClient } = await import('@azure/arm-sql')
        const sqlClient = new SqlManagementClient(credential, subscriptionId)

        for await (const server of sqlClient.servers.list()) {
          if (!server.id || !server.name) continue

          const rg = rgFromId(server.id)
          if (rgFilter.length && !rgFilter.includes(rg)) continue

          for await (const db of sqlClient.databases.listByServer(rg, server.name)) {
            if (!db.id || !db.name || db.name === 'master') continue

            yield {
              external_id: db.id,
              source:      'azure',
              ci_type:     'database_instance',
              name:        `${server.name}/${db.name}`,
              properties:  {
                server_name:     server.name,
                database_name:   db.name,
                engine:          'mssql',
                sku:             db.sku?.name,
                tier:            db.sku?.tier,
                location:        db.location,
                resource_group:  rg,
                subscription_id: subscriptionId,
                status:          db.status,
              },
              tags:          {},
              relationships: [],
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, '[azure] SQL scan error')
      }
    }

    // ── AKS Clusters ─────────────────────────────────────────────────────
    if (types.has('aks')) {
      try {
        const { ContainerServiceClient } = await import('@azure/arm-containerservice')
        const aksClient = new ContainerServiceClient(credential, subscriptionId)

        for await (const cluster of aksClient.managedClusters.list()) {
          if (!cluster.id || !cluster.name) continue

          const rg = rgFromId(cluster.id)
          if (rgFilter.length && !rgFilter.includes(rg)) continue

          const pool = cluster.agentPoolProfiles?.[0]

          yield {
            external_id: cluster.id,
            source:      'azure',
            ci_type:     'application',
            name:        cluster.name,
            properties:  {
              kubernetes_version: cluster.kubernetesVersion,
              node_count:         pool?.count,
              vm_size:            pool?.vmSize,
              location:           cluster.location,
              fqdn:               cluster.fqdn,
              power_state:        cluster.powerState?.code,
              resource_group:     rg,
              subscription_id:    subscriptionId,
            },
            tags:          {},
            relationships: [],
          }
        }
      } catch (err) {
        logger.warn({ err }, '[azure] AKS scan error')
      }
    }

    // ── Load Balancers ────────────────────────────────────────────────────
    if (types.has('lb')) {
      try {
        const { NetworkManagementClient } = await import('@azure/arm-network')
        const networkClient = new NetworkManagementClient(credential, subscriptionId)

        for await (const lb of networkClient.loadBalancers.listAll()) {
          if (!lb.id || !lb.name) continue

          const rg = rgFromId(lb.id)
          if (rgFilter.length && !rgFilter.includes(rg)) continue

          const frontendIps = (lb.frontendIPConfigurations ?? [])
            .map(f => f.privateIPAddress ?? f.publicIPAddress?.id ?? '')
            .filter(Boolean)
            .join(', ')

          const relationships: DiscoveredRelation[] = []

          // Backend pools → NIC → VM relations
          for (const pool of lb.backendAddressPools ?? []) {
            for (const ipConfig of pool.backendIPConfigurations ?? []) {
              const nicId = ipConfig.id?.split('/ipConfigurations/')[0]
              if (!nicId) continue
              try {
                const nicRg  = nicId.split('/')[4] ?? rg
                const nicName = nicId.split('/').pop() ?? ''
                const nic    = await networkClient.networkInterfaces.get(nicRg, nicName)
                const vmId   = nic.virtualMachine?.id
                if (vmId) {
                  relationships.push({
                    target_external_id: vmId,
                    relation_type:      'DEPENDS_ON',
                    direction:          'outgoing',
                  })
                }
              } catch (err) {
                logger.debug({ err }, '[azure] LB NIC resolve skip')
              }
            }
          }

          yield {
            external_id: lb.id,
            source:      'azure',
            ci_type:     'load_balancer',
            name:        lb.name,
            properties:  {
              sku:             lb.sku?.name,
              location:        lb.location,
              frontend_ips:    frontendIps,
              resource_group:  rg,
              subscription_id: subscriptionId,
            },
            tags:          {},
            relationships,
          }
        }
      } catch (err) {
        logger.warn({ err }, '[azure] LB scan error')
      }
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg = config.config as AzureConfig
      const { ClientSecretCredential } = await import('@azure/identity')
      const { SubscriptionClient }     = await import('@azure/arm-subscriptions')

      const credential = new ClientSecretCredential(
        creds['tenant_id']!,
        creds['client_id']!,
        creds['client_secret']!,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = new SubscriptionClient(credential) as any
      const ops    = client.subscriptions ?? client.subscription
      const sub    = await ops.get(cfg.subscription_id)
      return { ok: true, message: `Connected to Azure subscription: ${(sub as { displayName?: string }).displayName ?? cfg.subscription_id}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Azure connection failed: ${msg}` }
    }
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return [
      { name: 'tenant_id',     label: 'Tenant ID (Directory ID)', type: 'text',     required: true },
      { name: 'client_id',     label: 'Client ID (App ID)',        type: 'text',     required: true },
      { name: 'client_secret', label: 'Client Secret',            type: 'password', required: true },
    ]
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'subscription_id',
        label:     'Subscription ID',
        type:      'text',
        required:  true,
        help_text: 'Azure Subscription ID to scan',
      },
      {
        name:          'resource_types',
        label:         'Resource Types',
        type:          'text',
        required:      false,
        default_value: ALL_RESOURCE_TYPES.join(', '),
        help_text:     'Comma-separated: vm, sql, aks, lb (leave empty for all)',
      },
      {
        name:      'resource_groups',
        label:     'Resource Groups',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of resource groups to filter (leave empty for all)',
      },
    ]
  },
}
