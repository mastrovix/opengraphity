/**
 * ticketCustomFields — reading the customer's field definitions and cleaning
 * up the values of a deleted field.
 *
 * - `customFieldDefs` is the single source every channel (pages, REST, portal)
 *   uses to know which custom fields a ticket type has: system fields must never
 *   leak in (they would become writable through the custom-field path), the order
 *   must be the designer's, and a broken step rule must fail loudly.
 * - `ticketFieldValues` / `removeTicketFieldValues` run when a field is deleted:
 *   the field name ends up in a REMOVE, so it must pass the name rule, and the
 *   queries must stay inside the tenant — otherwise deleting a field in one
 *   customer would wipe values in another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const h = vi.hoisted(() => ({ types: [] as unknown[], loadITILTypes: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../metamodelScript.js', () => ({ runValidationScript: vi.fn(async () => null) }))
vi.mock('../itilTypes.js', () => ({ loadITILTypes: h.loadITILTypes }))

const {
  customFieldDefs, customFieldValueMap, loadTicketProps, ticketFieldValues, removeTicketFieldValues,
  resolveCustomFieldWrites, FIELD_VALUE_SAMPLE,
} = await import('../ticketCustomFields.js')

type Row = Record<string, unknown>
function fakeSession(rows: Row[]) {
  const run = vi.fn(async (_q: string, _p: Record<string, unknown>) => ({ records: rows.map((r) => ({ get: (k: string) => r[k] })) }))
  return { session: { executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run })) } as never, run }
}

beforeEach(() => { h.loadITILTypes.mockReset(); h.loadITILTypes.mockImplementation(async () => h.types) })

describe('customFieldDefs', () => {
  it('returns only the customer\'s fields of that type, in designer order (name breaks ties)', async () => {
    h.types = [
      { name: 'problem', fields: [{ name: 'other_type_field', isSystem: false }] },
      { name: 'incident', fields: [
        { name: 'title', isSystem: true, order: 0 },
        { name: 'zeta', label: 'Zeta', fieldType: 'number', order: 2, required: true, visibleToEndUser: true },
        { name: 'alpha', order: 2, enumValues: ['a'], enumTypeName: 'site', validationScript: 'x',
          stepVisibilityRaw: '{"mode":"from","step":"review"}', stepEditabilityRaw: { mode: 'steps', steps: ['review'] } },
        { name: 'first', order: 1 },
      ] },
    ]
    const { session } = fakeSession([])
    const defs = await customFieldDefs(session, 't1', 'incident')

    expect(defs.map((d) => d.name)).toEqual(['first', 'alpha', 'zeta'])
    expect(h.loadITILTypes).toHaveBeenCalledWith(session, 't1')
    // Defaults: label = name, type = string, optional, not offered to end users, no rules.
    expect(defs[0]).toEqual({
      name: 'first', label: 'first', fieldType: 'string', required: false, enumValues: [], enumTypeName: null,
      validationScript: null, visibleToEndUser: false, order: 1,
      visibility: { mode: 'always' }, editability: { mode: 'visible' },
    })
    expect(defs[1]).toMatchObject({
      enumValues: ['a'], enumTypeName: 'site', validationScript: 'x',
      visibility: { mode: 'from', step: 'review' }, editability: { mode: 'steps', steps: ['review'] },
    })
    expect(defs[2]).toMatchObject({ label: 'Zeta', fieldType: 'number', required: true, visibleToEndUser: true })
  })

  it('a type the tenant does not have yields no fields (not an error)', async () => {
    h.types = [{ name: 'change' }]
    const { session } = fakeSession([])
    await expect(customFieldDefs(session, 't1', 'incident')).resolves.toEqual([])
    await expect(customFieldDefs(session, 't1', 'change')).resolves.toEqual([])
  })

  it('a missing order sorts as 0', async () => {
    h.types = [{ name: 'incident', fields: [{ name: 'later', order: 1 }, { name: 'unordered' }] }]
    const { session } = fakeSession([])
    expect((await customFieldDefs(session, 't1', 'incident')).map((d) => [d.name, d.order])).toEqual([['unordered', 0], ['later', 1]])
  })

  it('a broken step rule fails loudly, naming the field', async () => {
    h.types = [{ name: 'incident', fields: [{ name: 'bad', stepVisibilityRaw: { mode: 'sometimes' } }] }]
    const { session } = fakeSession([])
    await expect(customFieldDefs(session, 't1', 'incident')).rejects.toThrow(/field bad/)
  })
})

describe('customFieldValueMap', () => {
  it('no inputs is an empty map', () => {
    expect(customFieldValueMap(null)).toEqual({})
    expect(customFieldValueMap(undefined)).toEqual({})
    expect(customFieldValueMap([{ name: 'a', value: '1' }])).toEqual({ a: '1' })
  })
})

describe('resolveCustomFieldWrites without inputs', () => {
  it('no inputs in an update writes nothing', async () => {
    await expect(resolveCustomFieldWrites('t1', 'incident', [], undefined, { current: {} })).resolves.toEqual({})
  })
})

describe('loadTicketProps', () => {
  it('reads the ticket by id inside the tenant, with the label of its type', async () => {
    const { session, run } = fakeSession([{ props: { id: 'sr-1', site: 'Milan' } }])
    await expect(loadTicketProps(session, 't1', 'service_request', 'sr-1')).resolves.toEqual({ id: 'sr-1', site: 'Milan' })
    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain('MATCH (e:ServiceRequest {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'sr-1', tenantId: 't1' })
  })

  it('a ticket not found (or of another tenant) is null', async () => {
    const { session } = fakeSession([])
    await expect(loadTicketProps(session, 't1', 'incident', 'nope')).resolves.toBeNull()
  })
})

describe('ticketFieldValues', () => {
  it('counts the values and keys the sample by ticket number', async () => {
    const { session, run } = fakeSession([{ count: 3, sample: [{ number: 'INC1', value: 'Milan' }, { number: 7, value: 'Rome' }] }])
    await expect(ticketFieldValues(session, 't1', 'incident', 'site')).resolves.toEqual({ count: 3, sample: { INC1: 'Milan', 7: 'Rome' } })
    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain('MATCH (e:Incident {tenant_id: $tenantId})')
    expect(params).toEqual({ tenantId: 't1', name: 'site', limit: FIELD_VALUE_SAMPLE })
  })

  it('no row means no values', async () => {
    const { session } = fakeSession([])
    await expect(ticketFieldValues(session, 't1', 'change', 'site')).resolves.toEqual({ count: 0, sample: {} })
  })

  it('refuses an entity type without custom fields', async () => {
    const { session, run } = fakeSession([])
    const err = await ticketFieldValues(session, 't1', 'ci', 'site').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as Error).message).toBe('"ci" is not a ticket type with custom fields')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('removeTicketFieldValues', () => {
  it('removes the property on the tenant\'s tickets and returns how many', async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 4 }] }))
    await expect(removeTicketFieldValues({ run }, 't1', 'problem', 'site')).resolves.toBe(4)
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (e:Problem {tenant_id: $tenantId})')
    expect(cypher).toContain('REMOVE e.`site`')
    expect(params).toEqual({ tenantId: 't1', name: 'site' })
  })

  it('no record means nothing removed', async () => {
    const run = vi.fn(async () => ({ records: [] }))
    await expect(removeTicketFieldValues({ run }, 't1', 'problem', 'site')).resolves.toBe(0)
  })

  it('a name outside the field-name rule never reaches the REMOVE (Cypher injection guard)', async () => {
    const run = vi.fn(async () => ({ records: [] }))
    await expect(removeTicketFieldValues({ run }, 't1', 'incident', 'x` DETACH DELETE e //'))
      .rejects.toThrow(/does not match the field name rule/)
    expect(run).not.toHaveBeenCalled()
  })
})
