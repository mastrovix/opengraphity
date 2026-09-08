/**
 * azureConnector — SDK Azure mockati (iteratori asincroni `listAll`/`list`),
 * nessuna rete. Pinna: credenziali/subscription obbligatorie, resource_types
 * sconosciuti, mapping tag→CI, filtro resource_groups, SQL (master escluso),
 * AKS, LB con relazioni NIC→VM (404 = skip, altro = errore), testConnection.
 *
 * Paginazione: i client @azure/arm-* espongono PagedAsyncIterableIterator che
 * segue `nextLink` internamente; il connettore consuma l'iteratore. Qui si
 * simula un iteratore che attraversa due "pagine" e si pinna che tutte le
 * risorse siano raccolte.
 * include_stopped: il connettore Azure NON ha il flag (le VM deallocate
 * arrivano con `provisioning`); nessun test sul filtro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

const h = vi.hoisted(() => {
  const ctors: Array<{ client: string; args: unknown[] }> = []
  // Le "pagine" servono solo a simulare un iteratore multi-pagina: il client
  // reale le attraversa da solo.
  async function* pages<T>(...pageList: T[][]): AsyncIterable<T> {
    for (const page of pageList) for (const item of page) yield item
  }
  const vmListAll      = vi.fn<() => AsyncIterable<unknown>>(() => pages([]))
  const sqlServersList = vi.fn<() => AsyncIterable<unknown>>(() => pages([]))
  const sqlDbsList     = vi.fn<(rg: string, server: string) => AsyncIterable<unknown>>(() => pages([]))
  const aksList        = vi.fn<() => AsyncIterable<unknown>>(() => pages([]))
  const lbListAll      = vi.fn<() => AsyncIterable<unknown>>(() => pages([]))
  const nicGet         = vi.fn<(rg: string, name: string) => Promise<unknown>>()
  const subGet         = vi.fn<(id: string) => Promise<unknown>>()
  const client = (name: string, shape: Record<string, unknown>) => class {
    constructor(...args: unknown[]) { ctors.push({ client: name, args }); Object.assign(this, shape) }
  }
  return { ctors, pages, vmListAll, sqlServersList, sqlDbsList, aksList, lbListAll, nicGet, subGet, client }
})

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    constructor(readonly tenantId: string, readonly clientId: string, readonly clientSecret: string) {}
    getToken = vi.fn()
  },
}))
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: h.client('ComputeManagementClient', { virtualMachines: { listAll: h.vmListAll } }),
}))
vi.mock('@azure/arm-sql', () => ({
  SqlManagementClient: h.client('SqlManagementClient', { servers: { list: h.sqlServersList }, databases: { listByServer: h.sqlDbsList } }),
}))
vi.mock('@azure/arm-containerservice', () => ({
  ContainerServiceClient: h.client('ContainerServiceClient', { managedClusters: { list: h.aksList } }),
}))
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: h.client('NetworkManagementClient', { loadBalancers: { listAll: h.lbListAll }, networkInterfaces: { get: h.nicGet } }),
}))
vi.mock('@azure/arm-subscriptions', () => ({
  SubscriptionClient: h.client('SubscriptionClient', { subscriptions: { get: h.subGet } }),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { azureConnector } = await import('../connectors/azure.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUB   = '00000000-0000-0000-0000-000000000001'
const CREDS = { tenant_id: 'tenant-guid', client_id: 'app-guid', client_secret: 's3cr3t' }
const rid   = (rg: string, provider: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${provider}/${name}`

function source(config: Record<string, unknown>): SyncSourceConfig {
  return {
    id: 'src-az', tenant_id: 't1', name: 'azure', connector_type: 'azure',
    encrypted_credentials: '', config, mapping_rules: [], schedule_cron: null, enabled: true,
    last_sync_at: null, last_sync_status: null, last_sync_duration_ms: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const CFG = { subscription_id: SUB }

beforeEach(() => {
  vi.clearAllMocks()
  h.ctors.length = 0
  h.vmListAll.mockImplementation(() => h.pages([]))
  h.sqlServersList.mockImplementation(() => h.pages([]))
  h.sqlDbsList.mockImplementation(() => h.pages([]))
  h.aksList.mockImplementation(() => h.pages([]))
  h.lbListAll.mockImplementation(() => h.pages([]))
})

// ── Config / credenziali ──────────────────────────────────────────────────────

describe('azureConnector.scan — config e credenziali', () => {
  it('credenziali mancanti → errore esplicito, nessun client istanziato', async () => {
    await expect(collect(azureConnector.scan(source(CFG), { tenant_id: 't', client_id: 'c' })))
      .rejects.toThrow('[azure] credentials failed: credenziali mancanti: client_secret')
    await expect(collect(azureConnector.scan(source(CFG), {})))
      .rejects.toThrow('credenziali mancanti: tenant_id, client_id, client_secret')
    expect(h.ctors).toHaveLength(0)
  })

  it('subscription_id mancante → errore esplicito', async () => {
    await expect(collect(azureConnector.scan(source({}), CREDS)))
      .rejects.toThrow('[azure] config failed: campo di configurazione obbligatorio mancante: subscription_id')
    expect(h.ctors).toHaveLength(0)
  })

  it('resource_types sconosciuti → errore esplicito', async () => {
    await expect(collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm, ec2, rds' }), CREDS)))
      .rejects.toThrow('[azure] config failed: resource_types sconosciuti: ec2, rds (ammessi: vm, sql, aks, lb)')
    expect(h.ctors).toHaveLength(0)
  })

  it('costruisce ClientSecretCredential dalle credenziali e lo passa con la subscription a ogni client', async () => {
    await collect(azureConnector.scan(source({ ...CFG, resource_types: 'aks' }), CREDS))
    expect(h.ctors).toHaveLength(1)
    const [credential, subscriptionId] = h.ctors[0]!.args
    expect(h.ctors[0]!.client).toBe('ContainerServiceClient')
    expect(credential).toMatchObject({ tenantId: 'tenant-guid', clientId: 'app-guid', clientSecret: 's3cr3t' })
    expect(subscriptionId).toBe(SUB)
  })

  it('scansiona i tipi richiesti nell\'ordine canonico vm, sql, aks, lb', async () => {
    await collect(azureConnector.scan(source({ ...CFG, resource_types: 'lb, vm' }), CREDS))
    expect(h.ctors.map(c => c.client)).toEqual(['ComputeManagementClient', 'NetworkManagementClient'])
  })
})

// ── VM ────────────────────────────────────────────────────────────────────────

describe('azureConnector.scan — VM', () => {
  const vm = (rg: string, name: string, extra: Record<string, unknown> = {}) => ({
    id: rid(rg, 'Microsoft.Compute/virtualMachines', name), name, location: 'westeurope',
    hardwareProfile: { vmSize: 'Standard_B2s' }, storageProfile: { osDisk: { osType: 'Linux' } },
    provisioningState: 'Succeeded', tags: { env: 'prod', 'Cost Center': 'CC-1', none: null },
    ...extra,
  })

  it('raccoglie tutte le VM attraversando l\'iteratore multi-pagina', async () => {
    h.vmListAll.mockImplementation(() => h.pages([vm('rg-a', 'vm-1'), vm('rg-a', 'vm-2')], [vm('rg-b', 'vm-3')]))
    const cis = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm' }), CREDS))
    expect(cis.map(c => c.name)).toEqual(['vm-1', 'vm-2', 'vm-3'])
    expect(h.vmListAll).toHaveBeenCalledTimes(1)
  })

  it('mappa VM + tag nel CI normalizzato (resource_group dal path dell\'id, subscription_id in properties)', async () => {
    h.vmListAll.mockImplementation(() => h.pages([vm('RG-Prod', 'web-01')]))
    const [ci] = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm' }), CREDS))
    expect(ci).toEqual({
      external_id: rid('RG-Prod', 'Microsoft.Compute/virtualMachines', 'web-01'),
      source:      'azure',
      ci_type:     'server',
      name:        'web-01',
      properties: {
        vm_size:         'Standard_B2s',
        os_type:         'Linux',
        location:        'westeurope',
        provisioning:    'Succeeded',
        resource_group:  'RG-Prod',
        subscription_id: SUB,
      },
      tags:          { env: 'prod', 'Cost Center': 'CC-1' },
      relationships: [],
    })
  })

  it('resource_groups filtra per gruppo; VM senza id/nome scartate', async () => {
    h.vmListAll.mockImplementation(() => h.pages([vm('rg-a', 'keep'), vm('rg-b', 'drop'), { name: 'no-id' }, { id: rid('rg-a', 'x', 'y') }]))
    const cis = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm', resource_groups: 'rg-a, rg-z' }), CREDS))
    expect(cis.map(c => c.name)).toEqual(['keep'])
  })

  it('VM deallocate sono incluse (nessun flag include_stopped nel connettore Azure)', async () => {
    h.vmListAll.mockImplementation(() => h.pages([vm('rg', 'up'), vm('rg', 'down', { provisioningState: 'Deallocated' })]))
    const cis = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm' }), CREDS))
    expect(cis.map(c => c.properties['provisioning'])).toEqual(['Succeeded', 'Deallocated'])
    expect(azureConnector.getConfigFields().map(f => f.name)).not.toContain('include_stopped')
  })

  it('un errore dell\'iteratore è rilanciato arricchito con connettore, scan e subscription', async () => {
    h.vmListAll.mockImplementation(async function* () { yield vm('rg', 'ok'); throw new Error('AuthorizationFailed') })
    await expect(collect(azureConnector.scan(source({ ...CFG, resource_types: 'vm' }), CREDS)))
      .rejects.toThrow(`[azure] VM scan (subscription ${SUB}) failed: AuthorizationFailed`)
  })
})

// ── SQL / AKS / LB ────────────────────────────────────────────────────────────

describe('azureConnector.scan — SQL, AKS, LB', () => {
  it('SQL: un CI per database (master escluso), nome server/db, server fuori dai resource_groups saltati', async () => {
    h.sqlServersList.mockImplementation(() => h.pages([
      { id: rid('rg-a', 'Microsoft.Sql/servers', 'srv-a'), name: 'srv-a' },
      { id: rid('rg-b', 'Microsoft.Sql/servers', 'srv-b'), name: 'srv-b' },
    ]))
    h.sqlDbsList.mockImplementation((rg, server) => h.pages([
      { id: `${rid(rg, 'Microsoft.Sql/servers', server)}/databases/master`, name: 'master' },
      { id: `${rid(rg, 'Microsoft.Sql/servers', server)}/databases/appdb`, name: 'appdb', sku: { name: 'S0', tier: 'Standard' }, location: 'westeurope', status: 'Online' },
    ]))
    const cis = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'sql', resource_groups: 'rg-a' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toMatchObject({
      external_id: `${rid('rg-a', 'Microsoft.Sql/servers', 'srv-a')}/databases/appdb`,
      ci_type: 'database_instance', name: 'srv-a/appdb',
      properties: { server_name: 'srv-a', database_name: 'appdb', engine: 'mssql', sku: 'S0', tier: 'Standard', location: 'westeurope', status: 'Online', resource_group: 'rg-a' },
    })
    expect(h.sqlDbsList).toHaveBeenCalledTimes(1)
    expect(h.sqlDbsList).toHaveBeenCalledWith('rg-a', 'srv-a')
  })

  it('AKS: mappa il cluster con il primo agent pool', async () => {
    h.aksList.mockImplementation(() => h.pages([{
      id: rid('rg-k8s', 'Microsoft.ContainerService/managedClusters', 'aks-prod'), name: 'aks-prod', location: 'northeurope',
      kubernetesVersion: '1.30.3', fqdn: 'aks-prod.hcp.azmk8s.io', powerState: { code: 'Running' },
      agentPoolProfiles: [{ count: 5, vmSize: 'Standard_D4s_v5' }, { count: 99 }],
    }]))
    const [ci] = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'aks' }), CREDS))
    expect(ci).toMatchObject({
      ci_type: 'application', name: 'aks-prod',
      properties: { kubernetes_version: '1.30.3', node_count: 5, vm_size: 'Standard_D4s_v5', location: 'northeurope',
        fqdn: 'aks-prod.hcp.azmk8s.io', power_state: 'Running', resource_group: 'rg-k8s', subscription_id: SUB },
    })
  })

  it('LB: frontend IP, relazioni NIC→VM; NIC 404 è skip, altro errore ferma la scansione', async () => {
    const nicId = (rg: string, name: string) => rid(rg, 'Microsoft.Network/networkInterfaces', name)
    h.lbListAll.mockImplementation(() => h.pages([{
      id: rid('rg-net', 'Microsoft.Network/loadBalancers', 'lb-1'), name: 'lb-1', location: 'westeurope', sku: { name: 'Standard' },
      frontendIPConfigurations: [{ privateIPAddress: '10.0.0.4' }, { publicIPAddress: { id: '/pip/1' } }, {}],
      backendAddressPools: [{ backendIPConfigurations: [
        { id: `${nicId('rg-vm', 'nic-a')}/ipConfigurations/ipconfig1` },
        { id: `${nicId('rg-vm', 'nic-gone')}/ipConfigurations/ipconfig1` },
        { id: `${nicId('rg-vm', 'nic-novm')}/ipConfigurations/ipconfig1` },
        {},
      ] }],
    }]))
    h.nicGet.mockImplementation(async (_rg, name) => {
      if (name === 'nic-gone') throw Object.assign(new Error('NotFound'), { statusCode: 404 })
      if (name === 'nic-novm') return {}
      return { virtualMachine: { id: rid('rg-vm', 'Microsoft.Compute/virtualMachines', 'vm-a') } }
    })
    const [lb] = await collect(azureConnector.scan(source({ ...CFG, resource_types: 'lb' }), CREDS))
    expect(lb).toMatchObject({
      ci_type: 'load_balancer', name: 'lb-1',
      properties: { sku: 'Standard', location: 'westeurope', frontend_ips: '10.0.0.4, /pip/1', resource_group: 'rg-net' },
      relationships: [{ target_external_id: rid('rg-vm', 'Microsoft.Compute/virtualMachines', 'vm-a'), relation_type: 'DEPENDS_ON', direction: 'outgoing' }],
    })
    expect(h.nicGet).toHaveBeenCalledWith('rg-vm', 'nic-a')

    h.nicGet.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }))
    await expect(collect(azureConnector.scan(source({ ...CFG, resource_types: 'lb' }), CREDS)))
      .rejects.toThrow(`[azure] LB backend NIC resolve (${nicId('rg-vm', 'nic-a')}) failed: Forbidden`)
  })
})

// ── testConnection ────────────────────────────────────────────────────────────

describe('azureConnector.testConnection', () => {
  it('ok: subscriptions.get(subscription_id) → displayName nel messaggio', async () => {
    h.subGet.mockResolvedValue({ displayName: 'Prod Subscription' })
    await expect(azureConnector.testConnection(source(CFG), CREDS))
      .resolves.toEqual({ ok: true, message: 'Connected to Azure subscription: Prod Subscription' })
    expect(h.subGet).toHaveBeenCalledWith(SUB)
    expect(h.ctors.map(c => c.client)).toEqual(['SubscriptionClient'])
  })

  it('ok: senza displayName ricade sull\'id', async () => {
    h.subGet.mockResolvedValue({})
    await expect(azureConnector.testConnection(source(CFG), CREDS))
      .resolves.toEqual({ ok: true, message: `Connected to Azure subscription: ${SUB}` })
  })

  it('ko: errore SDK → { ok:false } con prefisso uniforme', async () => {
    h.subGet.mockRejectedValue(new Error('AADSTS7000215 invalid client secret'))
    await expect(azureConnector.testConnection(source(CFG), CREDS))
      .resolves.toEqual({ ok: false, message: 'Azure connection failed: AADSTS7000215 invalid client secret' })
  })

  it('ko: subscription/credenziali mancanti → { ok:false } senza chiamare l\'SDK', async () => {
    await expect(azureConnector.testConnection(source({}), CREDS))
      .resolves.toEqual({ ok: false, message: 'Azure connection failed: [azure] config failed: campo di configurazione obbligatorio mancante: subscription_id' })
    await expect(azureConnector.testConnection(source(CFG), { tenant_id: 't' }))
      .resolves.toEqual({ ok: false, message: 'Azure connection failed: [azure] credentials failed: credenziali mancanti: client_id, client_secret' })
    expect(h.subGet).not.toHaveBeenCalled()
  })
})

describe('azureConnector metadata', () => {
  it('dichiara le tre credenziali obbligatorie e i campi di config', () => {
    expect(azureConnector.getRequiredCredentialFields().map(f => [f.name, f.required]))
      .toEqual([['tenant_id', true], ['client_id', true], ['client_secret', true]])
    expect(azureConnector.getConfigFields()).toMatchObject([
      { name: 'subscription_id', required: true },
      { name: 'resource_types', default_value: 'vm, sql, aks, lb' },
      { name: 'resource_groups', required: false },
    ])
  })
})
