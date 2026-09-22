/**
 * writeTicketField — how an automation (trigger, Business Rule, `update_field`
 * step action) writes ONE field of a ticket.
 *
 * Why it matters: before the AU-3/C-4 fixes a rule could write any property,
 * so `deleted = true` was a mass soft-delete and `resolved_at = …` made an open
 * ticket look closed. These tests pin that the write is tenant-scoped, that
 * non-priority fields pass the same metamodel validation as the workflow step
 * action, that priority fields go through the matrix, and that a ticket that
 * does not exist (or vanished mid-write) is reported instead of silently
 * "succeeding".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../domainMatrix.js', () => import('./domainMatrixFake.js'))
vi.mock('@opengraphity/neo4j', () => ({ runQueryOne: vi.fn(), getSession: vi.fn() }))
// The metamodel read is stubbed; the validation of field and value is the real one.
vi.mock('../stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stepFieldWrites.js')>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['category', { name: 'category', fieldType: 'enum', enumValues: ['network', 'hardware'], enumTypeName: 'category' }],
  ])),
}))

const { runQueryOne } = await import('@opengraphity/neo4j')
const { stepFieldMetas } = await import('../stepFieldWrites.js')
const { writeTicketField, PRIORITY_FIELDS } = await import('../ticketFieldWrite.js')

const session = {} as never

beforeEach(() => { vi.mocked(runQueryOne).mockReset() })

describe('writeTicketField', () => {
  it('rejects an entity type automations cannot write', async () => {
    await expect(writeTicketField(session, 't1', 'ci', 'x', 'name', 'v')).rejects.toThrow(/has no writable fields/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('a ticket of another tenant (or missing) is NotFound, nothing is written', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    await expect(writeTicketField(session, 't1', 'incident', 'inc-1', 'category', 'network')).rejects.toThrow(/Incident.*inc-1|inc-1/)
    const [, q, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(q).toContain('MATCH (e:Incident {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'inc-1', tenantId: 't1' })
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('a metamodel field is validated against its dictionary and written with updated_at', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ props: { id: 'inc-1', category: 'hardware' } })
      .mockResolvedValueOnce({ props: { id: 'inc-1', category: 'network' } })
    const out = await writeTicketField(session, 't1', 'incident', 'inc-1', 'category', ' network ')
    expect(out).toEqual({ before: { id: 'inc-1', category: 'hardware' }, after: { id: 'inc-1', category: 'network' } })
    expect(stepFieldMetas).toHaveBeenCalledWith(session, 't1', 'incident')
    const [, q, params] = vi.mocked(runQueryOne).mock.calls[1]!
    expect(q).toContain('MATCH (e:Incident {id: $id, tenant_id: $tenantId})')
    expect(q).toContain('SET e += $props, e.updated_at = $now')
    expect(params).toMatchObject({ id: 'inc-1', tenantId: 't1', props: { category: 'network' } })
  })

  it('a value outside the dictionary is rejected before writing', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'inc-1' } })
    await expect(writeTicketField(session, 't1', 'incident', 'inc-1', 'category', 'software')).rejects.toThrow(/not a value of the field "category"/)
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('a reserved property cannot be written by a rule (no mass soft-delete)', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'inc-1' } })
    await expect(writeTicketField(session, 't1', 'incident', 'inc-1', 'deleted', true)).rejects.toThrow(/set_field deleted/)
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('a field that is not in the metamodel is rejected', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'pb-1' } })
    await expect(writeTicketField(session, 't1', 'problem', 'pb-1', 'colour', 'red')).rejects.toThrow(/not a field of problem in the metamodel/)
  })

  it('priority on an incident goes through the matrix and lands in severity', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ props: { id: 'inc-1', impact: 'low', urgency: 'low' } })
      .mockResolvedValueOnce({ props: { id: 'inc-1', severity: 'critical' } })
    await writeTicketField(session, 't1', 'incident', 'inc-1', 'priority', 'critical')
    expect(vi.mocked(runQueryOne).mock.calls[1]![2]).toMatchObject({ props: { severity: 'critical', impact: 'high', urgency: 'high' } })
    expect(stepFieldMetas).not.toHaveBeenCalled()
  })

  it('priority on a change is refused: it is derived from type and risk', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'chg-1' } })
    await expect(writeTicketField(session, 't1', 'change', 'chg-1', 'urgency', 'high')).rejects.toThrow(/type and risk/)
  })

  it('a service request only has priority: impact is not one of its fields', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'sr-1' } })
    await expect(writeTicketField(session, 't1', 'service_request', 'sr-1', 'impact', 'high')).rejects.toThrow(/service request has no "impact"/)
  })

  it('a ticket deleted between read and write is NotFound, not a silent success', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ props: { id: 'pb-1', impact: 'low', urgency: 'low' } })
      .mockResolvedValueOnce(null)
    await expect(writeTicketField(session, 't1', 'problem', 'pb-1', 'impact', 'high')).rejects.toThrow(/pb-1/)
    expect(vi.mocked(runQueryOne).mock.calls[1]![1]).toContain('MATCH (e:Problem')
  })

  it('PRIORITY_FIELDS lists exactly the matrix-governed fields', () => {
    expect([...PRIORITY_FIELDS].sort()).toEqual(['impact', 'priority', 'severity', 'urgency'])
  })
})
