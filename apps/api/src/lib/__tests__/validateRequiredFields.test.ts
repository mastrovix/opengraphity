/**
 * lib/validateRequiredFields.ts — the tenant's "this field is required" rules.
 *
 * These rules are what stops a ticket from moving forward (or being saved)
 * with an empty mandatory field. If a step-specific rule leaked into other
 * steps, users would be blocked on transitions that do not need the field; if
 * hidden fields were enforced, users would be blocked by a field they cannot
 * even see; if blank strings passed, the rule would be decorative.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a) }))

const { validateRequiredFields, propsToFieldValues } = await import('../validateRequiredFields.js')

const session = {} as Session
const rule = (field_name: string, workflow_step?: string | null) =>
  ({ r: { properties: { field_name, required: true, ...(workflow_step === undefined ? {} : { workflow_step }) } } })

async function failure(p: Promise<unknown>): Promise<GraphQLError | null> {
  return p.then(() => null, (e: GraphQLError) => e)
}

beforeEach(() => { runQuery.mockReset() })

describe('validateRequiredFields', () => {
  it('loads the rules of this tenant and entity type only', async () => {
    runQuery.mockResolvedValue([])
    await validateRequiredFields(session, { entityType: 'incident', fieldValues: {}, tenantId: 't1' })
    const [, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType}')
    expect(params).toEqual({ tenantId: 't1', entityType: 'incident' })
  })

  it('passes when every required field has a value (0 and false are values)', async () => {
    runQuery.mockResolvedValue([rule('title'), rule('count'), rule('flag')])
    await expect(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: { title: 'x', count: 0, flag: false },
    })).resolves.toBeUndefined()
  })

  it('treats null, undefined and blank strings as missing, and lists every missing field', async () => {
    runQuery.mockResolvedValue([rule('a'), rule('b'), rule('c'), rule('d')])
    const err = await failure(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: { a: null, c: '   ', d: 'ok' },
    }))
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err!.message).toBe('Field "a" is required; Field "b" is required; Field "c" is required')
    expect(err!.extensions).toMatchObject({
      code: 'VALIDATION_ERROR', fields: ['a', 'b', 'c'],
      i18n: { key: 'errors.fields.required', params: { fields: 'a, b, c' } },
    })
  })

  it('applies a step rule only on its own step, and names the step in the error', async () => {
    runQuery.mockResolvedValue([rule('rootCause', 'resolved')])
    // Other step: the rule does not apply.
    await expect(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: {}, toStep: 'in_progress',
    })).resolves.toBeUndefined()
    // No step at all (a plain save): the step rule does not apply either.
    await expect(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: {},
    })).resolves.toBeUndefined()

    const err = await failure(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: {}, toStep: 'resolved',
    }))
    expect(err!.message).toBe('Field "rootCause" is required for step "resolved"')
    expect(err!.extensions['i18n']).toEqual({ key: 'errors.fields.requiredForStep', params: { fields: 'rootCause', step: 'resolved' } })
  })

  it('a global rule (no step) applies on every transition', async () => {
    runQuery.mockResolvedValue([rule('title', null)])
    const err = await failure(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: {}, toStep: 'any_step',
    }))
    expect(err!.extensions['fields']).toEqual(['title'])
  })

  it('skips hidden fields: a field the user cannot see cannot be required', async () => {
    runQuery.mockResolvedValue([rule('secret'), rule('title')])
    await expect(validateRequiredFields(session, {
      entityType: 'incident', tenantId: 't1', fieldValues: { title: 't' }, visibilityExclusions: ['secret'],
    })).resolves.toBeUndefined()
  })
})

describe('propsToFieldValues', () => {
  it('exposes each property in both snake_case and camelCase, keeping the value', () => {
    // Rules may name a field either way; both must find the persisted value.
    expect(propsToFieldValues({ root_cause_text: 'x', title: 't', n: 0 })).toEqual({
      root_cause_text: 'x', rootCauseText: 'x', title: 't', n: 0,
    })
  })
})
