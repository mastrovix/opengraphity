/**
 * itilTypeResolvers.ts — the paths the base suite does not walk.
 *
 * - The type read maps its relations and system relations: the ITIL designer
 *   draws them, and a null from an OPTIONAL MATCH must not reach the UI.
 * - The per-type field list maps every field row (the designer's field grid).
 * - Step rules on a field (visible/editable only in some workflow steps) are
 *   validated against the steps of the tenant's ACTIVE workflows for that
 *   ticket type: a rule naming a step that does not exist would hide the field
 *   forever. "Always"/"where visible" is stored as null so a field without
 *   rules stays as it was, and an update that omits the rules keeps the saved
 *   ones.
 * - Deleting a field whose type is not visible to the tenant is NOT_FOUND, and
 *   a DELETE that matched nothing is NOT_FOUND too (never a silent success).
 * - When the number of values removed differs from the number counted just
 *   before, it is logged: the audit sample may then be incomplete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
const warn = vi.hoisted(() => vi.fn())

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// Review of 23 Sep 2026: the field's rules go in the same transaction (lib/__tests__/fieldRulesOfField.test.ts).
const deleteFieldRulesOf = vi.fn(async (..._a: unknown[]) => 2)
vi.mock('../../../lib/fieldRulesOfField.js', () => ({ deleteFieldRulesOf: (...a: unknown[]) => deleteFieldRulesOf(...a) }))
vi.mock('../../../lib/customFieldName.js', () => ({ assertCustomFieldName: vi.fn(async () => {}) }))
vi.mock('../../../lib/logger.js', () => {
  const l = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => l }
  return { logger: l }
})

const { buildITILMutations, buildITILFieldValueCountResolver, buildITILTypeFieldsResolver, fetchITILTypeById } = await import('../itilTypeResolvers.js')
const { invalidateSchema } = await import('../../../lib/schemaInvalidator.js')
const { audit } = await import('../../../lib/audit.js')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const mutations = buildITILMutations(() => {})

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })
const TYPE_NODE = { properties: { id: 'it-1', name: 'incident', label: 'Incident', tenant_id: 'tenant-1' } }
const typeRecord = (over: Record<string, unknown> = {}) => rec({ t: TYPE_NODE, fieldData: [], relations: [], systemRels: [], ...over })
const noOverrides = { records: [] }
const refetch = [noOverrides, { records: [typeRecord()] }]

const txRun = vi.fn()
const queue: Array<{ records: unknown[] }> = []
function reset(responses: Array<{ records: unknown[] }> = []) {
  vi.clearAllMocks()
  queue.splice(0, queue.length, ...responses)
  txRun.mockImplementation(async () => queue.shift() ?? { records: [] })
  const tx = { run: txRun }
  mockSession.executeRead.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
  mockSession.executeWrite.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
}
const callWith = (needle: string) => txRun.mock.calls.find((c) => String(c[0]).includes(needle)) as [string, Record<string, unknown>] | undefined

beforeEach(() => reset())

describe('fetchITILTypeById — relations', () => {
  it('maps relations and system relations with defaults, dropping the nulls of the OPTIONAL MATCH', async () => {
    reset([noOverrides, {
      records: [typeRecord({
        relations: [null, { properties: { id: 'r-1', name: 'caused_by', label: 'Caused by', relationship_type: 'CAUSED_BY', target_type: 'problem', cardinality: 'many', direction: 'out' } }],
        systemRels: [{ properties: { id: 's-1', name: 'assignee', label: 'Assignee', relationship_type: 'ASSIGNED_TO', target_entity: 'User', order: 2 } }, null],
      })],
    }])
    const t = await fetchITILTypeById('it-1', 'tenant-1')
    expect(t.relations).toEqual([{ id: 'r-1', name: 'caused_by', label: 'Caused by', relationshipType: 'CAUSED_BY', targetType: 'problem', cardinality: 'many', direction: 'out', order: 0 }])
    expect(t.systemRelations).toEqual([{ id: 's-1', name: 'assignee', label: 'Assignee', relationshipType: 'ASSIGNED_TO', targetEntity: 'User', required: false, order: 2 }])
    // Defaults for a type node that carries only the essentials.
    expect(t).toMatchObject({ icon: '', color: '', active: true, scope: 'itil', validationScript: null })
  })
})

describe('itilTypeFields', () => {
  it('maps every field row with its dictionary', async () => {
    const field = { properties: { id: 'f-1', name: 'origin', label: 'Origin', field_type: 'enum', tenant_id: 'tenant-1', order: 1 } }
    reset([noOverrides, { records: [rec({ f: field, enumTypeId: 'e-1', enumTypeName: 'origin', enumTypeValues: ['web', 'mail'] })] }])
    const out = await buildITILTypeFieldsResolver()(null, { typeId: 'it-1' }, admin)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'f-1', name: 'origin', enumTypeId: 'e-1', enumValues: ['web', 'mail'] })
  })
})

describe('updateITILType — icon and colour', () => {
  it('writes only the passed keys, mapped to their properties', async () => {
    reset([{ records: [rec({ name: 'incident', typeTenantId: 'tenant-1' })] }, { records: [] }, ...refetch])
    await mutations.updateITILType(null, { id: 'it-1', input: { icon: 'bolt', color: 'red' } }, admin)
    expect(callWith('SET t += $updates')![1]['updates']).toEqual({ icon: 'bolt', color: 'red' })
  })
})

describe('field step rules', () => {
  const typeNameRow = { records: [rec({ name: 'incident' })] }
  const steps = (names: string[]) => ({ records: [rec({ names })] })
  const fieldCreated = { records: [rec({ f: { properties: { id: 'f-new' } } })] }

  it('createITILField: rules naming existing steps are stored as JSON, checked against the tenant\'s workflow', async () => {
    reset([typeNameRow, steps(['new', 'in_progress']), fieldCreated, ...refetch])
    await mutations.createITILField(null, {
      typeId: 'it-1',
      input: { name: 'root_cause', label: 'Root cause', fieldType: 'string', stepVisibility: { mode: 'from', step: 'in_progress' }, stepEditability: { mode: 'steps', steps: ['in_progress'] } },
    }, admin)
    // Step names come from the tenant's active workflows of THIS ticket type.
    expect(callWith('WorkflowDefinition')![1]).toEqual({ tenantId: 'tenant-1', entityType: 'incident' })
    const [, params] = callWith('CREATE (f:CIFieldDefinition')!
    expect(JSON.parse(params['stepVisibility'] as string)).toEqual({ mode: 'from', step: 'in_progress' })
    expect(JSON.parse(params['stepEditability'] as string)).toEqual({ mode: 'steps', steps: ['in_progress'] })
  })

  it('createITILField: a rule naming a step the workflow does not have is refused before the CREATE', async () => {
    reset([typeNameRow, steps(['new', 'closed'])])
    await expect(mutations.createITILField(null, {
      typeId: 'it-1', input: { name: 'root_cause', label: 'Root cause', fieldType: 'string', stepVisibility: { mode: 'steps', steps: ['triage'] } },
    }, admin)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.customField.unknownSteps' } } })
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('createITILField: "always" + "where visible" are stored as null, without reading the workflow', async () => {
    reset([typeNameRow, fieldCreated, ...refetch])
    await mutations.createITILField(null, {
      typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'string', stepVisibility: { mode: 'always' }, stepEditability: null },
    }, admin)
    expect(callWith('WorkflowDefinition')).toBeUndefined()
    expect(callWith('CREATE (f:CIFieldDefinition')![1]).toMatchObject({ stepVisibility: null, stepEditability: null })
  })

  it('updateITILField: sending rules replaces the saved ones (keepStepRules false)', async () => {
    const fieldRow = { records: [rec({ name: 'origin', fieldTenantId: 'tenant-1', isSystem: false })] }
    const stored = { records: [rec({ name: 'origin', fieldType: 'string', typeName: 'incident' })] }
    reset([fieldRow, stored, steps(['new']), { records: [] }, ...refetch])
    await mutations.updateITILField(null, {
      typeId: 'it-1', fieldId: 'f-2', input: { label: 'Origin', stepVisibility: { mode: 'steps', steps: ['new'] } },
    }, admin)
    const [, params] = callWith('CASE WHEN $keepStepRules')!
    expect(params).toMatchObject({ keepStepRules: false, stepEditability: null })
    expect(JSON.parse(params['stepVisibility'] as string)).toEqual({ mode: 'steps', steps: ['new'] })
  })
})

describe('updateITILField — enum without a dictionary', () => {
  it('is refused with BAD_USER_INPUT before any session', async () => {
    const err = await mutations.updateITILField(null, { typeId: 'it-1', fieldId: 'f-1', input: { fieldType: 'enum' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err?.extensions['code']).toBe('BAD_USER_INPUT')
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })
})

describe('deleteITILField — edge cases', () => {
  const fieldRow = { records: [rec({ name: 'origin', fieldTenantId: 'tenant-1', isSystem: false })] }
  const typeNameRow = { records: [rec({ name: 'incident' })] }
  const values = (count: number) => ({ records: [rec({ count, sample: [] })] })

  it('a type the tenant cannot see is NOT_FOUND', async () => {
    reset([fieldRow, { records: [] }])
    await expect(buildITILFieldValueCountResolver()(null, { typeId: 'it-x', fieldId: 'f-2' }, admin))
      .rejects.toThrow('ITILType it-x not found')
  })

  it('a DELETE that matched nothing is NOT_FOUND: nothing is removed, audited or invalidated', async () => {
    reset([fieldRow, typeNameRow, values(0), { records: [rec({ deleted: 0 })] }])
    await expect(mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-2' }, admin)).rejects.toThrow('Field f-2 not found')
    expect(callWith('REMOVE e.')).toBeUndefined()
    expect(audit).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('values removed ≠ values counted is logged, and the audit records what was actually removed', async () => {
    reset([fieldRow, typeNameRow, values(3), { records: [rec({ deleted: 1 })] }, { records: [rec({ removed: 4 })] }, ...refetch])
    await mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-2' }, admin)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', field: 'origin', counted: 3, removed: 4 }), expect.any(String))
    expect(audit).toHaveBeenCalledWith(admin, 'itil_type.field_removed', 'CITypeDefinition', 'it-1', expect.objectContaining({ valuesRemoved: 4 }))
  })
})
