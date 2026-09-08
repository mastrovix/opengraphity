/**
 * gcpConnector — SDK Google mockati (client con `list`/`listClusters`), nessuna rete.
 * Pinna: config/credenziali obbligatorie, resource_types sconosciuti, mapping
 * label→tag e proprietà snake_case, zone esplicite vs elencate, LB globali e
 * regionali (derivati dalle zone), testConnection ok/ko, errori arricchiti.
 *
 * Paginazione: i client @google-cloud usano `autoPaginate` (il primo elemento
 * della tupla è l'elenco completo) — il connettore non gestisce pageToken; qui
 * si pinna che ogni zona/progetto produce una chiamata e che tutto è raccolto.
 * include_stopped: il connettore GCP NON ha il flag (le istanze TERMINATED
 * arrivano con `status`); nessun test sul filtro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

type Params = Record<string, unknown>

const h = vi.hoisted(() => {
  const ctors: Array<{ client: string; opts: unknown }> = []
  const instancesList = vi.fn<(p: Params) => Promise<[unknown[]]>>()
  const zonesList     = vi.fn<(p: Params) => Promise<[unknown[]]>>()
  const globalList    = vi.fn<(p: Params) => Promise<[unknown[]]>>()
  const regionalList  = vi.fn<(p: Params) => Promise<[unknown[]]>>()
  const sqlList       = vi.fn<(p: Params) => Promise<[unknown[]]>>()
  const listClusters  = vi.fn<(p: Params) => Promise<[{ clusters?: unknown[] }]>>()
  const client = (name: string, methods: Record<string, unknown>) => class {
    constructor(opts: unknown) { ctors.push({ client: name, opts }); Object.assign(this, methods) }
  }
  return { ctors, instancesList, zonesList, globalList, regionalList, sqlList, listClusters, client }
})

vi.mock('@google-cloud/compute', () => ({
  InstancesClient:             h.client('InstancesClient',             { list: h.instancesList }),
  ZonesClient:                 h.client('ZonesClient',                 { list: h.zonesList }),
  GlobalForwardingRulesClient: h.client('GlobalForwardingRulesClient', { list: h.globalList }),
  ForwardingRulesClient:       h.client('ForwardingRulesClient',       { list: h.regionalList }),
}))
vi.mock('@google-cloud/container', () => ({
  ClusterManagerClient: h.client('ClusterManagerClient', { listClusters: h.listClusters }),
}))
vi.mock('@google-cloud/sql', () => ({
  SqlInstancesServiceClient: h.client('SqlInstancesServiceClient', { list: h.sqlList }),
}))

const { gcpConnector } = await import('../connectors/gcp.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const KEY   = { type: 'service_account', project_id: 'proj-a', client_email: 'sa@proj-a.iam' }
const CREDS = { service_account_json: JSON.stringify(KEY) }

function source(config: Record<string, unknown>): SyncSourceConfig {
  return {
    id: 'src-gcp', tenant_id: 't1', name: 'gcp', connector_type: 'gcp',
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

beforeEach(() => {
  vi.clearAllMocks()
  h.ctors.length = 0
  h.instancesList.mockResolvedValue([[]])
  h.zonesList.mockResolvedValue([[{ name: 'europe-west1-b' }, { name: 'europe-west1-c' }, { name: null }]])
  h.globalList.mockResolvedValue([[]])
  h.regionalList.mockResolvedValue([[]])
  h.sqlList.mockResolvedValue([[]])
  h.listClusters.mockResolvedValue([{ clusters: [] }])
})

// ── Config / credenziali ──────────────────────────────────────────────────────

describe('gcpConnector.scan — config e credenziali', () => {
  it('project_ids mancante o vuoto → errore esplicito prima di ogni chiamata', async () => {
    await expect(collect(gcpConnector.scan(source({}), CREDS)))
      .rejects.toThrow('[gcp] config failed: campo di configurazione obbligatorio mancante: project_ids')
    await expect(collect(gcpConnector.scan(source({ project_ids: ' , ' }), CREDS)))
      .rejects.toThrow('[gcp] config failed: project_ids non contiene alcun progetto')
    expect(h.ctors).toHaveLength(0)
  })

  it('service_account_json mancante o non-oggetto → errore esplicito', async () => {
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a' }), {})))
      .rejects.toThrow('[gcp] credentials failed: credenziali mancanti: service_account_json')
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a' }), { service_account_json: '{not json' })))
      .rejects.toThrow(/^\[gcp\] service_account_json parse failed: /)
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a' }), { service_account_json: '[1,2]' })))
      .rejects.toThrow('[gcp] service_account_json parse failed: deve essere un oggetto JSON')
    expect(h.ctors).toHaveLength(0)
  })

  it('resource_types sconosciuti → errore esplicito', async () => {
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'compute, ec2' }), CREDS)))
      .rejects.toThrow('[gcp] config failed: resource_types sconosciuti: ec2 (ammessi: compute, cloudsql, gke, lb)')
    expect(h.ctors).toHaveLength(0)
  })

  it('la chiave parsata è passata come `credentials` a ogni client', async () => {
    await collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'gke' }), CREDS))
    expect(h.ctors).toEqual([{ client: 'ClusterManagerClient', opts: { credentials: KEY } }])
  })
})

// ── Compute ───────────────────────────────────────────────────────────────────

describe('gcpConnector.scan — Compute', () => {
  const inst = (id: string, name: string, extra: Params = {}) => ({
    id, name, machineType: 'https://www.googleapis.com/compute/v1/projects/proj-a/zones/z/machineTypes/n1-standard-1',
    status: 'RUNNING',
    networkInterfaces: [{ networkIP: '10.1.0.2', accessConfigs: [{ natIP: '34.1.1.1' }] }],
    disks: [{ source: 'https://…/disks/debian-12-boot' }],
    labels: { env: 'prod', 'cost-center': 'cc9', empty: null },
    ...extra,
  })

  it('senza zones elenca le zone del progetto e scansiona ciascuna (zone senza nome scartate)', async () => {
    h.instancesList.mockImplementation(async (p) => [p['zone'] === 'europe-west1-b' ? [inst('1', 'a'), inst('2', 'b')] : [inst('3', 'c')]])
    const cis = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'compute' }), CREDS))
    expect(cis.map(c => c.name)).toEqual(['a', 'b', 'c'])
    expect(h.zonesList).toHaveBeenCalledWith({ project: 'proj-a' })
    expect(h.instancesList.mock.calls.map(([p]) => p)).toEqual([
      { project: 'proj-a', zone: 'europe-west1-b' },
      { project: 'proj-a', zone: 'europe-west1-c' },
    ])
  })

  it('con zones esplicite non interroga ZonesClient.list', async () => {
    await collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'us-central1-a', resource_types: 'compute' }), CREDS))
    expect(h.zonesList).not.toHaveBeenCalled()
    expect(h.instancesList).toHaveBeenCalledWith({ project: 'proj-a', zone: 'us-central1-a' })
  })

  it('mappa istanza + label nel CI normalizzato (label grezze come tag, project_id in properties)', async () => {
    h.instancesList.mockResolvedValue([[inst('7788', 'web-01'), { name: 'no-id' }, { id: '9', name: null }]])
    const cis = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'europe-west1-b', resource_types: 'compute' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toEqual({
      external_id: 'gce::proj-a::europe-west1-b::7788',
      source:      'gcp',
      ci_type:     'server',
      name:        'web-01',
      properties: {
        machine_type: 'n1-standard-1',
        zone:         'europe-west1-b',
        status:       'RUNNING',
        private_ip:   '10.1.0.2',
        public_ip:    '34.1.1.1',
        os_image:     'debian-12-boot',
        project_id:   'proj-a',
      },
      tags:          { env: 'prod', 'cost-center': 'cc9' },
      relationships: [],
    })
  })

  it('istanze TERMINATED sono incluse (nessun flag include_stopped nel connettore GCP)', async () => {
    h.instancesList.mockResolvedValue([[inst('1', 'up'), inst('2', 'down', { status: 'TERMINATED' })]])
    const cis = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'z-a', resource_types: 'compute' }), CREDS))
    expect(cis.map(c => c.properties['status'])).toEqual(['RUNNING', 'TERMINATED'])
    expect(gcpConnector.getConfigFields().map(f => f.name)).not.toContain('include_stopped')
  })

  it('scansiona ogni progetto elencato in project_ids', async () => {
    await collect(gcpConnector.scan(source({ project_ids: 'proj-a, proj-b', zones: 'z', resource_types: 'compute' }), CREDS))
    expect(h.instancesList.mock.calls.map(([p]) => p['project'])).toEqual(['proj-a', 'proj-b'])
  })

  it('un errore dell\'SDK viene rilanciato con progetto e zona, mai inghiottito', async () => {
    h.instancesList.mockRejectedValue(new Error('PERMISSION_DENIED'))
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'z-a', resource_types: 'compute' }), CREDS)))
      .rejects.toThrow('[gcp] Compute instance list (project proj-a, zone z-a) failed: PERMISSION_DENIED')
  })
})

// ── Cloud SQL / GKE / LB ──────────────────────────────────────────────────────

describe('gcpConnector.scan — Cloud SQL, GKE, LB', () => {
  it('Cloud SQL: engine da databaseVersion, tier da settings, istanze senza nome scartate', async () => {
    h.sqlList.mockResolvedValue([[
      { name: 'pg-main', databaseVersion: 'POSTGRES_15', settings: { tier: 'db-custom-2-8192' }, region: 'europe-west1', state: 'RUNNABLE' },
      { name: 'my-legacy', databaseVersion: 'MYSQL_8_0', region: 'us-east1', state: 'STOPPED' },
      { databaseVersion: 'MYSQL_8_0' },
      null,
    ]])
    const cis = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'cloudsql' }), CREDS))
    expect(cis).toHaveLength(2)
    expect(cis[0]).toMatchObject({
      external_id: 'cloudsql::proj-a::pg-main', ci_type: 'database_instance', name: 'pg-main',
      properties: { database_version: 'POSTGRES_15', tier: 'db-custom-2-8192', region: 'europe-west1', state: 'RUNNABLE', engine: 'postgres', project_id: 'proj-a' },
    })
    expect(cis[1]!.properties).toMatchObject({ engine: 'mysql', tier: undefined, state: 'STOPPED' })
    expect(h.sqlList).toHaveBeenCalledWith({ project: 'proj-a' })
  })

  it('GKE: node_count da autoscaling.maxNodeCount se abilitato, altrimenti initialNodeCount', async () => {
    h.listClusters.mockResolvedValue([{ clusters: [
      { name: 'gke-auto', location: 'europe-west1', currentMasterVersion: '1.30.1', status: 'RUNNING', endpoint: '35.0.0.1',
        nodePools: [{ initialNodeCount: 1, autoscaling: { enabled: true, maxNodeCount: 9 } }] },
      { name: 'gke-fixed', location: 'us-east1-b', nodePools: [{ initialNodeCount: 3, autoscaling: { enabled: false, maxNodeCount: 9 } }] },
      { name: 'gke-nopool', location: 'x' },
      { location: 'no-name' },
    ] }])
    const cis = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'gke' }), CREDS))
    expect(h.listClusters).toHaveBeenCalledWith({ parent: 'projects/proj-a/locations/-' })
    expect(cis.map(c => [c.external_id, c.properties['node_count']])).toEqual([
      ['gke::proj-a::europe-west1::gke-auto', 9],
      ['gke::proj-a::us-east1-b::gke-fixed', 3],
      ['gke::proj-a::x::gke-nopool', 0],
    ])
    expect(cis[0]).toMatchObject({ ci_type: 'application', name: 'gke-auto',
      properties: { cluster_name: 'gke-auto', kubernetes_version: '1.30.1', location: 'europe-west1', status: 'RUNNING', endpoint: '35.0.0.1' } })
  })

  it('LB: regole globali sempre; regionali solo con zones (regione = zona senza suffisso lettera)', async () => {
    h.globalList.mockResolvedValue([[{ id: 11, name: 'g-lb', IPAddress: '1.1.1.1', target: 'projects/p/global/targetHttpProxies/proxy-g',
      loadBalancingScheme: 'EXTERNAL', portRange: '80-80' }, { name: 'no-id' }]])
    h.regionalList.mockResolvedValue([[{ id: 22, name: 'r-lb', IPAddress: '10.0.0.9', loadBalancingScheme: 'INTERNAL', portRange: '443-443' }]])

    const noZones = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', resource_types: 'lb' }), CREDS))
    expect(noZones.map(c => c.external_id)).toEqual(['lb::proj-a::global::11'])
    expect(noZones[0]).toMatchObject({ ci_type: 'load_balancer', name: 'g-lb',
      properties: { ip_address: '1.1.1.1', target: 'proxy-g', scheme: 'EXTERNAL', port_range: '80-80', scope: 'global', project_id: 'proj-a' } })
    expect(h.regionalList).not.toHaveBeenCalled()

    const withZones = await collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'europe-west1-b, europe-west1-c, us-east1-a', resource_types: 'lb' }), CREDS))
    expect(withZones.map(c => c.external_id)).toEqual(['lb::proj-a::global::11', 'lb::proj-a::europe-west1::22', 'lb::proj-a::us-east1::22'])
    expect(h.regionalList.mock.calls.map(([p]) => p)).toEqual([
      { project: 'proj-a', region: 'europe-west1' },
      { project: 'proj-a', region: 'us-east1' },
    ])
  })

  it('un errore su una regione LB è arricchito con progetto e regione', async () => {
    h.regionalList.mockRejectedValue(new Error('quota'))
    await expect(collect(gcpConnector.scan(source({ project_ids: 'proj-a', zones: 'europe-west1-b', resource_types: 'lb' }), CREDS)))
      .rejects.toThrow('[gcp] Regional LB scan (project proj-a, region europe-west1) failed: quota')
  })
})

// ── testConnection ────────────────────────────────────────────────────────────

describe('gcpConnector.testConnection', () => {
  it('ok: ZonesClient.list sul primo progetto con maxResults 1', async () => {
    await expect(gcpConnector.testConnection(source({ project_ids: 'proj-a, proj-b' }), CREDS))
      .resolves.toEqual({ ok: true, message: 'Connected to GCP projects: proj-a, proj-b' })
    expect(h.zonesList).toHaveBeenCalledWith({ project: 'proj-a', maxResults: 1 })
    expect(h.ctors).toEqual([{ client: 'ZonesClient', opts: { credentials: KEY } }])
  })

  it('ko: errore SDK → { ok:false } con prefisso uniforme', async () => {
    h.zonesList.mockRejectedValue(new Error('invalid_grant'))
    await expect(gcpConnector.testConnection(source({ project_ids: 'proj-a' }), CREDS))
      .resolves.toEqual({ ok: false, message: 'GCP connection failed: invalid_grant' })
  })

  it('ko: config/credenziali mancanti → { ok:false } senza chiamare l\'SDK', async () => {
    await expect(gcpConnector.testConnection(source({}), CREDS))
      .resolves.toEqual({ ok: false, message: 'GCP connection failed: [gcp] config failed: campo di configurazione obbligatorio mancante: project_ids' })
    await expect(gcpConnector.testConnection(source({ project_ids: 'proj-a' }), {}))
      .resolves.toEqual({ ok: false, message: 'GCP connection failed: [gcp] credentials failed: credenziali mancanti: service_account_json' })
    expect(h.zonesList).not.toHaveBeenCalled()
  })
})

describe('gcpConnector metadata', () => {
  it('dichiara service_account_json obbligatorio e i campi di config', () => {
    expect(gcpConnector.getRequiredCredentialFields()).toMatchObject([{ name: 'service_account_json', required: true, type: 'password' }])
    expect(gcpConnector.getConfigFields()).toMatchObject([
      { name: 'project_ids', required: true },
      { name: 'resource_types', default_value: 'compute, cloudsql, gke, lb' },
      { name: 'zones', required: false },
    ])
  })
})
