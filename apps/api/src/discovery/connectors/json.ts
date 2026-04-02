import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI, SyncSourceConfig } from '@opengraphity/discovery'

// ── JSON Connector ────────────────────────────────────────────────────────────
// User pastes a JSON array directly in the json_content config field.
// Each element must have: external_id (or id), name.
// Optional per element: ci_type, tags, relationships.

type JsonConfig = {
  json_content?: string
}

const VALID_RELATION_TYPES = new Set([
  'DEPENDS_ON', 'HOSTED_ON', 'USES_CERTIFICATE', 'INSTALLED_ON', 'MEMBER_OF',
] as const)

function parseItems(raw: unknown): DiscoveredCI[] {
  if (!Array.isArray(raw)) throw new Error('JSON source must be an array of CI objects')

  return raw
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null,
    )
    .flatMap((item): DiscoveredCI[] => {
      const externalId = (item['external_id'] ?? item['id']) as string | undefined
      const name       = item['name'] as string | undefined
      if (!externalId || !name) return []

      const properties: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item)) {
        if (['external_id', 'id', 'name', 'ci_type', 'relationships', 'tags'].includes(k)) continue
        properties[k] = v
      }

      const rawRels = item['relationships']
      const relationships: DiscoveredCI['relationships'] = Array.isArray(rawRels)
        ? rawRels.flatMap((r: unknown) => {
            if (typeof r !== 'object' || r === null) return []
            const rel = r as Record<string, unknown>
            const rt  = String(rel['relation_type'] ?? 'DEPENDS_ON')
            if (!VALID_RELATION_TYPES.has(rt as never)) return []
            const relType = rt as 'DEPENDS_ON' | 'HOSTED_ON' | 'USES_CERTIFICATE' | 'INSTALLED_ON' | 'MEMBER_OF'
            const dir     = rel['direction'] === 'incoming' ? 'incoming' : 'outgoing'
            const targetId = String(rel['target_external_id'] ?? rel['target_id'] ?? '')
            if (!targetId) return []
            return [{
              target_external_id: targetId,
              relation_type:      relType,
              direction:          dir as 'outgoing' | 'incoming',
              properties:         typeof rel['properties'] === 'object' && !Array.isArray(rel['properties'])
                ? rel['properties'] as Record<string, unknown>
                : undefined,
            }]
          })
        : []

      const tags = typeof item['tags'] === 'object' && !Array.isArray(item['tags']) && item['tags'] !== null
        ? item['tags'] as Record<string, string>
        : {}

      return [{
        external_id:   externalId,
        source:        'json',
        ci_type:       String(item['ci_type'] ?? 'server'),
        name,
        properties,
        tags,
        relationships,
      }]
    })
}

export const jsonConnector: Connector = {
  type:             'json',
  displayName:      'JSON Import',
  supportedCITypes: ['server', 'application', 'database', 'database_instance', 'certificate', 'network', 'storage', 'container', 'load_balancer'],

  async *scan(config: SyncSourceConfig, _creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg     = (config.config ?? {}) as JsonConfig
    const content = cfg.json_content?.trim()
    if (!content) throw new Error('JSON connector: json_content is required')

    const raw = JSON.parse(content) as unknown
    for (const ci of parseItems(raw)) {
      yield ci
    }
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const cfg     = (config.config ?? {}) as JsonConfig
    const content = cfg.json_content?.trim()
    if (!content) return { ok: false, message: 'JSON content is required' }

    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      return { ok: false, message: 'Invalid JSON — parse error' }
    }
    if (!Array.isArray(raw)) return { ok: false, message: 'JSON must be an array of objects' }
    return { ok: true, message: `JSON source configured — ${raw.length} item(s) found` }
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return []
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'json_content',
        label:     'JSON Content',
        type:      'textarea',
        required:  true,
        help_text: 'Paste a JSON array of CI objects. Each must have external_id and name. Optional: ci_type, tags, relationships.',
      },
    ]
  },
}
