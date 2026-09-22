/**
 * Field visibility and requirement rules: the resolvers behind the "Field
 * rules" panel of the metamodel designer.
 *
 * Why these behaviours matter:
 *  - every read and write is scoped by `tenant_id`: a rule id guessed from
 *    another tenant must not be readable, editable or deletable;
 *  - every mutation demands `config.metamodel`: a rule that hides a field or
 *    makes it mandatory changes what every operator can submit, so an operator
 *    without that permission must be refused before anything is written;
 *  - a visibility rule whose trigger IS its target, or whose action is neither
 *    show nor hide, would make the form flicker or silently do nothing;
 *  - `setFieldRequirement` is an upsert: clicking the checkbox twice must flip
 *    the same rule, not pile up duplicates that disagree with each other.
 * (The "workflow step must exist" contract lives in fieldRequirementSteps.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

interface Call { cypher: string; params: Record<string, unknown> }
const writes: Call[] = []

const mockSession = {
  executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { writes.push({ cypher, params }); return { records: [] } },
  })),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', () => ({
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async () => [{ name: 'resolved' }]),
}))

const { fieldRulesResolvers } = await import('../fieldRules.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { ForbiddenError, NotFoundError, ValidationError } = await import('../../../lib/errors.js')

const { Query, Mutation } = fieldRulesResolvers
const admin: GraphQLContext = { tenantId: 'tenant-a', userId: 'user-1', userEmail: 'a@test.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, role: 'operator', permissions: perms('operator') }

const lastParams = (mock: unknown): Record<string, unknown> => {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls
  return calls[calls.length - 1]![2] as Record<string, unknown>
}

beforeEach(() => {
  writes.length = 0
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([])
  vi.mocked(runQueryOne).mockResolvedValue(null)
})

describe('queries', () => {
  it('fieldVisibilityRules reads only the caller tenant and maps snake_case to the GraphQL shape', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ p: {
      id: 'r1', entity_type: 'incident', trigger_field: 'category', trigger_value: 'network', target_field: 'vlan', action: 'show',
    } }])
    const rows = await Query.fieldVisibilityRules(null, { entityType: 'incident' }, admin)
    expect(rows).toEqual([{ id: 'r1', entityType: 'incident', triggerField: 'category', triggerValue: 'network', targetField: 'vlan', action: 'show' }])
    expect(lastParams(runQuery)).toEqual({ tenantId: 'tenant-a', entityType: 'incident' })
  })

  it('fieldRequirementRules defaults required=false and workflowStep=null, and sends a null step when none is asked', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { p: { id: 'q1', entity_type: 'change', field_name: 'why' } },
      { p: { id: 'q2', entity_type: 'change', field_name: 'plan', required: true, workflow_step: 'resolved' } },
    ])
    const rows = await Query.fieldRequirementRules(null, { entityType: 'change' }, admin)
    // A rule stored without `required` must read as "not required", never undefined:
    // the form treats undefined as "unknown" and would block the submit.
    expect(rows).toEqual([
      { id: 'q1', entityType: 'change', fieldName: 'why', required: false, workflowStep: null },
      { id: 'q2', entityType: 'change', fieldName: 'plan', required: true, workflowStep: 'resolved' },
    ])
    expect(lastParams(runQuery)).toEqual({ tenantId: 'tenant-a', entityType: 'change', workflowStep: null })
  })

  it('fieldRequirementRules passes the requested step through', async () => {
    await Query.fieldRequirementRules(null, { entityType: 'change', workflowStep: 'resolved' }, admin)
    expect(lastParams(runQuery)).toMatchObject({ workflowStep: 'resolved' })
  })
})

describe('createFieldVisibilityRule', () => {
  const args = { entityType: 'incident', triggerField: 'category', triggerValue: 'network', targetField: 'vlan', action: 'show' }

  it('without config.metamodel → Forbidden, nothing written', async () => {
    await expect(Mutation.createFieldVisibilityRule(null, args, operator)).rejects.toBeInstanceOf(ForbiddenError)
    expect(writes).toHaveLength(0)
  })

  it('a field that triggers itself is refused', async () => {
    await expect(Mutation.createFieldVisibilityRule(null, { ...args, targetField: 'category' }, admin))
      .rejects.toMatchObject({ constructor: ValidationError, message: expect.stringContaining('cannot be the same field') })
    expect(writes).toHaveLength(0)
  })

  it('an action other than show/hide is refused', async () => {
    await expect(Mutation.createFieldVisibilityRule(null, { ...args, action: 'blink' }, admin))
      .rejects.toBeInstanceOf(ValidationError)
    expect(writes).toHaveLength(0)
  })

  it('creates the node in the caller tenant, audits it and returns the rule', async () => {
    const out = await Mutation.createFieldVisibilityRule(null, { ...args, action: 'hide' }, admin)
    expect(out).toMatchObject({ entityType: 'incident', triggerField: 'category', targetField: 'vlan', action: 'hide' })
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.cypher).toContain('CREATE (r:FieldVisibilityRule')
    expect(writes[0]!.params).toMatchObject({ id: out.id, tenantId: 'tenant-a', action: 'hide' })
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('fieldVisibilityRule.created')
  })
})

describe('updateFieldVisibilityRule', () => {
  it('without config.metamodel → Forbidden', async () => {
    await expect(Mutation.updateFieldVisibilityRule(null, { id: 'r1' }, operator)).rejects.toBeInstanceOf(ForbiddenError)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a rule of another tenant (no row matched) is NotFound, and nothing is audited', async () => {
    await expect(Mutation.updateFieldVisibilityRule(null, { id: 'foreign' }, admin)).rejects.toBeInstanceOf(NotFoundError)
    expect(lastParams(runQuery)).toMatchObject({ id: 'foreign', tenantId: 'tenant-a' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('omitted fields are sent as null so coalesce keeps the stored values', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ p: {
      id: 'r1', entity_type: 'incident', trigger_field: 'category', trigger_value: 'db', target_field: 'vlan', action: 'show',
    } }])
    const out = await Mutation.updateFieldVisibilityRule(null, { id: 'r1', triggerValue: 'db' }, admin)
    expect(lastParams(runQuery)).toMatchObject({ triggerField: null, triggerValue: 'db', targetField: null, action: null })
    expect(out.triggerValue).toBe('db')
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('fieldVisibilityRule.updated')
  })

  it('all fields given are passed through', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ p: { id: 'r1' } }])
    await Mutation.updateFieldVisibilityRule(null, { id: 'r1', triggerField: 'a', triggerValue: 'b', targetField: 'c', action: 'hide' }, admin)
    expect(lastParams(runQuery)).toMatchObject({ triggerField: 'a', triggerValue: 'b', targetField: 'c', action: 'hide' })
  })
})

describe('deleteFieldVisibilityRule / deleteFieldRequirement', () => {
  for (const [name, label] of [['deleteFieldVisibilityRule', 'FieldVisibilityRule'], ['deleteFieldRequirement', 'FieldRequirementRule']] as const) {
    it(`${name}: without config.metamodel → Forbidden`, async () => {
      await expect(Mutation[name](null, { id: 'r1' }, operator)).rejects.toBeInstanceOf(ForbiddenError)
      expect(writes).toHaveLength(0)
    })

    it(`${name}: a rule not found in this tenant is NotFound and nothing is deleted`, async () => {
      await expect(Mutation[name](null, { id: 'foreign' }, admin)).rejects.toBeInstanceOf(NotFoundError)
      expect(lastParams(runQueryOne)).toEqual({ id: 'foreign', tenantId: 'tenant-a' })
      expect(writes).toHaveLength(0)
    })

    it(`${name}: deletes by id AND tenant, and audits`, async () => {
      vi.mocked(runQueryOne).mockResolvedValueOnce({ p: { id: 'r1' } })
      await expect(Mutation[name](null, { id: 'r1' }, admin)).resolves.toBe(true)
      expect(writes).toHaveLength(1)
      expect(writes[0]!.cypher).toContain(`(r:${label} {id: $id, tenant_id: $tenantId}) DETACH DELETE r`)
      expect(writes[0]!.params).toEqual({ id: 'r1', tenantId: 'tenant-a' })
      expect(audit).toHaveBeenCalledTimes(1)
    })
  }
})

describe('setFieldRequirement — upsert', () => {
  it('without config.metamodel → Forbidden', async () => {
    await expect(Mutation.setFieldRequirement(null, { entityType: 'change', fieldName: 'why', required: true }, operator))
      .rejects.toBeInstanceOf(ForbiddenError)
  })

  it('an existing rule for the same (tenant, type, field, step) is updated, not duplicated', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: { id: 'existing' } })
    vi.mocked(runQuery).mockResolvedValueOnce([{ p: { id: 'existing', entity_type: 'change', field_name: 'why', required: false, workflow_step: 'resolved' } }])
    const out = await Mutation.setFieldRequirement(null, { entityType: 'change', fieldName: 'why', required: false, workflowStep: 'resolved' }, admin)
    expect(out).toEqual({ id: 'existing', entityType: 'change', fieldName: 'why', required: false, workflowStep: 'resolved' })
    expect(lastParams(runQueryOne)).toEqual({ tenantId: 'tenant-a', entityType: 'change', fieldName: 'why', workflowStep: 'resolved' })
    expect(lastParams(runQuery)).toMatchObject({ id: 'existing', tenantId: 'tenant-a', required: false })
    // No CREATE: that would leave two contradicting rules for one field.
    expect(writes).toHaveLength(0)
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('fieldRequirementRule.updated')
  })

  it('a new global rule is created with workflow_step null', async () => {
    const out = await Mutation.setFieldRequirement(null, { entityType: 'change', fieldName: 'why', required: true }, admin)
    expect(out).toMatchObject({ entityType: 'change', fieldName: 'why', required: true, workflowStep: null })
    expect(writes[0]!.params).toMatchObject({ tenantId: 'tenant-a', workflowStep: null, required: true })
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('fieldRequirementRule.created')
  })
})
