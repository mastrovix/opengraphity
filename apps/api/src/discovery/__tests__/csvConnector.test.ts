import { describe, it, expect } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'
import { csvConnector, splitCsvLine } from '../connectors/csv.js'
import { FIELD_NAME_RE } from '../../lib/cypherIdentifiers.js'

function sourceWith(csv_content: string | undefined): SyncSourceConfig {
  return {
    id: 'src-csv', tenant_id: 't1', name: 'csv', connector_type: 'csv',
    encrypted_credentials: '', config: csv_content === undefined ? {} : { csv_content },
    mapping_rules: [], schedule_cron: null, enabled: true,
    last_sync_at: null, last_sync_status: null, last_sync_duration_ms: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('csvConnector.scan', () => {
  it('parses rows, normalizes headers to snake_case and skips empty cells', async () => {
    const csv = [
      'name,ci_type,IP Address,Cost Center,ownerTeam',
      'web-01,server,10.0.0.1,CC-9,',
      '',
      '"db,01",database_instance,,CC-1,DBA',
      'lb-01,,,,',
    ].join('\r\n')
    const cis = await collect(csvConnector.scan(sourceWith(csv), {}))

    expect(cis).toHaveLength(3)
    expect(cis[0]).toEqual({
      external_id: 'web-01', source: 'csv', ci_type: 'server', name: 'web-01',
      properties: { ip_address: '10.0.0.1', cost_center: 'CC-9' }, tags: {}, relationships: [],
    })
    expect(cis[1]).toMatchObject({ external_id: 'db,01', name: 'db,01', ci_type: 'database_instance', properties: { cost_center: 'CC-1', owner_team: 'DBA' } })
    expect(cis[2]).toMatchObject({ name: 'lb-01', ci_type: 'server', properties: {} })
    for (const ci of cis) for (const k of Object.keys(ci.properties)) expect(k).toMatch(FIELD_NAME_RE)
  })

  it('fails loudly when csv_content is missing', async () => {
    await expect(collect(csvConnector.scan(sourceWith(undefined), {}))).rejects.toThrow('[csv] config failed: csv_content is required')
  })

  it('requires a name column (after normalization: "Name" works)', async () => {
    await expect(collect(csvConnector.scan(sourceWith('id,type\n1,x'), {}))).rejects.toThrow(/header row must include a "name" column/)
    const cis = await collect(csvConnector.scan(sourceWith('Name,Type\nsrv,server'), {}))
    expect(cis[0]).toMatchObject({ name: 'srv', properties: { type: 'server' } })
  })

  it('rejects a row without name', async () => {
    await expect(collect(csvConnector.scan(sourceWith('name,x\n,1'), {}))).rejects.toThrow(/row 1: missing required "name" value/)
  })

  it('rejects colliding or duplicate headers', async () => {
    await expect(collect(csvConnector.scan(sourceWith('name,Cost Center,costCenter\na,b,c'), {})))
      .rejects.toThrow(/\[csv\] header row: le chiavi "Cost Center" e "costCenter" collidono su "cost_center"/)
    await expect(collect(csvConnector.scan(sourceWith('name,x,x\na,b,c'), {})))
      .rejects.toThrow(/duplicate header column "x"/)
    await expect(collect(csvConnector.scan(sourceWith('name,,x\na,b,c'), {})))
      .rejects.toThrow(/header column 2 is empty/)
  })

  it('rejects rows with more cells than headers (misaligned data)', async () => {
    await expect(collect(csvConnector.scan(sourceWith('name,x\na,b,c'), {}))).rejects.toThrow(/row 1: 3 columns but header has 2/)
  })
})

describe('splitCsvLine', () => {
  it('handles quotes, escaped quotes and embedded commas', () => {
    expect(splitCsvLine('a,"b,c","d""e",')).toEqual(['a', 'b,c', 'd"e', ''])
  })
  it('fails on an unterminated quote', () => {
    expect(() => splitCsvLine('a,"b')).toThrow(/unterminated quoted field/)
  })
})

describe('csvConnector.testConnection', () => {
  it('reports missing content without throwing', async () => {
    await expect(csvConnector.testConnection(sourceWith(undefined), {})).resolves.toEqual({ ok: false, message: 'CSV content is required' })
  })
  it('counts data rows', async () => {
    await expect(csvConnector.testConnection(sourceWith('name\na\nb\n\n'), {})).resolves.toEqual({ ok: true, message: 'CSV source configured — 2 data row(s) detected' })
  })
})

describe('csvConnector metadata', () => {
  it('needs no credentials and one textarea config field', () => {
    expect(csvConnector.getRequiredCredentialFields()).toEqual([])
    expect(csvConnector.getConfigFields()).toMatchObject([{ name: 'csv_content', type: 'textarea', required: true }])
  })
})
