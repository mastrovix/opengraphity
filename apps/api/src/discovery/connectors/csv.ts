import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI, SyncSourceConfig } from '@opengraphity/discovery'

// ── CSV Connector ─────────────────────────────────────────────────────────────
// User pastes CSV content directly in the csv_content config field.
// The CSV must have a header row. Required column: name.
// Optional column: ci_type. All other columns become CI properties.
// external_id is derived from the name column.

type CsvConfig = {
  csv_content?: string
}

async function* parseCsvStream(
  readable: NodeJS.ReadableStream,
): AsyncIterable<DiscoveredCI> {
  const rl = createInterface({ input: readable, crlfDelay: Infinity })
  let headers: string[] | null = null

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const cols = splitCsvLine(trimmed)

    if (!headers) {
      headers = cols.map(h => h.trim())
      continue
    }

    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = (cols[i] ?? '').trim() })

    const name = row['name']
    if (!name) continue

    const properties: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === 'name' || k === 'ci_type') continue
      if (v !== '') properties[k] = v
    }

    yield {
      external_id: name,
      source:      'csv',
      ci_type:     row['ci_type'] ?? 'server',
      name,
      properties,
      tags:          {},
      relationships: [],
    }
  }
}

function splitCsvLine(line: string): string[] {
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
  result.push(current)
  return result
}

export const csvConnector: Connector = {
  type:             'csv',
  displayName:      'CSV Import',
  supportedCITypes: ['server', 'application', 'database', 'database_instance', 'certificate', 'network', 'storage'],

  async *scan(config: SyncSourceConfig, _creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg     = (config.config ?? {}) as CsvConfig
    const content = cfg.csv_content?.trim()
    if (!content) throw new Error('CSV connector: csv_content is required')

    yield* parseCsvStream(Readable.from([content]))
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const cfg     = (config.config ?? {}) as CsvConfig
    const content = cfg.csv_content?.trim()
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
        help_text: 'Paste the CSV content here. Required column: name. Optional: ci_type. All other columns become properties.',
      },
    ]
  },
}
