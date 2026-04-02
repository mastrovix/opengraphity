import { readFile } from 'node:fs/promises'
import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI } from '@opengraphity/discovery'
import type { SyncSourceConfig } from '@opengraphity/discovery'

// ── JSON Connector ─────────────────────────────────────────────────────────────
// Accepts a local JSON file or an inline payload.
// The JSON must be an array of objects, each representing a CI.
// Required fields per object: external_id (or id), name.

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

      const VALID_RELATION_TYPES = new Set(['DEPENDS_ON', 'HOSTED_ON', 'USES_CERTIFICATE', 'INSTALLED_ON', 'MEMBER_OF'])
      const rawRels = item['relationships']
      const relationships: DiscoveredCI['relationships'] = Array.isArray(rawRels)
        ? rawRels.flatMap((r: unknown) => {
            const rel = r as Record<string, unknown>
            const rt = String(rel['relation_type'] ?? 'DEPENDS_ON')
            if (!VALID_RELATION_TYPES.has(rt)) return []
            const relType = rt as 'DEPENDS_ON' | 'HOSTED_ON' | 'USES_CERTIFICATE' | 'INSTALLED_ON' | 'MEMBER_OF'
            const dir = rel['direction'] === 'incoming' ? 'incoming' : 'outgoing'
            return [{
              target_external_id: String(rel['target_external_id'] ?? rel['target_id'] ?? ''),
              relation_type:      relType,
              direction:          dir as 'outgoing' | 'incoming',
              properties:         typeof rel['properties'] === 'object' ? rel['properties'] as Record<string, unknown> : undefined,
            }]
          })
        : []

      const tags = typeof item['tags'] === 'object' && !Array.isArray(item['tags'])
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
    const cfg      = config.config as { file_path?: string; json_content?: string }
    let raw: unknown

    if (cfg.json_content) {
      raw = JSON.parse(cfg.json_content)
    } else if (cfg.file_path) {
      const content = await readFile(cfg.file_path, 'utf-8')
      raw = JSON.parse(content)
    } else {
      throw new Error('JSON connector: either file_path or json_content is required')
    }

    for (const ci of parseItems(raw)) {
      yield ci
    }
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const cfg = config.config as { file_path?: string; json_content?: string }
    if (!cfg.file_path && !cfg.json_content) {
      return { ok: false, message: 'No file_path or json_content configured' }
    }
    return { ok: true, message: 'JSON source configured successfully' }
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return []
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'file_path',
        label:     'File Path',
        type:      'text',
        required:  false,
        help_text: 'Absolute path to a JSON file on the server',
      },
      {
        name:      'json_content',
        label:     'JSON Content',
        type:      'text' as 'text',
        required:  false,
        help_text: 'Paste JSON array directly (for one-off imports)',
      },
    ]
  },
}
