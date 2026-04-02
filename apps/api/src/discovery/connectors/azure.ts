import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── Azure Connector ───────────────────────────────────────────────────────────
// Discovers VMs and SQL databases in an Azure subscription.
// Credentials: tenant_id, client_id, client_secret.
// Config: subscription_id, resource_groups (comma-separated, optional).

type AzureConfig = {
  subscription_id:  string
  resource_groups?: string
}

function parseResourceGroups(rg?: string): string[] {
  if (!rg) return []
  return rg.split(',').map(s => s.trim()).filter(Boolean)
}

export const azureConnector: Connector = {
  type:             'azure',
  displayName:      'Microsoft Azure',
  supportedCITypes: ['server', 'database', 'database_instance'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg            = config.config as AzureConfig
    const subscriptionId = cfg.subscription_id
    const rgFilter       = parseResourceGroups(cfg.resource_groups)

    const { ClientSecretCredential }       = await import('@azure/identity')
    const { ComputeManagementClient }      = await import('@azure/arm-compute')
    const { SqlManagementClient }          = await import('@azure/arm-sql')

    const credential = new ClientSecretCredential(
      creds['tenant_id']!,
      creds['client_id']!,
      creds['client_secret']!,
    )

    // ── Virtual Machines ─────────────────────────────────────────────────
    try {
      const computeClient = new ComputeManagementClient(credential, subscriptionId)
      for await (const vm of computeClient.virtualMachines.listAll()) {
        if (!vm.id || !vm.name) continue

        const rg = vm.id.split('/')[4] ?? ''
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

    // ── SQL Servers & Databases ─────────────────────────────────────────
    try {
      const sqlClient = new SqlManagementClient(credential, subscriptionId)
      for await (const server of sqlClient.servers.list()) {
        if (!server.id || !server.name) continue

        const rg = server.id.split('/')[4] ?? ''
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
        name:      'resource_groups',
        label:     'Resource Groups',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of resource groups to filter (leave empty for all)',
      },
    ]
  },
}
