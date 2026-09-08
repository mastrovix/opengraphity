import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI, SyncSourceConfig } from '@opengraphity/discovery'
import { ConnectorError } from './base.js'
import { normalizeKeys } from './normalize.js'

// ── CSV Connector ─────────────────────────────────────────────────────────────
// User pastes CSV content directly in the csv_content config field.
// The CSV must have a header row. Required column: name.
// Optional column: ci_type. All other columns become CI properties; header
// names are normalized to snake_case ("Cost Center" → cost_center) because the
// reconciliation engine rejects any other property key. Two headers that
// collapse onto the same name are an error. external_id is derived from name.

const TYPE = 'csv'

type CsvConfig = {
  csv_content?: string
}

function fail(message: string): never {
  throw new ConnectorError(TYPE, 'parse', new Error(message))
}

/** Exported for tests. */
export async function* parseCsvStream(readable: NodeJS.ReadableStream): AsyncIterable<DiscoveredCI> {
  const rl = createInterface({ input: readable, crlfDelay: Infinity })
  let headers: string[] | null = null
  let rowNum = 0

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const cols = splitCsvLine(trimmed)

    if (!headers) {
      const rawHeaders: Record<string, number> = {}
      cols.forEach((h, i) => {
        const key = h.trim()
        if (key === '') fail(`header column ${i + 1} is empty`)
        if (key in rawHeaders) fail(`duplicate header column "${key}"`)
        rawHeaders[key] = i
      })
      const normalized = normalizeKeys(rawHeaders, `[${TYPE}] header row`)
      headers = new Array<string>(cols.length)
      for (const [key, i] of Object.entries(normalized)) headers[i] = key
      if (!headers.includes('name')) fail('header row must include a "name" column')
      continue
    }

    rowNum++
    if (cols.length > headers.length) fail(`row ${rowNum}: ${cols.length} columns but header has ${headers.length}`)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = (cols[i] ?? '').trim() })

    const name = row['name']
    if (!name) fail(`row ${rowNum}: missing required "name" value`)

    const properties: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === 'name' || k === 'ci_type') continue
      if (v !== '') properties[k] = v
    }

    yield {
      external_id:   name,
      source:        TYPE,
      ci_type:       row['ci_type'] || 'server',
      name,
      properties,
      tags:          {},
      relationships: [],
    }
  }
}

export function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current  = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (inQuotes) fail(`unterminated quoted field in line: ${line.slice(0, 60)}`)
  result.push(current)
  return result
}

function contentOf(config: SyncSourceConfig): string | undefined {
  const cfg = (config.config ?? {}) as CsvConfig
  return cfg.csv_content?.trim() || undefined
}

export const csvConnector: Connector = {
  type:             TYPE,
  displayName:      'CSV Import',
  supportedCITypes: ['server', 'application', 'database', 'database_instance', 'certificate', 'network', 'storage'],

  async *scan(config: SyncSourceConfig, _creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const content = contentOf(config)
    if (!content) throw new ConnectorError(TYPE, 'config', new Error('csv_content is required'))

    yield* parseCsvStream(Readable.from([content]))
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const content = contentOf(config)
    if (!content) return { ok: false, message: 'CSV content is required' }

    // Count non-empty, non-header lines
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    const rows  = Math.max(0, lines.length - 1)
    return { ok: true, message: `CSV source configured — ${rows} data row(s) detected` }
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return []
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:      'csv_content',
        label:     'CSV Content',
        type:      'textarea',
        required:  true,
        help_text: 'Paste the CSV content here. Required column: name. Optional: ci_type. All other columns become properties (headers normalized to snake_case).',
      },
    ]
  },
}
