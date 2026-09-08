/**
 * kubernetesConnector — @kubernetes/client-node mockato (KubeConfig + API
 * client), nessuna rete. Pinna: credenziali (kubeconfig | bearer_token +
 * server_url), resource_types sconosciuti, mapping label→tag, namespace
 * configurati vs elencati (con errore esplicito se l'elenco fallisce),
 * Service → CI solo LoadBalancer/NodePort con relazioni via selector,
 * Ingress con relazioni ai Service, testConnection ok/ko.
 *
 * Paginazione: il connettore chiama le list SENZA `limit`/`continue`: l'API
 * server restituisce l'intero elenco in una risposta. Si pinna che non venga
 * passato alcun `limit` (che renderebbe la risposta troncata e ignorata).
 * include_stopped: nessun flag nel connettore K8s (i Pod sono esclusi per
 * design, i nodi NotReady arrivano con status 'degraded').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

type Params = Record<string, unknown> | undefined
type List = { items: unknown[] }

const h = vi.hoisted(() => {
  const loadFromString  = vi.fn<(s: string) => void>()
  const loadFromOptions = vi.fn<(o: unknown) => void>()
  const listNode                  = vi.fn<(p?: Params) => Promise<List>>()
  const listNamespace             = vi.fn<(p?: Params) => Promise<List>>()
  const listNamespacedService     = vi.fn<(p: Params) => Promise<List>>()
  const listNamespacedDeployment  = vi.fn<(p: Params) => Promise<List>>()
  const listNamespacedStatefulSet = vi.fn<(p: Params) => Promise<List>>()
  const listNamespacedIngress     = vi.fn<(p: Params) => Promise<List>>()
  const made: string[] = []
  class CoreV1Api       { listNode = listNode; listNamespace = listNamespace; listNamespacedService = listNamespacedService }
  class AppsV1Api       { listNamespacedDeployment = listNamespacedDeployment; listNamespacedStatefulSet = listNamespacedStatefulSet }
  class NetworkingV1Api { listNamespacedIngress = listNamespacedIngress }
  class KubeConfig {
    loadFromString  = loadFromString
    loadFromOptions = loadFromOptions
    makeApiClient<T>(ctor: new () => T): T { made.push(ctor.name); return new ctor() }
  }
  return {
    loadFromString, loadFromOptions, listNode, listNamespace, listNamespacedService,
    listNamespacedDeployment, listNamespacedStatefulSet, listNamespacedIngress, made,
    CoreV1Api, AppsV1Api, NetworkingV1Api, KubeConfig,
  }
})

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: h.KubeConfig, CoreV1Api: h.CoreV1Api, AppsV1Api: h.AppsV1Api, NetworkingV1Api: h.NetworkingV1Api,
}))

const { kubernetesConnector } = await import('../connectors/kubernetes.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const KUBECONFIG = 'apiVersion: v1\nkind: Config\ncurrent-context: ctx\n'
const CREDS      = { kubeconfig: KUBECONFIG }

function source(config: Record<string, unknown>): SyncSourceConfig {
  return {
    id: 'src-k8s', tenant_id: 't1', name: 'k8s', connector_type: 'kubernetes',
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

const EMPTY: List = { items: [] }

beforeEach(() => {
  vi.clearAllMocks()
  h.made.length = 0
  h.listNode.mockResolvedValue(EMPTY)
  h.listNamespace.mockResolvedValue({ items: [{ metadata: { name: 'default' } }, { metadata: { name: 'kube-system' } }, { metadata: {} }] })
  h.listNamespacedService.mockResolvedValue(EMPTY)
  h.listNamespacedDeployment.mockResolvedValue(EMPTY)
  h.listNamespacedStatefulSet.mockResolvedValue(EMPTY)
  h.listNamespacedIngress.mockResolvedValue(EMPTY)
})

// ── Credenziali / config ──────────────────────────────────────────────────────

describe('kubernetesConnector.scan — credenziali e config', () => {
  it('senza kubeconfig né bearer_token+server_url → errore esplicito', async () => {
    const msg = '[kubernetes] credentials failed: kubeconfig or (bearer_token + server_url) is required'
    await expect(collect(kubernetesConnector.scan(source({}), {}))).rejects.toThrow(msg)
    await expect(collect(kubernetesConnector.scan(source({}), { bearer_token: 'tok' }))).rejects.toThrow(msg)
    await expect(collect(kubernetesConnector.scan(source({ server_url: 'https://k8s:6443' }), {}))).rejects.toThrow(msg)
    expect(h.loadFromString).not.toHaveBeenCalled()
    expect(h.loadFromOptions).not.toHaveBeenCalled()
  })

  it('kubeconfig → loadFromString; bearer_token + server_url → loadFromOptions con token e server', async () => {
    await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'node' }), CREDS))
    expect(h.loadFromString).toHaveBeenCalledWith(KUBECONFIG)

    await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'node', server_url: 'https://k8s:6443' }), { bearer_token: 'tok-1' }))
    expect(h.loadFromOptions).toHaveBeenCalledWith({
      clusters:       [{ name: 'cluster', server: 'https://k8s:6443', skipTLSVerify: true }],
      users:          [{ name: 'user', token: 'tok-1' }],
      contexts:       [{ name: 'ctx', cluster: 'cluster', user: 'user' }],
      currentContext: 'ctx',
    })
  })

  it('resource_types sconosciuti → errore esplicito prima di caricare la kubeconfig', async () => {
    await expect(collect(kubernetesConnector.scan(source({ resource_types: 'node, pod' }), CREDS)))
      .rejects.toThrow('[kubernetes] config failed: resource_types sconosciuti: pod (ammessi: node, deployment, statefulset, service, ingress)')
    expect(h.loadFromString).not.toHaveBeenCalled()
  })

  it('costruisce i tre client API dalla kubeconfig', async () => {
    await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'node' }), CREDS))
    expect(h.made).toEqual(['CoreV1Api', 'AppsV1Api', 'NetworkingV1Api'])
  })
})

// ── Namespace ─────────────────────────────────────────────────────────────────

describe('kubernetesConnector.scan — namespace', () => {
  it('namespaces configurati: nessuna listNamespace, scansione per ciascuno', async () => {
    await collect(kubernetesConnector.scan(source({ namespaces: 'app, infra', resource_types: 'deployment' }), CREDS))
    expect(h.listNamespace).not.toHaveBeenCalled()
    expect(h.listNamespacedDeployment.mock.calls.map(([p]) => p)).toEqual([{ namespace: 'app' }, { namespace: 'infra' }])
  })

  it('senza namespaces li elenca dal cluster (quelli senza nome scartati)', async () => {
    await collect(kubernetesConnector.scan(source({ resource_types: 'deployment' }), CREDS))
    expect(h.listNamespace).toHaveBeenCalledTimes(1)
    expect(h.listNamespacedDeployment.mock.calls.map(([p]) => p)).toEqual([{ namespace: 'default' }, { namespace: 'kube-system' }])
  })

  it('listNamespace fallisce → errore esplicito che suggerisce di configurare "namespaces"', async () => {
    h.listNamespace.mockRejectedValue(new Error('namespaces is forbidden'))
    await expect(collect(kubernetesConnector.scan(source({ resource_types: 'deployment' }), CREDS)))
      .rejects.toThrow('[kubernetes] Namespace list — set the "namespaces" config field explicitly if the credential cannot list namespaces failed: namespaces is forbidden')
  })
})

// ── Nodi ──────────────────────────────────────────────────────────────────────

describe('kubernetesConnector.scan — nodi', () => {
  it('mappa nodo + label nel CI normalizzato; Ready → active, altrimenti degraded', async () => {
    h.listNode.mockResolvedValue({ items: [
      { metadata: { name: 'node-a', labels: { 'kubernetes.io/os': 'linux', 'node-role.kubernetes.io/control-plane': '' } },
        spec: { providerID: 'aws:///eu-west-1a/i-1' },
        status: { conditions: [{ type: 'Ready', status: 'True' }],
          nodeInfo: { architecture: 'amd64', osImage: 'Ubuntu 22.04', kernelVersion: '6.5.0', kubeletVersion: 'v1.30.2' } } },
      { metadata: { name: 'node-b' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } },
      { metadata: {} },
    ] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'x', resource_types: 'node' }), CREDS))
    expect(cis).toHaveLength(2)
    expect(cis[0]).toEqual({
      external_id: 'node::node-a',
      source:      'kubernetes',
      ci_type:     'server',
      name:        'node-a',
      properties: {
        architecture:    'amd64',
        os_image:        'Ubuntu 22.04',
        kernel_version:  '6.5.0',
        kubelet_version: 'v1.30.2',
        status:          'active',
        provider_id:     'aws:///eu-west-1a/i-1',
      },
      tags:          { 'kubernetes.io/os': 'linux', 'node-role.kubernetes.io/control-plane': '' },
      relationships: [],
    })
    expect(cis[1]).toMatchObject({ name: 'node-b', properties: { status: 'degraded' }, tags: {} })
  })

  it('chiama listNode senza limit/continue (elenco completo in una risposta)', async () => {
    await collect(kubernetesConnector.scan(source({ namespaces: 'x', resource_types: 'node' }), CREDS))
    expect(h.listNode).toHaveBeenCalledTimes(1)
    expect(h.listNode.mock.calls[0]).toEqual([])
  })

  it('un errore dell\'API è rilanciato arricchito', async () => {
    h.listNode.mockRejectedValue(new Error('Unauthorized'))
    await expect(collect(kubernetesConnector.scan(source({ namespaces: 'x', resource_types: 'node' }), CREDS)))
      .rejects.toThrow('[kubernetes] Node scan failed: Unauthorized')
  })
})

// ── Workload / Service / Ingress ──────────────────────────────────────────────

describe('kubernetesConnector.scan — deployment, statefulset, service, ingress', () => {
  const deployment = (ns: string, name: string, app: string) => ({
    metadata: { name, labels: { app, tier: 'web' } },
    spec: { replicas: 3, strategy: { type: 'RollingUpdate' }, selector: { matchLabels: { app } },
      template: { spec: { containers: [{ image: `repo/${name}:1.2` }] } } },
    status: { readyReplicas: 2, availableReplicas: 2 },
  })

  it('Deployment: nome ns/name, immagine del primo container, label → tag', async () => {
    h.listNamespacedDeployment.mockResolvedValue({ items: [deployment('app', 'api', 'api'), { metadata: {} }] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'app', resource_types: 'deployment' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toEqual({
      external_id: 'deployment::app::api', source: 'kubernetes', ci_type: 'application', name: 'app/api',
      properties: { namespace: 'app', replicas: 3, ready_replicas: 2, available_replicas: 2, strategy: 'RollingUpdate', image: 'repo/api:1.2' },
      tags: { app: 'api', tier: 'web' }, relationships: [],
    })
  })

  it('StatefulSet: service_name e volume claim template concatenati', async () => {
    h.listNamespacedStatefulSet.mockResolvedValue({ items: [{
      metadata: { name: 'pg', labels: { app: 'pg' } },
      spec: { replicas: 2, serviceName: 'pg-headless', selector: { matchLabels: { app: 'pg' } },
        template: { spec: { containers: [{ image: 'postgres:16' }] } },
        volumeClaimTemplates: [{ metadata: { name: 'data' } }, { metadata: { name: 'wal' } }, { metadata: {} }] },
      status: { readyReplicas: 2 },
    }] })
    const [ci] = await collect(kubernetesConnector.scan(source({ namespaces: 'db', resource_types: 'statefulset' }), CREDS))
    expect(ci).toMatchObject({
      external_id: 'statefulset::db::pg', ci_type: 'application', name: 'db/pg',
      properties: { namespace: 'db', replicas: 2, ready_replicas: 2, image: 'postgres:16', service_name: 'pg-headless', volume_claim_templates: 'data, wal' },
    })
  })

  it('Service: CI solo per LoadBalancer/NodePort, relazioni DEPENDS_ON verso i workload con selector compatibile', async () => {
    h.listNamespacedDeployment.mockResolvedValue({ items: [deployment('app', 'api', 'api'), deployment('app', 'other', 'other')] })
    h.listNamespacedStatefulSet.mockResolvedValue({ items: [{ metadata: { name: 'pg' }, spec: { selector: { matchLabels: { app: 'api', role: 'db' } }, template: { spec: {} } } }] })
    h.listNamespacedService.mockResolvedValue({ items: [
      { metadata: { name: 'api-lb', labels: { exposed: 'yes' } },
        spec: { type: 'LoadBalancer', clusterIP: '10.96.0.10', selector: { app: 'api' },
          ports: [{ port: 443, protocol: 'TCP' }, { port: 80, nodePort: 30080 }] },
        status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }, { hostname: 'lb.example.com' }] } } },
      { metadata: { name: 'api-internal' }, spec: { type: 'ClusterIP', selector: { app: 'api' } } },
      { metadata: { name: 'np' }, spec: { type: 'NodePort', clusterIP: '10.96.0.11', selector: {} } },
    ] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'app', resource_types: 'service, deployment, statefulset' }), CREDS))
    const services = cis.filter(c => c.external_id.startsWith('service::'))
    expect(services.map(c => c.name)).toEqual(['app/api-lb', 'app/np'])
    expect(services[0]).toEqual({
      external_id: 'service::app::api-lb', source: 'kubernetes', ci_type: 'load_balancer', name: 'app/api-lb',
      properties: { namespace: 'app', cluster_ip: '10.96.0.10', external_ip: '1.2.3.4, lb.example.com', ports: '443/TCP, 80:30080/TCP', type: 'LoadBalancer' },
      tags: { exposed: 'yes' },
      relationships: [
        { target_external_id: 'deployment::app::api', relation_type: 'DEPENDS_ON', direction: 'outgoing' },
        { target_external_id: 'statefulset::app::pg', relation_type: 'DEPENDS_ON', direction: 'outgoing' },
      ],
    })
    expect(services[1]).toMatchObject({ properties: { type: 'NodePort', external_ip: undefined, ports: undefined }, relationships: [] })
  })

  it('Service: i workload non richiesti in resource_types non vengono interrogati per le relazioni', async () => {
    h.listNamespacedService.mockResolvedValue({ items: [{ metadata: { name: 's' }, spec: { type: 'NodePort', selector: { app: 'x' } } }] })
    await collect(kubernetesConnector.scan(source({ namespaces: 'app', resource_types: 'service' }), CREDS))
    expect(h.listNamespacedDeployment).not.toHaveBeenCalled()
    expect(h.listNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('Ingress: host, tls, ingress_class (annotation prima di spec) e relazioni verso i Service', async () => {
    h.listNamespacedIngress.mockResolvedValue({ items: [
      { metadata: { name: 'web', annotations: { 'kubernetes.io/ingress.class': 'nginx-legacy' }, labels: { team: 'web' } },
        spec: { ingressClassName: 'nginx', tls: [{ hosts: ['a.example.com'] }],
          rules: [
            { host: 'a.example.com', http: { paths: [{ backend: { service: { name: 'api-lb' } } }, { backend: {} }] } },
            { host: 'b.example.com', http: { paths: [{ backend: { service: { name: 'web' } } }] } },
            { host: null },
          ] } },
      { metadata: { name: 'bare' }, spec: { ingressClassName: 'traefik' } },
    ] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'app', resource_types: 'ingress' }), CREDS))
    expect(cis[0]).toEqual({
      external_id: 'ingress::app::web', source: 'kubernetes', ci_type: 'load_balancer', name: 'app/web',
      properties: { namespace: 'app', hosts: 'a.example.com, b.example.com', tls: true, ingress_class: 'nginx-legacy' },
      tags: { team: 'web' },
      relationships: [
        { target_external_id: 'service::app::api-lb', relation_type: 'DEPENDS_ON', direction: 'outgoing' },
        { target_external_id: 'service::app::web',    relation_type: 'DEPENDS_ON', direction: 'outgoing' },
      ],
    })
    expect(cis[1]).toMatchObject({ properties: { hosts: undefined, tls: false, ingress_class: 'traefik' }, relationships: [] })
  })

  it('un errore su uno scanner namespaced è arricchito con scan e namespace', async () => {
    h.listNamespacedIngress.mockRejectedValue(new Error('forbidden'))
    await expect(collect(kubernetesConnector.scan(source({ namespaces: 'app', resource_types: 'ingress' }), CREDS)))
      .rejects.toThrow('[kubernetes] Ingress scan (namespace app) failed: forbidden')
  })
})

// ── testConnection ────────────────────────────────────────────────────────────

describe('kubernetesConnector.testConnection', () => {
  it('ok: conta i namespace', async () => {
    await expect(kubernetesConnector.testConnection(source({}), CREDS))
      .resolves.toEqual({ ok: true, message: 'Connected — 3 namespaces found' })
    expect(h.loadFromString).toHaveBeenCalledWith(KUBECONFIG)
  })

  it('ko: errore API → { ok:false } con prefisso uniforme', async () => {
    h.listNamespace.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(kubernetesConnector.testConnection(source({}), CREDS))
      .resolves.toEqual({ ok: false, message: 'Kubernetes connection failed: ECONNREFUSED' })
  })

  it('ko: credenziali mancanti → { ok:false } senza chiamare l\'API', async () => {
    await expect(kubernetesConnector.testConnection(source({}), {}))
      .resolves.toEqual({ ok: false, message: 'Kubernetes connection failed: [kubernetes] credentials failed: kubeconfig or (bearer_token + server_url) is required' })
    expect(h.listNamespace).not.toHaveBeenCalled()
  })
})

describe('kubernetesConnector metadata', () => {
  it('kubeconfig e bearer_token entrambi opzionali (alternativi); server_url, resource_types, namespaces in config', () => {
    expect(kubernetesConnector.getRequiredCredentialFields().map(f => [f.name, f.required]))
      .toEqual([['kubeconfig', false], ['bearer_token', false]])
    expect(kubernetesConnector.getConfigFields()).toMatchObject([
      { name: 'server_url', required: false },
      { name: 'resource_types', default_value: 'node, deployment, statefulset, service, ingress' },
      { name: 'namespaces', required: false },
    ])
    expect(kubernetesConnector.supportedCITypes).toEqual(['server', 'application', 'load_balancer'])
  })
})
