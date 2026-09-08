import { describe, it, expect } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'
import { jsonConnector, parseItems } from '../connectors/json.js'
import { FIELD_NAME_RE } from '../../lib/cypherIdentifiers.js'

function sourceWith(json_content: string | undefined): SyncSourceConfig {
  return {
    id: 'src-json', tenant_id: 't1', name: 'json', connector_type: 'json',
    encrypted_credentials: '', config: json_content === undefined ? {} : { json_content },
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

describe('jsonConnector.scan', () => {
  it('maps items, normalizes property keys and keeps tag keys raw', async () => {
    const content = JSON.stringify([
      {
        id: 'srv-1', name: 'web-01', ci_type: 'server',
        'IP Address': '10.0.0.1', costCenter: 'CC-9', cpuCores: 4,
        tags: { 'Cost Center': 'CC-9' },
        relationships: [{ target_id: 'db-1', relation_type: 'DEPENDS_ON' }],
      },
      { external_id: 'db-1', name: 'db-01' },
    ])
    const cis = await collect(jsonConnector.scan(sourceWith(content), {}))

    expect(cis).toHaveLength(2)
    expect(cis[0]).toMatchObject({
      external_id: 'srv-1', source: 'json', ci_type: 'server', name: 'web-01',
      properties: { ip_address: '10.0.0.1', cost_center: 'CC-9', cpu_cores: 4 },
      tags: { 'Cost Center': 'CC-9' },
      relationships: [{ target_external_id: 'db-1', relation_type: 'DEPENDS_ON', direction: 'outgoing' }],
    })
    for (const k of Object.keys(cis[0]!.properties)) expect(k).toMatch(FIELD_NAME_RE)
    expect(cis[1]).toMatchObject({ external_id: 'db-1', ci_type: 'server', properties: {}, tags: {}, relationships: [] })
  })

  it('fails loudly when json_content is missing or not JSON', async () => {
    await expect(collect(jsonConnector.scan(sourceWith(undefined), {}))).rejects.toThrow('[json] config failed: json_content is required')
    await expect(collect(jsonConnector.scan(sourceWith('   '), {}))).rejects.toThrow(/json_content is required/)
    await expect(collect(jsonConnector.scan(sourceWith('{not json'), {}))).rejects.toThrow(/^\[json\] parse failed: /)
  })

  it('rejects colliding property keys instead of overwriting', async () => {
    const content = JSON.stringify([{ id: 'x', name: 'x', 'Cost Center': 'A', cost_center: 'B' }])
    await expect(collect(jsonConnector.scan(sourceWith(content), {})))
      .rejects.toThrow(/\[json\] item 0 \(x\): le chiavi "Cost Center" e "cost_center" collidono/)
  })
})

describe('parseItems validation', () => {
  it('requires an array', () => {
    expect(() => parseItems({})).toThrow('[json] parse failed: JSON source must be an array of CI objects')
  })
  it('requires object items', () => {
    expect(() => parseItems(['x'])).toThrow(/item 0: must be an object/)
    expect(() => parseItems([[1]])).toThrow(/item 0: must be an object/)
  })
  it('requires external_id/id and name', () => {
    expect(() => parseItems([{ name: 'n' }])).toThrow(/item 0: missing required "external_id"/)
    expect(() => parseItems([{ id: '' , name: 'n' }])).toThrow(/missing required "external_id"/)
    expect(() => parseItems([{ id: 'a' }])).toThrow(/item 0 \(a\): missing required "name"/)
  })
  it('validates relationships', () => {
    expect(() => parseItems([{ id: 'a', name: 'a', relationships: 'nope' }])).toThrow(/"relationships" must be an array/)
    expect(() => parseItems([{ id: 'a', name: 'a', relationships: [1] }])).toThrow(/relationship 0 must be an object/)
    expect(() => parseItems([{ id: 'a', name: 'a', relationships: [{ target_id: 'b', relation_type: 'LIKES' }] }]))
      .toThrow(/invalid relation_type "LIKES"/)
    expect(() => parseItems([{ id: 'a', name: 'a', relationships: [{ relation_type: 'HOSTED_ON' }] }]))
      .toThrow(/missing "target_external_id"/)
  })
  it('defaults relation_type/direction and passes relation properties through', () => {
    const [ci] = parseItems([{ id: 'a', name: 'a', relationships: [
      { target_external_id: 'b', direction: 'incoming', properties: { port: 5432 } },
      { target_external_id: 'c', properties: [1] },
    ] }])
    expect(ci!.relationships).toEqual([
      { target_external_id: 'b', relation_type: 'DEPENDS_ON', direction: 'incoming', properties: { port: 5432 } },
      { target_external_id: 'c', relation_type: 'DEPENDS_ON', direction: 'outgoing', properties: undefined },
    ])
  })
  it('ignores non-object tags', () => {
    expect(parseItems([{ id: 'a', name: 'a', tags: ['x'] }])[0]!.tags).toEqual({})
  })
})

describe('jsonConnector.testConnection', () => {
  it('reports missing / invalid / non-array content without throwing', async () => {
    await expect(jsonConnector.testConnection(sourceWith(undefined), {})).resolves.toEqual({ ok: false, message: 'JSON content is required' })
    await expect(jsonConnector.testConnection(sourceWith('{'), {})).resolves.toEqual({ ok: false, message: 'Invalid JSON — parse error' })
    await expect(jsonConnector.testConnection(sourceWith('{}'), {})).resolves.toEqual({ ok: false, message: 'JSON must be an array of objects' })
  })
  it('counts items', async () => {
    await expect(jsonConnector.testConnection(sourceWith('[{},{}]'), {})).resolves.toEqual({ ok: true, message: 'JSON source configured — 2 item(s) found' })
  })
})

describe('jsonConnector metadata', () => {
  it('needs no credentials and one textarea config field', () => {
    expect(jsonConnector.getRequiredCredentialFields()).toEqual([])
    expect(jsonConnector.getConfigFields()).toMatchObject([{ name: 'json_content', type: 'textarea', required: true }])
  })
})
