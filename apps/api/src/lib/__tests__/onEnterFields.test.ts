/**
 * THE FIELDS A STEP WRITES WHEN ENTERED (wave 7 · B1). They lived in the
 * manual transition; the pipeline (services/ticketTransition.ts) applies them
 * on every path, and what they write is tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLError } from 'graphql'

type Call = { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }
const calls: Call[] = []
let row: Record<string, unknown> | null = null
const tx = (mode: 'read' | 'write') => ({
  run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    calls.push({ cypher, params, mode })
    return { records: mode === 'read' && row ? [{ get: (k: string) => (k in row! ? row![k] : null) }] : [] }
  }),
})
const session = {
  executeRead:  vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('read'))),
  executeWrite: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('write'))),
}
const writes = () => calls.filter((c) => c.mode === 'write')

vi.mock('@opengraphity/workflow', () => ({ ENTITY_LABELS: { incident: 'Incident', kb_article: 'KBArticle' } }))

const { applyOnEnterFields } = await import('../onEnterFields.js')
const apply = (notes?: string, tenantId?: string) => applyOnEnterFields(session as never, 'wi-1', 'resolved', 'u-1', notes, tenantId)
const fields = (f: string | null, entityType = 'incident') => { row = { fields: f, entityId: 'e-1', tenantId: 't-1', entityType } }
const caught = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p } catch (e) { return e as GraphQLError }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  row = null
})

describe('applyOnEnterFields', () => {
  it('resolves $now, $userId and $notes and writes on the tenant\'s entity; the read is scoped to the expected tenant', async () => {
    fields(JSON.stringify({ resolved_by: '$userId', resolved_on: '$now', resolution: '$notes', source: 'workflow' }))
    await apply('fixed it', 't-1')
    expect(calls[0]!.params).toEqual({ instanceId: 'wi-1', stepName: 'resolved', tenantId: 't-1' })
    const [w] = writes()
    expect(w!.cypher).toContain('MATCH (e:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(w!.params).toMatchObject({ entityId: 'e-1', tenantId: 't-1', __val_resolved_by: 'u-1', __val_resolution: 'fixed it', __val_source: 'workflow' })
    expect(w!.params['__val_resolved_on']).toBe(w!.params['now'])
  })

  it('without an expected tenant the read is not scoped (the pipeline always passes it)', async () => {
    fields(JSON.stringify({ source: 'workflow' }))
    await apply()
    expect(calls[0]!.params['tenantId']).toBeNull()
  })

  it('$notes without notes writes null, not the literal token', async () => {
    fields(JSON.stringify({ resolution: '$notes' }))
    await apply()
    expect(writes()[0]!.params['__val_resolution']).toBeNull()
  })

  it('no step found, no fields, or an empty object: nothing is written', async () => {
    await apply()
    fields(null)
    await apply()
    fields('{}')
    await apply()
    expect(writes()).toEqual([])
  })

  it('an entity type that cannot be written is a refusal, not a silent skip (B-28)', async () => {
    fields('{"a":"b"}', 'mystery')
    const e = await caught(apply())
    expect(e.message).toBe('Step "resolved" writes fields on enter, but entity type "mystery" is not writable')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.workflow.onEnterFieldsEntity', params: { step: 'resolved', entityType: 'mystery' } })
    expect(writes()).toEqual([])
  })

  it('corrupt JSON is a refusal naming the step', async () => {
    fields('{nope')
    await expect(apply()).rejects.toThrow(/^Corrupt on_enter_fields JSON on step "resolved"/)
  })

  it('a KB article is written on its own label', async () => {
    fields('{"reviewed_by":"$userId"}', 'kb_article')
    await apply()
    expect(writes()[0]!.cypher).toContain('MATCH (e:KBArticle')
    expect(writes()[0]!.params['__val_reviewed_by']).toBe('u-1')
  })
})
