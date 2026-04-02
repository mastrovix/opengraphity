import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── Kubernetes Connector ──────────────────────────────────────────────────────
// Discovers Pods, Deployments, Services, and Nodes.
// Credentials: kubeconfig (YAML/JSON as string) or bearer_token + server_url.
// Config: namespaces (comma-separated, optional — empty = all).

type K8sConfig = {
  namespaces?: string
  server_url?: string
}

function splitParam(s?: string): string[] {
  if (!s) return []
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

export const kubernetesConnector: Connector = {
  type:             'kubernetes',
  displayName:      'Kubernetes',
  supportedCITypes: ['container', 'server', 'application'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg        = config.config as K8sConfig
    const namespaces = splitParam(cfg.namespaces)

    const { KubeConfig, CoreV1Api, AppsV1Api } = await import('@kubernetes/client-node')

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

    const coreApi  = kc.makeApiClient(CoreV1Api)
    const appsApi  = kc.makeApiClient(AppsV1Api)

    // ── Nodes ────────────────────────────────────────────────────────────
    try {
      const nodeList = await coreApi.listNode()
      for (const node of nodeList.items) {
        const name = node.metadata?.name
        if (!name) continue

        const labels: Record<string, string> = {}
        for (const [k, v] of Object.entries(node.metadata?.labels ?? {})) {
          if (v != null) labels[k] = v
        }

        const conditions = node.status?.conditions ?? []
        const ready      = conditions.some((c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True')

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
          tags:          labels,
          relationships: [],
        }
      }
    } catch (err) {
      logger.warn({ err }, '[k8s] Node scan error')
    }

    // ── Namespaces to scan ────────────────────────────────────────────────
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
      // ── Deployments ──────────────────────────────────────────────────
      try {
        const depList = await appsApi.listNamespacedDeployment({ namespace: ns })
        for (const dep of depList.items) {
          const name = dep.metadata?.name
          if (!name) continue

          const labels: Record<string, string> = {}
          for (const [k, v] of Object.entries(dep.metadata?.labels ?? {})) {
            if (v != null) labels[k] = v
          }

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
            },
            tags:          labels,
            relationships: [],
          }
        }
      } catch (err) {
        logger.debug({ err, ns }, '[k8s] Deployment scan error')
      }

      // ── Pods ─────────────────────────────────────────────────────────
      try {
        const podList = await coreApi.listNamespacedPod({ namespace: ns })
        for (const pod of podList.items) {
          const name = pod.metadata?.name
          if (!name) continue

          const labels: Record<string, string> = {}
          for (const [k, v] of Object.entries(pod.metadata?.labels ?? {})) {
            if (v != null) labels[k] = v
          }

          const containers = pod.spec?.containers ?? []

          yield {
            external_id: `pod::${ns}::${name}`,
            source:      'kubernetes',
            ci_type:     'container',
            name:        `${ns}/${name}`,
            properties:  {
              namespace:      ns,
              phase:          pod.status?.phase,
              node_name:      pod.spec?.nodeName,
              pod_ip:         pod.status?.podIP,
              container_count: containers.length,
              image:          containers[0]?.image,
              restart_count:  pod.status?.containerStatuses?.[0]?.restartCount,
            },
            tags:          labels,
            relationships: [],
          }
        }
      } catch (err) {
        logger.debug({ err, ns }, '[k8s] Pod scan error')
      }
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg = config.config as K8sConfig
      const { KubeConfig, CoreV1Api } = await import('@kubernetes/client-node')

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
        return { ok: false, message: 'kubeconfig or (bearer_token + server_url) is required' }
      }

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
        name:      'namespaces',
        label:     'Namespaces',
        type:      'text',
        required:  false,
        help_text: 'Comma-separated list of namespaces (empty = all)',
      },
    ]
  },
}
