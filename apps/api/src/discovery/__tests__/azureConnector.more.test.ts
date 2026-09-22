/**
 * azureConnector — the skips the main suite did not exercise for SQL, AKS and
 * load balancers, and the older subscriptions SDK shape.
 *
 * Why it matters: discovery reconciles what it yields against the CMDB. A
 * resource outside the configured resource groups that slips through becomes
 * a CI the customer never asked to manage; a half-described resource (no id or
 * no name) would become a CI with no stable external id, i.e. a duplicate at
 * every run. And `testConnection` must work with both SDK generations, or the
 * "Test connection" button reports a failure on a perfectly valid source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

const h = vi.hoisted(() => {
  async function* items<T>(list: T[]): AsyncIterable<T> { for (const x of list) yield x }
  return {
    items,
    sqlServers: vi.fn<() => AsyncIterable<unknown>>(),
    sqlDbs:     vi.fn<(rg: string, server: string) => AsyncIterable<unknown>>(),
    aks:        vi.fn<() => AsyncIterable<unknown>>(),
    lbs:        vi.fn<() => AsyncIterable<unknown>>(),
    nicGet:     vi.fn<(rg: string, name: string) => Promise<unknown>>(),
    subGet:     vi.fn<(id: string) => Promise<unknown>>(),
  }
})

vi.mock('@azure/identity', () => ({ ClientSecretCredential: class { getToken = vi.fn() } }))
vi.mock('@azure/arm-compute', () => ({ ComputeManagementClient: class { virtualMachines = { listAll: () => h.items([]) } } }))
vi.mock('@azure/arm-sql', () => ({
  SqlManagementClient: class { servers = { list: h.sqlServers }; databases = { listByServer: h.sqlDbs } },
}))
vi.mock('@azure/arm-containerservice', () => ({ ContainerServiceClient: class { managedClusters = { list: h.aks } } }))
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: class { loadBalancers = { listAll: h.lbs }; networkInterfaces = { get: h.nicGet } },
}))
// The older @azure/arm-subscriptions exposed `subscription` (singular).
vi.mock('@azure/arm-subscriptions', () => ({ SubscriptionClient: class { subscription = { get: h.subGet } } }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { azureConnector } = await import('../connectors/azure.js')

const SUB = 'sub-1'
const CREDS = { tenant_id: 't', client_id: 'c', client_secret: 's' }
const rid = (rg: string, provider: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${provider}/${name}`

function source(config: Record<string, unknown>): SyncSourceConfig {
  return {
    id: 'src', tenant_id: 't1', name: 'azure', connector_type: 'azure', encrypted_credentials: '', config,
    mapping_rules: [], schedule_cron: null, enabled: true, last_sync_at: null, last_sync_status: null,
    last_sync_duration_ms: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sqlServers.mockImplementation(() => h.items([]))
  h.sqlDbs.mockImplementation(() => h.items([]))
  h.aks.mockImplementation(() => h.items([]))
  h.lbs.mockImplementation(() => h.items([]))
})

describe('half-described or out-of-scope resources are skipped', () => {
  it('SQL: a server without id or name is not listed for databases', async () => {
    h.sqlServers.mockImplementation(() => h.items([{ name: 'no-id' }, { id: rid('rg', 'Microsoft.Sql/servers', 'x') }]))
    const cis = await collect(azureConnector.scan(source({ subscription_id: SUB, resource_types: 'sql' }), CREDS))
    expect(cis).toEqual([])
    expect(h.sqlDbs).not.toHaveBeenCalled()
  })

  it('AKS: clusters without id/name or outside resource_groups are dropped; a cluster with no pool still maps', async () => {
    h.aks.mockImplementation(() => h.items([
      { name: 'no-id' },
      { id: rid('rg-other', 'Microsoft.ContainerService/managedClusters', 'other'), name: 'other' },
      { id: rid('rg-k8s', 'Microsoft.ContainerService/managedClusters', 'keep'), name: 'keep' },
    ]))
    const cis = await collect(azureConnector.scan(source({ subscription_id: SUB, resource_types: 'aks', resource_groups: 'rg-k8s' }), CREDS))
    expect(cis.map((c) => c.name)).toEqual(['keep'])
    expect(cis[0]!.properties).toMatchObject({ node_count: undefined, vm_size: undefined, resource_group: 'rg-k8s' })
  })

  it('LB: balancers without id/name or outside resource_groups are dropped; no pools → no relations, no frontends → ""', async () => {
    h.lbs.mockImplementation(() => h.items([
      { id: rid('rg-net', 'Microsoft.Network/loadBalancers', 'lb-x') },
      { id: rid('rg-other', 'Microsoft.Network/loadBalancers', 'lb-other'), name: 'lb-other' },
      { id: rid('rg-net', 'Microsoft.Network/loadBalancers', 'lb-1'), name: 'lb-1', backendAddressPools: [{}] },
    ]))
    const cis = await collect(azureConnector.scan(source({ subscription_id: SUB, resource_types: 'lb', resource_groups: 'rg-net' }), CREDS))
    expect(cis.map((c) => c.name)).toEqual(['lb-1'])
    expect(cis[0]).toMatchObject({ relationships: [], properties: { frontend_ips: '' } })
    expect(h.nicGet).not.toHaveBeenCalled()
  })
})

describe('testConnection with the older SDK shape', () => {
  it('uses `subscription.get` when `subscriptions` is absent', async () => {
    h.subGet.mockResolvedValue({ displayName: 'Legacy Sub' })
    await expect(azureConnector.testConnection(source({ subscription_id: SUB }), CREDS))
      .resolves.toEqual({ ok: true, message: 'Connected to Azure subscription: Legacy Sub' })
    expect(h.subGet).toHaveBeenCalledWith(SUB)
  })
})
