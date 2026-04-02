import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── Kubernetes Connector ──────────────────────────────────────────────────────
// Discovers Nodes, Deployments, StatefulSets, LoadBalancer/NodePort Services,
// and Ingress resources. Pods are excluded as ephemeral.
// Credentials: kubeconfig (YAML string) or bearer_token + server_url.
// Config: namespaces (comma-sep), resource_types (comma-sep).

type K8sConfig = {
  namespaces?:     string
  server_url?:     string
  resource_types?: string
}

const ALL_RESOURCE_TYPES = ['node', 'deployment', 'statefulset', 'service', 'ingress'] as const

function splitParam(s?: string): string[] {
  if (!s) return []
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

function getResourceTypes(config: K8sConfig): Set<string> {
  const raw = config.resource_types
  if (!raw) return new Set(ALL_RESOURCE_TYPES)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

function makeKubeConfig(creds: Record<string, string>, cfg: K8sConfig) {
  const { KubeConfig } = require('@kubernetes/client-node') as typeof import('@kubernetes/client-node')
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
    throw new Error('Kubernetes connector: kubeconfig or (bearer_token + server_url) is required')
  }
  return kc
}

function labelsToTags(labels: Record<string, string | undefined | null> | undefined): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (v != null) tags[k] = v
  }
  return tags
}

/** Check if a deployment/statefulset selector matches a service selector */
function selectorsMatch(
  workloadSelector: Record<string, string | undefined | null> | undefined,
  serviceSelector:  Record<string, string | undefined | null> | undefined,
): boolean {
  if (!workloadSelector || !serviceSelector) return false
  return Object.entries(serviceSelector).every(
    ([k, v]) => v != null && workloadSelector[k] === v,
  )
}

export const kubernetesConnector: Connector = {
  type:             'kubernetes',
  displayName:      'Kubernetes',
  supportedCITypes: ['server', 'application', 'load_balancer'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg        = config.config as K8sConfig
    const namespaces = splitParam(cfg.namespaces)
    const types      = getResourceTypes(cfg)

    const k8s = await import('@kubernetes/client-node')
    const { CoreV1Api, AppsV1Api, NetworkingV1Api } = k8s

    const kc          = makeKubeConfig(creds, cfg)
    const coreApi     = kc.makeApiClient(CoreV1Api)
    const appsApi     = kc.makeApiClient(AppsV1Api)
    const networkApi  = kc.makeApiClient(NetworkingV1Api)

    // ── Nodes ────────────────────────────────────────────────────────────
    if (types.has('node')) {
      try {
        const nodeList = await coreApi.listNode()
        for (const node of nodeList.items) {
          const name = node.metadata?.name
          if (!name) continue

          const conditions = node.status?.conditions ?? []
          const ready      = conditions.some(
            (c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True',
          )

          yield {
            external_id: `node::${name}`,
            source:      'kubernetes',
            ci_type:     'server',
            name,
            properties:  {
              architecture:    node.status?.nodeInfo?.architecture,
              os_image:        node.status?.nodeInfo?.osImage,
              kernel_version:  node.status?.nodeInfo?.kernelVersion,
              kubelet_version: node.status?.nodeInfo?.kubeletVersion,
              status:          ready ? 'active' : 'degraded',
              provider_id:     node.spec?.providerID,
            },
            tags:          labelsToTags(node.metadata?.labels),
            relationships: [],
          }
        }
      } catch (err) {
        logger.warn({ err }, '[k8s] Node scan error')
      }
    }

    // ── Resolve namespaces ────────────────────────────────────────────────
    let nsNames: string[] = namespaces
    if (!nsNames.length) {
      try {
        const nsList = await coreApi.listNamespace()
        nsNames = nsList.items.map((n: { metadata?: { name?: string | null } }) => n.metadata?.name ?? '').filter(Boolean)
      } catch (err) {
        logger.warn({ err }, '[k8s] Namespace list error')
        nsNames = ['default']
      }
    }

    for (const ns of nsNames) {
      // ── Deployments ─────────────────────────────────────────────────
      if (types.has('deployment')) {
        try {
          const depList = await appsApi.listNamespacedDeployment({ namespace: ns })
          for (const dep of depList.items) {
            const name = dep.metadata?.name
            if (!name) continue

            yield {
              external_id: `deployment::${ns}::${name}`,
              source:      'kubernetes',
              ci_type:     'application',
              name:        `${ns}/${name}`,
              properties:  {
                namespace:          ns,
                replicas:           dep.spec?.replicas,
                ready_replicas:     dep.status?.readyReplicas,
                available_replicas: dep.status?.availableReplicas,
                strategy:           dep.spec?.strategy?.type,
                image:              dep.spec?.template.spec?.containers?.[0]?.image,
              },
              tags:          labelsToTags(dep.metadata?.labels),
              relationships: [],
            }
          }
        } catch (err) {
          logger.debug({ err, ns }, '[k8s] Deployment scan error')
        }
      }

      // ── StatefulSets ─────────────────────────────────────────────────
      if (types.has('statefulset')) {
        try {
          const ssList = await appsApi.listNamespacedStatefulSet({ namespace: ns })
          for (const ss of ssList.items) {
            const name = ss.metadata?.name
            if (!name) continue

            const pvcNames = (ss.spec?.volumeClaimTemplates ?? [])
              .map((t: { metadata?: { name?: string | null } }) => t.metadata?.name ?? '')
              .filter(Boolean)
              .join(', ')

            yield {
              external_id: `statefulset::${ns}::${name}`,
              source:      'kubernetes',
              ci_type:     'application',
              name:        `${ns}/${name}`,
              properties:  {
                namespace:              ns,
                replicas:               ss.spec?.replicas,
                ready_replicas:         ss.status?.readyReplicas,
                image:                  ss.spec?.template.spec?.containers?.[0]?.image,
                service_name:           ss.spec?.serviceName,
                volume_claim_templates: pvcNames || undefined,
              },
              tags:          labelsToTags(ss.metadata?.labels),
              relationships: [],
            }
          }
        } catch (err) {
          logger.debug({ err, ns }, '[k8s] StatefulSet scan error')
        }
      }

      // ── Services ─────────────────────────────────────────────────────
      if (types.has('service')) {
        try {
          const svcList    = await coreApi.listNamespacedService({ namespace: ns })
          const depList    = types.has('deployment') ? await appsApi.listNamespacedDeployment({ namespace: ns }) : { items: [] }
          const ssList     = types.has('statefulset') ? await appsApi.listNamespacedStatefulSet({ namespace: ns }) : { items: [] }

          for (const svc of svcList.items) {
            const name    = svc.metadata?.name
            const svcType = svc.spec?.type
            if (!name) continue

            const svcSelector = svc.spec?.selector as Record<string, string> | undefined

            // Compute relations toward matching workloads
            const relationships: DiscoveredRelation[] = []
            if (svcSelector && Object.keys(svcSelector).length) {
              for (const dep of depList.items) {
                const matchLabels = dep.spec?.selector?.matchLabels as Record<string, string> | undefined
                if (dep.metadata?.name && selectorsMatch(matchLabels, svcSelector)) {
                  relationships.push({
                    target_external_id: `deployment::${ns}::${dep.metadata.name}`,
                    relation_type:      'DEPENDS_ON',
                    direction:          'outgoing',
                  })
                }
              }
              for (const ss of ssList.items) {
                const matchLabels = ss.spec?.selector?.matchLabels as Record<string, string> | undefined
                if (ss.metadata?.name && selectorsMatch(matchLabels, svcSelector)) {
                  relationships.push({
                    target_external_id: `statefulset::${ns}::${ss.metadata.name}`,
                    relation_type:      'DEPENDS_ON',
                    direction:          'outgoing',
                  })
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
              external_id: `service::${ns}::${name}`,
              source:      'kubernetes',
              ci_type:     'load_balancer',
              name:        `${ns}/${name}`,
              properties:  {
                namespace:   ns,
                cluster_ip:  svc.spec?.clusterIP,
                external_ip: externalIp || undefined,
                ports:       ports || undefined,
                type:        svcType,
              },
              tags:          labelsToTags(svc.metadata?.labels),
              relationships,
            }
          }
        } catch (err) {
          logger.debug({ err, ns }, '[k8s] Service scan error')
        }
      }

      // ── Ingress ──────────────────────────────────────────────────────
      if (types.has('ingress')) {
        try {
          const ingList = await networkApi.listNamespacedIngress({ namespace: ns })
          for (const ing of ingList.items) {
            const name = ing.metadata?.name
            if (!name) continue

            const hosts = (ing.spec?.rules ?? [])
              .map((r: { host?: string | null }) => r.host ?? '')
              .filter(Boolean)
              .join(', ')

            const relationships: DiscoveredRelation[] = []
            for (const rule of ing.spec?.rules ?? []) {
              for (const path of (rule as { http?: { paths?: { backend?: { service?: { name?: string } } }[] } }).http?.paths ?? []) {
                const svcName = path.backend?.service?.name
                if (svcName) {
                  relationships.push({
                    target_external_id: `service::${ns}::${svcName}`,
                    relation_type:      'DEPENDS_ON',
                    direction:          'outgoing',
                  })
                }
              }
            }

            const ingressClass = ing.metadata?.annotations?.['kubernetes.io/ingress.class']
              ?? (ing.spec as { ingressClassName?: string } | undefined)?.ingressClassName

            yield {
              external_id: `ingress::${ns}::${name}`,
              source:      'kubernetes',
              ci_type:     'load_balancer',
              name:        `${ns}/${name}`,
              properties:  {
                namespace:     ns,
                hosts:         hosts || undefined,
                tls:           Boolean((ing.spec as { tls?: unknown[] } | undefined)?.tls?.length),
                ingress_class: ingressClass,
              },
              tags:          labelsToTags(ing.metadata?.labels),
              relationships,
            }
          }
        } catch (err) {
          logger.debug({ err, ns }, '[k8s] Ingress scan error')
        }
      }
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg = config.config as K8sConfig
      const k8s = await import('@kubernetes/client-node')
      const { CoreV1Api } = k8s
      const kc      = makeKubeConfig(creds, cfg)
      const coreApi = kc.makeApiClient(CoreV1Api)
      const nsList  = await coreApi.listNamespace()
      return { ok: true, message: `Connected — ${nsList.items.length} namespaces found` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Kubernetes connection failed: ${msg}` }
    }
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
      {
        name:          'resource_types',
        label:         'Resource Types',
        type:          'text',
        required:      false,
        default_value: ALL_RESOURCE_TYPES.join(', '),
        help_text:     'Comma-separated: node, deployment, statefulset, service, ingress (leave empty for all)',
      },
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
