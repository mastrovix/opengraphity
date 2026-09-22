/**
 * Kubernetes discovery: incomplete objects coming back from the API server.
 *
 * A real cluster returns objects with missing pieces (a node still joining
 * has no conditions, a service may have no selector match, a workload
 * without a selector, an ingress whose load balancer publishes only a
 * hostname). If the connector mishandled them, one odd object would either
 * abort the whole namespace scan or create a CI with an empty external id
 * that later merges unrelated resources into one CMDB record. These tests
 * pin that nameless objects are skipped, a node without conditions is
 * reported as degraded (never assumed healthy), and a workload without a
 * selector is never linked to a service. @kubernetes/client-node is mocked:
 * no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

type List = { items: unknown[] }

const h = vi.hoisted(() => {
  const listNode                  = vi.fn<() => Promise<List>>()
  const listNamespace             = vi.fn<() => Promise<List>>()
  const listNamespacedService     = vi.fn<() => Promise<List>>()
  const listNamespacedDeployment  = vi.fn<() => Promise<List>>()
  const listNamespacedStatefulSet = vi.fn<() => Promise<List>>()
  const listNamespacedIngress     = vi.fn<() => Promise<List>>()
  class CoreV1Api       { listNode = listNode; listNamespace = listNamespace; listNamespacedService = listNamespacedService }
  class AppsV1Api       { listNamespacedDeployment = listNamespacedDeployment; listNamespacedStatefulSet = listNamespacedStatefulSet }
  class NetworkingV1Api { listNamespacedIngress = listNamespacedIngress }
  class KubeConfig {
    loadFromString = vi.fn()
    loadFromOptions = vi.fn()
    makeApiClient<T>(ctor: new () => T): T { return new ctor() }
  }
  return {
    listNode, listNamespace, listNamespacedService, listNamespacedDeployment, listNamespacedStatefulSet,
    listNamespacedIngress, CoreV1Api, AppsV1Api, NetworkingV1Api, KubeConfig,
  }
})

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: h.KubeConfig, CoreV1Api: h.CoreV1Api, AppsV1Api: h.AppsV1Api, NetworkingV1Api: h.NetworkingV1Api,
}))

const { kubernetesConnector } = await import('../connectors/kubernetes.js')

const CREDS = { kubeconfig: 'apiVersion: v1\nkind: Config\n' }

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

// `spec.template` is a required field of Deployment/StatefulSet: fixtures carry it.
const EMPTY: List = { items: [] }

beforeEach(() => {
  vi.clearAllMocks()
  for (const f of [h.listNode, h.listNamespace, h.listNamespacedService, h.listNamespacedDeployment, h.listNamespacedStatefulSet, h.listNamespacedIngress]) {
    f.mockResolvedValue(EMPTY)
  }
})

describe('incomplete objects', () => {
  it('a node without conditions is degraded, not assumed healthy', async () => {
    h.listNode.mockResolvedValue({ items: [{ metadata: { name: 'n1' }, status: {} }] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'node' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]!.properties['status']).toBe('degraded')
  })

  it('nameless statefulsets, services and ingresses are skipped (no CI with an empty external id)', async () => {
    h.listNamespacedStatefulSet.mockResolvedValue({ items: [{ metadata: {} }, { metadata: { name: 'db' }, spec: { template: {}, volumeClaimTemplates: [{ metadata: {} }, { metadata: { name: 'data' } }] } }] })
    h.listNamespacedService.mockResolvedValue({ items: [{ metadata: {}, spec: { type: 'NodePort' } }] })
    h.listNamespacedIngress.mockResolvedValue({ items: [{ metadata: {} }] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'statefulset,service,ingress' }), CREDS))
    expect(cis.map((c) => c.external_id)).toEqual(['statefulset::ns::db'])
    // Why: a template without a name must not leave a stray ", " in the list.
    expect(cis[0]!.properties['volume_claim_templates']).toBe('data')
  })

  it('a workload without a selector is never linked to a service; the ingress hostname is used when there is no IP', async () => {
    h.listNamespacedDeployment.mockResolvedValue({ items: [
      { metadata: { name: 'no-selector' }, spec: { template: {} } },
      { metadata: { name: 'web' }, spec: { template: {}, selector: { matchLabels: { app: 'web' } } } },
    ] })
    h.listNamespacedService.mockResolvedValue({ items: [{
      metadata: { name: 'web-lb' },
      spec: { type: 'LoadBalancer', selector: { app: 'web' }, ports: [{ port: 443 }] },
      status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }, {}] } },
    }] })
    const cis = await collect(kubernetesConnector.scan(source({ namespaces: 'ns', resource_types: 'deployment,service' }), CREDS))
    const svc = cis.find((c) => c.external_id === 'service::ns::web-lb')!
    expect(svc.relationships.map((r) => r.target_external_id)).toEqual(['deployment::ns::web'])
    expect(svc.properties['external_ip']).toBe('lb.example.com')
    expect(svc.properties['ports']).toBe('443/TCP')
  })
})
