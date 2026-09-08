import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import type { TokenCredential } from '@azure/identity'
import { logger } from '../../lib/logger.js'
import {
  connectorError, errorStatus, guardScan, probeConnection,
  requireConfigString, requireCreds, resourceTypeSet, resourceTypesField, tagsToRecord,
} from './base.js'
import { splitList } from './normalize.js'

// ── Azure Connector ───────────────────────────────────────────────────────────
// Discovers VMs, SQL databases, AKS clusters, and Load Balancers.
// Credentials: tenant_id, client_id, client_secret.
// Config: subscription_id, resource_groups (comma-sep), resource_types (comma-sep).

const TYPE = 'azure'

type AzureConfig = {
  subscription_id:  string
  resource_groups?: string
  resource_types?:  string
}

const ALL_RESOURCE_TYPES = ['vm', 'sql', 'aks', 'lb'] as const

function rgFromId(id: string): string {
  return id.split('/')[4] ?? ''
}

async function makeCredential(creds: Record<string, string>): Promise<TokenCredential> {
  requireCreds(TYPE, creds, ['tenant_id', 'client_id', 'client_secret'])
  const { ClientSecretCredential } = await import('@azure/identity')
  return new ClientSecretCredential(creds['tenant_id']!, creds['client_id']!, creds['client_secret']!)
}

interface AzureScanContext {
  credential:     TokenCredential
  subscriptionId: string
  /** Empty = all resource groups. */
  rgFilter:       string[]
}

function inScope(ctx: AzureScanContext, rg: string): boolean {
  return ctx.rgFilter.length === 0 || ctx.rgFilter.includes(rg)
}

function base(ctx: AzureScanContext, externalId: string, ciType: string, name: string, rg: string, properties: Record<string, unknown>): DiscoveredCI {
  return {
    external_id: externalId,
    source:      TYPE,
    ci_type:     ciType,
    name,
    properties:  { ...properties, resource_group: rg, subscription_id: ctx.subscriptionId },
    tags:        {},
    relationships: [],
  }
}

// ── Per-resource scanners ─────────────────────────────────────────────────────

async function* scanVms(ctx: AzureScanContext): AsyncIterable<DiscoveredCI> {
  const { ComputeManagementClient } = await import('@azure/arm-compute')
  const computeClient = new ComputeManagementClient(ctx.credential, ctx.subscriptionId)

  for await (const vm of computeClient.virtualMachines.listAll()) {
    if (!vm.id || !vm.name) continue
    const rg = rgFromId(vm.id)
    if (!inScope(ctx, rg)) continue

    yield {
      ...base(ctx, vm.id, 'server', vm.name, rg, {
        vm_size:      vm.hardwareProfile?.vmSize,
        os_type:      vm.storageProfile?.osDisk?.osType,
        location:     vm.location,
        provisioning: vm.provisioningState,
      }),
      tags: tagsToRecord(vm.tags),
    }
  }
}

async function* scanSql(ctx: AzureScanContext): AsyncIterable<DiscoveredCI> {
  const { SqlManagementClient } = await import('@azure/arm-sql')
  const sqlClient = new SqlManagementClient(ctx.credential, ctx.subscriptionId)

  for await (const server of sqlClient.servers.list()) {
    if (!server.id || !server.name) continue
    const rg = rgFromId(server.id)
    if (!inScope(ctx, rg)) continue

    for await (const db of sqlClient.databases.listByServer(rg, server.name)) {
      if (!db.id || !db.name || db.name === 'master') continue
      yield base(ctx, db.id, 'database_instance', `${server.name}/${db.name}`, rg, {
        server_name:   server.name,
        database_name: db.name,
        engine:        'mssql',
        sku:           db.sku?.name,
        tier:          db.sku?.tier,
        location:      db.location,
        status:        db.status,
      })
    }
  }
}

async function* scanAks(ctx: AzureScanContext): AsyncIterable<DiscoveredCI> {
  const { ContainerServiceClient } = await import('@azure/arm-containerservice')
  const aksClient = new ContainerServiceClient(ctx.credential, ctx.subscriptionId)

  for await (const cluster of aksClient.managedClusters.list()) {
    if (!cluster.id || !cluster.name) continue
    const rg = rgFromId(cluster.id)
    if (!inScope(ctx, rg)) continue

    const pool = cluster.agentPoolProfiles?.[0]
    yield base(ctx, cluster.id, 'application', cluster.name, rg, {
      kubernetes_version: cluster.kubernetesVersion,
      node_count:         pool?.count,
      vm_size:            pool?.vmSize,
      location:           cluster.location,
      fqdn:               cluster.fqdn,
      power_state:        cluster.powerState?.code,
    })
  }
}

async function* scanLbs(ctx: AzureScanContext): AsyncIterable<DiscoveredCI> {
  const { NetworkManagementClient } = await import('@azure/arm-network')
  const networkClient = new NetworkManagementClient(ctx.credential, ctx.subscriptionId)

  for await (const lb of networkClient.loadBalancers.listAll()) {
    if (!lb.id || !lb.name) continue
    const rg = rgFromId(lb.id)
    if (!inScope(ctx, rg)) continue

    const frontendIps = (lb.frontendIPConfigurations ?? [])
      .map(f => f.privateIPAddress ?? f.publicIPAddress?.id ?? '')
      .filter(Boolean)
      .join(', ')

    // Backend pools → NIC → VM relations
    const relationships: DiscoveredRelation[] = []
    for (const pool of lb.backendAddressPools ?? []) {
      for (const ipConfig of pool.backendIPConfigurations ?? []) {
        const nicId = ipConfig.id?.split('/ipConfigurations/')[0]
        if (!nicId) continue
        try {
          const nicRg   = nicId.split('/')[4] ?? rg
          const nicName = nicId.split('/').pop() ?? ''
          const nic     = await networkClient.networkInterfaces.get(nicRg, nicName)
          const vmId    = nic.virtualMachine?.id
          if (vmId) relationships.push({ target_external_id: vmId, relation_type: 'DEPENDS_ON', direction: 'outgoing' })
        } catch (err) {
          // Legit skip: NIC deleted between LB listing and NIC lookup (404) — anything else must fail the run.
          if (errorStatus(err) !== 404) throw connectorError(TYPE, `LB backend NIC resolve (${nicId})`, err)
          logger.debug({ err, nicId }, '[azure] LB backend NIC vanished mid-scan, skipping')
        }
      }
    }

    yield {
      ...base(ctx, lb.id, 'load_balancer', lb.name, rg, {
        sku:          lb.sku?.name,
        location:     lb.location,
        frontend_ips: frontendIps,
      }),
      relationships,
    }
  }
}

const SCANNERS: Record<typeof ALL_RESOURCE_TYPES[number], { label: string; run: (ctx: AzureScanContext) => AsyncIterable<DiscoveredCI> }> = {
  vm:  { label: 'VM scan',  run: scanVms },
  sql: { label: 'SQL scan', run: scanSql },
  aks: { label: 'AKS scan', run: scanAks },
  lb:  { label: 'LB scan',  run: scanLbs },
}

// ── Connector ─────────────────────────────────────────────────────────────────

export const azureConnector: Connector = {
  type:             TYPE,
  displayName:      'Microsoft Azure',
  supportedCITypes: ['server', 'database_instance', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg   = config.config as AzureConfig
    const types = resourceTypeSet(TYPE, cfg.resource_types, ALL_RESOURCE_TYPES)
    const ctx: AzureScanContext = {
      credential:     await makeCredential(creds),
      subscriptionId: requireConfigString(TYPE, cfg, 'subscription_id'),
      rgFilter:       splitList(cfg.resource_groups),
    }

    for (const type of ALL_RESOURCE_TYPES) {
      if (!types.has(type)) continue
      const { label, run } = SCANNERS[type]
      yield* guardScan(TYPE, `${label} (subscription ${ctx.subscriptionId})`, () => run(ctx))
    }
  },

  testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    return probeConnection('Azure', async () => {
      const cfg            = config.config as AzureConfig
      const subscriptionId = requireConfigString(TYPE, cfg, 'subscription_id')
      const credential     = await makeCredential(creds)
      const { SubscriptionClient } = await import('@azure/arm-subscriptions')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = new SubscriptionClient(credential) as any
      const ops    = client.subscriptions ?? client.subscription
      const sub    = await ops.get(subscriptionId)
      return `Connected to Azure subscription: ${(sub as { displayName?: string }).displayName ?? subscriptionId}`
    })
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
      resourceTypesField(ALL_RESOURCE_TYPES),
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
