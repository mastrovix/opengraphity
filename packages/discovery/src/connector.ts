import type { DiscoveredCI, SyncSourceConfig } from './types.js'

// ── Field definitions for dynamic UI form generation ─────────────────────────

export interface CredentialFieldDefinition {
  name:         string
  label:        string
  type:         'text' | 'password' | 'textarea'
  required:     boolean
  placeholder?: string
  help_text?:   string
}

export interface ConfigFieldDefinition {
  name:          string
  label:         string
  type:          'text' | 'select' | 'multiselect' | 'boolean'
  required:      boolean
  options?:      { value: string; label: string }[]
  default_value?: unknown
  help_text?:    string
}

// ── Connector interface ───────────────────────────────────────────────────────

export interface Connector {
  readonly type:              string
  readonly displayName:       string
  readonly supportedCITypes:  string[]

  scan(
    config:                SyncSourceConfig,
    decryptedCredentials:  Record<string, string>,
  ): AsyncIterable<DiscoveredCI>

  testConnection(
    config:                SyncSourceConfig,
    decryptedCredentials:  Record<string, string>,
  ): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }>

  getRequiredCredentialFields(): CredentialFieldDefinition[]
  getConfigFields():             ConfigFieldDefinition[]
}
