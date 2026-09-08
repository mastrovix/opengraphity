import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI, DiscoveredRelation, SyncSourceConfig } from '@opengraphity/discovery'
import { ConnectorError } from './base.js'
import { normalizeKeys } from './normalize.js'

// ── JSON Connector ────────────────────────────────────────────────────────────
// User pastes a JSON array directly in the json_content config field.
// Each element must have: external_id (or id), name.
// Optional per element: ci_type, tags, relationships.
// Every other key becomes a CI property; keys are normalized to snake_case
// (the reconciliation engine rejects anything else) and two source keys that
// collapse onto the same property name are an error, not a silent overwrite.

const TYPE = 'json'

type JsonConfig = {
  json_content?: string
}

const VALID_RELATION_TYPES: ReadonlySet<DiscoveredRelation['relation_type']> = new Set([
  'DEPENDS_ON', 'HOSTED_ON', 'USES_CERTIFICATE', 'INSTALLED_ON', 'MEMBER_OF',
])

const RESERVED_ITEM_KEYS = new Set(['external_id', 'id', 'name', 'ci_type', 'relationships', 'tags'])

function fail(message: string): never {
  throw new ConnectorError(TYPE, 'parse', new Error(message))
}

function parseRelationships(raw: unknown, where: string): DiscoveredRelation[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(`${where}: "relationships" must be an array`)

  return raw.map((r: unknown, ri: number): DiscoveredRelation => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(`${where}: relationship ${ri} must be an object`)
    const rel = r as Record<string, unknown>

    const rt = String(rel['relation_type'] ?? 'DEPENDS_ON') as DiscoveredRelation['relation_type']
    if (!VALID_RELATION_TYPES.has(rt)) {
      fail(`${where}: relationship ${ri} has invalid relation_type "${rt}" (valid: ${[...VALID_RELATION_TYPES].join(', ')})`)
    }
    const targetId = String(rel['target_external_id'] ?? rel['target_id'] ?? '')
    if (!targetId) fail(`${where}: relationship ${ri} is missing "target_external_id" (or "target_id")`)

    const props = rel['properties']
    return {
      target_external_id: targetId,
      relation_type:      rt,
      direction:          rel['direction'] === 'incoming' ? 'incoming' : 'outgoing',
      properties:         typeof props === 'object' && props !== null && !Array.isArray(props)
        ? props as Record<string, unknown>
        : undefined,
    }
  })
}

/** Exported for tests. */
export function parseItems(raw: unknown): DiscoveredCI[] {
  if (!Array.isArray(raw)) fail('JSON source must be an array of CI objects')

  return raw.map((entry, idx): DiscoveredCI => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`item ${idx}: must be an object`)
    const item = entry as Record<string, unknown>

    const externalId = item['external_id'] ?? item['id']
    if (typeof externalId !== 'string' || externalId === '') fail(`item ${idx}: missing required "external_id" (or "id") field`)
    const where = `item ${idx} (${externalId})`

    const name = item['name']
    if (typeof name !== 'string' || name === '') fail(`${where}: missing required "name" field`)

    const rawProps: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item)) {
      if (!RESERVED_ITEM_KEYS.has(k)) rawProps[k] = v
    }

    const rawTags = item['tags']
    const tags = typeof rawTags === 'object' && rawTags !== null && !Array.isArray(rawTags)
      ? rawTags as Record<string, string>
      : {}

    return {
      external_id:   externalId,
      source:        TYPE,
      ci_type:       String(item['ci_type'] ?? 'server'),
      name,
      properties:    normalizeKeys(rawProps, `[${TYPE}] ${where}`),
      tags,
      relationships: parseRelationships(item['relationships'], where),
    }
  })
}

function contentOf(config: SyncSourceConfig): string | undefined {
  const cfg = (config.config ?? {}) as JsonConfig
  return cfg.json_content?.trim() || undefined
}

export const jsonConnector: Connector = {
  type:             TYPE,
  displayName:      'JSON Import',
  supportedCITypes: ['server', 'application', 'database', 'database_instance', 'certificate', 'network', 'storage', 'container', 'load_balancer'],

  async *scan(config: SyncSourceConfig, _creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const content = contentOf(config)
    if (!content) throw new ConnectorError(TYPE, 'config', new Error('json_content is required'))

    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch (err) {
      throw new ConnectorError(TYPE, 'parse', err)
    }
    yield* parseItems(raw)
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const content = contentOf(config)
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
        help_text: 'Paste a JSON array of CI objects. Each must have external_id and name. Optional: ci_type, tags, relationships. Other keys become properties (normalized to snake_case).',
      },
    ]
  },
}
