// ── Discovered entities ───────────────────────────────────────────────────────

export interface DiscoveredRelation {
  target_external_id: string
  relation_type: 'DEPENDS_ON' | 'HOSTED_ON' | 'USES_CERTIFICATE' | 'INSTALLED_ON' | 'MEMBER_OF'
  direction: 'outgoing' | 'incoming'
  properties?: Record<string, unknown>
}

export interface DiscoveredCI {
  external_id:    string
  source:         string
  ci_type:        string
  name:           string
  properties:     Record<string, unknown>
  tags:           Record<string, string>
  relationships:  DiscoveredRelation[]
  raw_data?:      Record<string, unknown>
}

// ── Mapping rules ─────────────────────────────────────────────────────────────

export interface MappingRule {
  source_field: string
  target_field: string
  transform?:   'lowercase' | 'uppercase' | 'trim' | 'none'
}

// ── Sync source configuration ─────────────────────────────────────────────────

export interface SyncSourceConfig {
  id:                    string
  tenant_id:             string
  name:                  string
  connector_type:        string
  encrypted_credentials: string
  config:                Record<string, unknown>
  mapping_rules:         MappingRule[]
  schedule_cron:         string | null
  enabled:               boolean
  last_sync_at:          string | null
  last_sync_status:      'completed' | 'failed' | null
  last_sync_duration_ms: number | null
  created_at:            string
  updated_at:            string
}

// ── Sync result ───────────────────────────────────────────────────────────────

export interface SyncRunResult {
  source_id:        string
  tenant_id:        string
  sync_type:        'full' | 'incremental'
  status:           'running' | 'completed' | 'failed'
  ci_created:       number
  ci_updated:       number
  ci_unchanged:     number
  ci_stale:         number
  ci_conflicts:     number
  relations_created: number
  relations_removed: number
  duration_ms:      number
  error_message?:   string
  started_at:       string
  completed_at?:    string
}

// ── Conflict data ─────────────────────────────────────────────────────────────

export interface SyncConflictData {
  discovered_ci:    DiscoveredCI
  existing_ci_id:   string
  match_reason:     'same_ip' | 'same_name' | 'same_hostname' | 'same_fqdn' | 'same_external_id'
  resolution?:      'merged' | 'distinct' | 'linked'
}

// ── CI discovery metadata ─────────────────────────────────────────────────────

export interface CIDiscoveryMetadata {
  discovery_external_id:  string
  discovery_source:       string
  discovery_source_id:    string
  discovery_status:       'discovered' | 'active' | 'stale' | 'decommissioned' | 'manual'
  discovery_last_seen:    string
  discovery_stale_since?: string
  discovery_locked_fields: string[]
  discovered_at:          string
}
