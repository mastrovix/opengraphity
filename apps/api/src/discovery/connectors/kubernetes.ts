import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import type { AppsV1Api, CoreV1Api, KubeConfig, NetworkingV1Api } from '@kubernetes/client-node'
import { ConnectorError, guardScan, probeConnection, resourceTypeSet, resourceTypesField, tagsToRecord } from './base.js'
import { splitList } from './normalize.js'

// ── Kubernetes Connector ──────────────────────────────────────────────────────
// Discovers Nodes, Deployments, StatefulSets, LoadBalancer/NodePort Services,
// and Ingress resources. Pods are excluded as ephemeral.
// Credentials: kubeconfig (YAML string) or bearer_token + server_url.
// Config: namespaces (comma-sep), resource_types (comma-sep).

const TYPE = 'kubernetes'

type K8sConfig = {
  namespaces?:     string
  server_url?:     string
  resource_types?: string
}

const ALL_RESOURCE_TYPES = ['node', 'deployment', 'statefulset', 'service', 'ingress'] as const

async function makeKubeConfig(creds: Record<string, string>, cfg: K8sConfig): Promise<KubeConfig> {
  const { KubeConfig } = await import('@kubernetes/client-node')
  const kc = new KubeConfig()
  if (creds['kubeconfig']) {
    kc.loadFromString(creds['kubeconfig'])
  } else if (creds['bearer_token'] && cfg.server_url) {
    kc.loadFromOptions({
      clusters:  [{ name: 'cluster', server: cfg.server_url, skipTLSVerify: true }],
      users:     [{ name: 'user', token: creds['bearer_token'] }],
      contexts:  [{ name: 'ctx', cluster: 'cluster', user: 'user' }],
      currentContext: 'ctx',
    })
  } else {
    throw new ConnectorError(TYPE, 'credentials', new Error('kubeconfig or (bearer_token + server_url) is required'))
  }
  return kc
}

/** Check if a deployment/statefulset selector matches a service selector */
function selectorsMatch(
  workloadSelector: Record<string, string | undefined | null> | undefined,
  serviceSelector:  Record<string, string | undefined | null> | undefined,
): boolean {
  if (!workloadSelector || !serviceSelector) return false
  return Object.entries(serviceSelector).every(([k, v]) => v != null && workloadSelector[k] === v)
}

function base(externalId: string, ciType: string, name: string, properties: Record<string, unknown>, labels: Record<string, string | undefined | null> | undefined): DiscoveredCI {
  return { external_id: externalId, source: TYPE, ci_type: ciType, name, properties, tags: tagsToRecord(labels), relationships: [] }
}

interface K8sClients {
  coreApi:    CoreV1Api
  appsApi:    AppsV1Api
  networkApi: NetworkingV1Api
}

interface K8sScanContext extends K8sClients {
  types: Set<string>
}

// ── Cluster-wide scanners ─────────────────────────────────────────────────────

async function* scanNodes(ctx: K8sScanContext): AsyncIterable<DiscoveredCI> {
  const nodeList = await ctx.coreApi.listNode()
  for (const node of nodeList.items) {
    const name = node.metadata?.name
    if (!name) continue
    const ready = (node.status?.conditions ?? []).some(
      (c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True',
    )
    yield base(`node::${name}`, 'server', name, {
      architecture:    node.status?.nodeInfo?.architecture,
      os_image:        node.status?.nodeInfo?.osImage,
      kernel_version:  node.status?.nodeInfo?.kernelVersion,
      kubelet_version: node.status?.nodeInfo?.kubeletVersion,
      status:          ready ? 'active' : 'degraded',
      provider_id:     node.spec?.providerID,
    }, node.metadata?.labels)
  }
}

// ── Namespaced scanners ───────────────────────────────────────────────────────

async function* scanDeployments(ctx: K8sScanContext, ns: string): AsyncIterable<DiscoveredCI> {
  const depList = await ctx.appsApi.listNamespacedDeployment({ namespace: ns })
  for (const dep of depList.items) {
    const name = dep.metadata?.name
    if (!name) continue
    yield base(`deployment::${ns}::${name}`, 'application', `${ns}/${name}`, {
      namespace:          ns,
      replicas:           dep.spec?.replicas,
      ready_replicas:     dep.status?.readyReplicas,
      available_replicas: dep.status?.availableReplicas,
      strategy:           dep.spec?.strategy?.type,
      image:              dep.spec?.template.spec?.containers?.[0]?.image,
    }, dep.metadata?.labels)
  }
}

async function* scanStatefulSets(ctx: K8sScanContext, ns: string): AsyncIterable<DiscoveredCI> {
  const ssList = await ctx.appsApi.listNamespacedStatefulSet({ namespace: ns })
  for (const ss of ssList.items) {
    const name = ss.metadata?.name
    if (!name) continue
    const pvcNames = (ss.spec?.volumeClaimTemplates ?? [])
      .map((t: { metadata?: { name?: string | null } }) => t.metadata?.name ?? '')
      .filter(Boolean)
      .join(', ')
    yield base(`statefulset::${ns}::${name}`, 'application', `${ns}/${name}`, {
      namespace:              ns,
      replicas:               ss.spec?.replicas,
      ready_replicas:         ss.status?.readyReplicas,
      image:                  ss.spec?.template.spec?.containers?.[0]?.image,
      service_name:           ss.spec?.serviceName,
      volume_claim_templates: pvcNames || undefined,
    }, ss.metadata?.labels)
  }
}

async function* scanServices(ctx: K8sScanContext, ns: string): AsyncIterable<DiscoveredCI> {
  const svcList = await ctx.coreApi.listNamespacedService({ namespace: ns })
  const depList = ctx.types.has('deployment')  ? await ctx.appsApi.listNamespacedDeployment({ namespace: ns })  : { items: [] }
  const ssList  = ctx.types.has('statefulset') ? await ctx.appsApi.listNamespacedStatefulSet({ namespace: ns }) : { items: [] }

  for (const svc of svcList.items) {
    const name    = svc.metadata?.name
    const svcType = svc.spec?.type
    if (!name) continue

    // Compute relations toward matching workloads
    const svcSelector = svc.spec?.selector as Record<string, string> | undefined
    const relationships: DiscoveredRelation[] = []
    if (svcSelector && Object.keys(svcSelector).length) {
      for (const dep of depList.items) {
        const matchLabels = dep.spec?.selector?.matchLabels as Record<string, string> | undefined
        if (dep.metadata?.name && selectorsMatch(matchLabels, svcSelector)) {
          relationships.push({ target_external_id: `deployment::${ns}::${dep.metadata.name}`, relation_type: 'DEPENDS_ON', direction: 'outgoing' })
        }
      }
      for (const ss of ssList.items) {
        const matchLabels = ss.spec?.selector?.matchLabels as Record<string, string> | undefined
        if (ss.metadata?.name && selectorsMatch(matchLabels, svcSelector)) {
          relationships.push({ target_external_id: `statefulset::${ns}::${ss.metadata.name}`, relation_type: 'DEPENDS_ON', direction: 'outgoing' })
        }
      }
    }

    // Only create CI for LoadBalancer or NodePort services
    if (svcType !== 'LoadBalancer' && svcType !== 'NodePort') continue

    const ingress    = svc.status?.loadBalancer?.ingress ?? []
    const externalIp = ingress.map((i: { ip?: string; hostname?: string }) => i.ip ?? i.hostname ?? '').filter(Boolean).join(', ')
    const ports      = (svc.spec?.ports ?? [])
      .map((p: { port?: number; nodePort?: number; protocol?: string }) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
      .join(', ')

    yield {
      ...base(`service::${ns}::${name}`, 'load_balancer', `${ns}/${name}`, {
        namespace:   ns,
        cluster_ip:  svc.spec?.clusterIP,
        external_ip: externalIp || undefined,
        ports:       ports || undefined,
        type:        svcType,
      }, svc.metadata?.labels),
      relationships,
    }
  }
}

async function* scanIngresses(ctx: K8sScanContext, ns: string): AsyncIterable<DiscoveredCI> {
  const ingList = await ctx.networkApi.listNamespacedIngress({ namespace: ns })
  for (const ing of ingList.items) {
    const name = ing.metadata?.name
    if (!name) continue

    const rules = ing.spec?.rules ?? []
    const hosts = rules.map((r: { host?: string | null }) => r.host ?? '').filter(Boolean).join(', ')

    const relationships: DiscoveredRelation[] = []
    for (const rule of rules) {
      for (const path of (rule as { http?: { paths?: { backend?: { service?: { name?: string } } }[] } }).http?.paths ?? []) {
        const svcName = path.backend?.service?.name
        if (svcName) relationships.push({ target_external_id: `service::${ns}::${svcName}`, relation_type: 'DEPENDS_ON', direction: 'outgoing' })
      }
    }

    const ingressClass = ing.metadata?.annotations?.['kubernetes.io/ingress.class']
      ?? (ing.spec as { ingressClassName?: string } | undefined)?.ingressClassName

    yield {
      ...base(`ingress::${ns}::${name}`, 'load_balancer', `${ns}/${name}`, {
        namespace:     ns,
        hosts:         hosts || undefined,
        tls:           Boolean((ing.spec as { tls?: unknown[] } | undefined)?.tls?.length),
        ingress_class: ingressClass,
      }, ing.metadata?.labels),
      relationships,
    }
  }
}

const NAMESPACED_SCANNERS: Record<Exclude<typeof ALL_RESOURCE_TYPES[number], 'node'>, {
  label: string
  run:   (ctx: K8sScanContext, ns: string) => AsyncIterable<DiscoveredCI>
}> = {
  deployment:  { label: 'Deployment scan',  run: scanDeployments },
  statefulset: { label: 'StatefulSet scan', run: scanStatefulSets },
  service:     { label: 'Service scan',     run: scanServices },
  ingress:     { label: 'Ingress scan',     run: scanIngresses },
}

async function resolveNamespaces(ctx: K8sScanContext, configured: string[]): Promise<string[]> {
  if (configured.length) return configured
  try {
    const nsList = await ctx.coreApi.listNamespace()
    return nsList.items.map((n: { metadata?: { name?: string | null } }) => n.metadata?.name ?? '').filter(Boolean)
  } catch (err) {
    throw new ConnectorError(TYPE, 'Namespace list — set the "namespaces" config field explicitly if the credential cannot list namespaces', err)
  }
}

// ── Connector ─────────────────────────────────────────────────────────────────

export const kubernetesConnector: Connector = {
  type:             TYPE,
  displayName:      'Kubernetes',
  supportedCITypes: ['server', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg   = config.config as K8sConfig
    const types = resourceTypeSet(TYPE, cfg.resource_types, ALL_RESOURCE_TYPES)

    const { CoreV1Api, AppsV1Api, NetworkingV1Api } = await import('@kubernetes/client-node')
    const kc  = await makeKubeConfig(creds, cfg)
    const ctx: K8sScanContext = {
      types,
      coreApi:    kc.makeApiClient(CoreV1Api),
      appsApi:    kc.makeApiClient(AppsV1Api),
      networkApi: kc.makeApiClient(NetworkingV1Api),
    }

    if (types.has('node')) {
      yield* guardScan(TYPE, 'Node scan', () => scanNodes(ctx))
    }

    for (const ns of await resolveNamespaces(ctx, splitList(cfg.namespaces))) {
      for (const type of Object.keys(NAMESPACED_SCANNERS) as (keyof typeof NAMESPACED_SCANNERS)[]) {
        if (!types.has(type)) continue
        const { label, run } = NAMESPACED_SCANNERS[type]
        yield* guardScan(TYPE, `${label} (namespace ${ns})`, () => run(ctx, ns))
      }
    }
  },

  testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    return probeConnection('Kubernetes', async () => {
      const { CoreV1Api } = await import('@kubernetes/client-node')
      const kc      = await makeKubeConfig(creds, config.config as K8sConfig)
      const coreApi = kc.makeApiClient(CoreV1Api)
      const nsList  = await coreApi.listNamespace()
      return `Connected — ${nsList.items.length} namespaces found`
    })
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return [
      {
        name:      'kubeconfig',
        label:     'Kubeconfig',
        type:      'password',
        required:  false,
        help_text: 'Paste the kubeconfig YAML/JSON (preferred)',
      },
      {
        name:      'bearer_token',
        label:     'Bearer Token',
        type:      'password',
        required:  false,
        help_text: 'Service account bearer token (alternative to kubeconfig)',
      },
    ]
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'server_url',
        label:     'API Server URL',
        type:      'text',
        required:  false,
        help_text: 'e.g. https://my-cluster.example.com:6443 (required when using bearer_token)',
      },
      resourceTypesField(ALL_RESOURCE_TYPES),
      {
        name:      'namespaces',
        label:     'Namespaces',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of namespaces (empty = all)',
      },
    ]
  },
}
