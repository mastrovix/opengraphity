import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { Connector, CredentialFieldDefinition, ConfigFieldDefinition, DiscoveredCI } from '@opengraphity/discovery'
import type { SyncSourceConfig } from '@opengraphity/discovery'

// ── CSV Connector ─────────────────────────────────────────────────────────────
// Supports a local file path or an inline CSV payload (for testing/import).
// The CSV must have a header row. Required columns: external_id, name.
// Optional: ci_type, any additional columns become properties.

async function* parseCsvStream(
  readable: NodeJS.ReadableStream,
  source:   SyncSourceConfig,
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

    const externalId = row['external_id'] ?? row['id']
    const name       = row['name']
    if (!externalId || !name) continue

    const properties: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === 'external_id' || k === 'id' || k === 'name' || k === 'ci_type') continue
      if (v !== '') properties[k] = v
    }

    yield {
      external_id: externalId,
      source:      'csv',
      ci_type:     row['ci_type'] ?? 'server',
      name,
      properties,
      tags:        {},
      relationships: [],
    }
  }
}

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current   = ''
  let inQuotes  = false

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
    const cfg      = config.config as { file_path?: string; csv_content?: string }
    const filePath = cfg.file_path
    const content  = cfg.csv_content

    if (content) {
      yield* parseCsvStream(Readable.from([content]), config)
    } else if (filePath) {
      yield* parseCsvStream(createReadStream(filePath, 'utf-8'), config)
    } else {
      throw new Error('CSV connector: either file_path or csv_content is required')
    }
  },

  async testConnection(config: SyncSourceConfig, _creds: Record<string, string>) {
    const cfg = config.config as { file_path?: string; csv_content?: string }
    if (!cfg.file_path && !cfg.csv_content) {
      return { ok: false, message: 'No file_path or csv_content configured' }
    }
    return { ok: true, message: 'CSV source configured successfully' }
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
        help_text: 'Absolute path to the CSV file on the server',
      },
      {
        name:      'csv_content',
        label:     'CSV Content',
        type:      'text' as 'text',
        required:  false,
        help_text: 'Paste CSV content directly (for one-off imports)',
      },
    ]
  },
}
