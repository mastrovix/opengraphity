/**
 * Step deadlines on write — the parts the first suite leaves out.
 *
 * Why it matters: a deadline that sets fields on the ticket runs with nobody
 * behind it, so the fields and values it writes must be checked against the
 * tenant's metamodel when the workflow is saved, not discovered broken at
 * 3 a.m. when the deadline fires. And only a malformed deadline may be turned
 * into a friendly "shape" error: an unexpected failure must surface as itself,
 * or a real bug would be reported to the admin as their typo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { StepDeadline } from '@opengraphity/types'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

/** A raw deadline that makes the parser crash with a non-shape error (simulated internal bug). */
const CRASH = '{"__crash__":true}'
vi.mock('@opengraphity/types', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/types')>()
  return {
    ...orig,
    parseStepDeadline: (raw: unknown) => {
      if (raw === CRASH) throw new TypeError('internal parser bug')
      return orig.parseStepDeadline(raw)
    },
  }
})

const stepFieldMetas = vi.fn()
vi.mock('../stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stepFieldWrites.js')>()),
  stepFieldMetas: (...a: unknown[]) => stepFieldMetas(...a),
}))

const { assertDeadlineFields, assertDefinitionDeadlines, normalizeStepDeadlineInput } = await import('../stepDeadlineWrite.js')

const metas = new Map([
  ['outcome', { name: 'outcome', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: null }],
  ['notes',   { name: 'notes',   fieldType: 'text', enumValues: [], enumTypeName: null }],
])

const dl = (set_fields: StepDeadline['set_fields']): StepDeadline =>
  ({ after: 7, unit: 'days', calendar_id: null, to_step: 'closed', set_fields })

const i18nKey = (e: unknown) => ((e as GraphQLError).extensions['i18n'] as { key: string }).key

beforeEach(() => {
  stepFieldMetas.mockReset()
  stepFieldMetas.mockResolvedValue(metas)
})

describe('assertDeadlineFields', () => {
  it('a deadline that sets no field does not even read the metamodel', async () => {
    await expect(assertDeadlineFields({} as never, 't1', 'change', dl([]), 'where')).resolves.toBeUndefined()
    expect(stepFieldMetas).not.toHaveBeenCalled()
  })

  it('reads the metamodel of the caller tenant and entity type, and accepts valid values', async () => {
    await expect(assertDeadlineFields({} as never, 't1', 'change', dl([{ field: 'outcome', value: 'successful' }]), 'where'))
      .resolves.toBeUndefined()
    expect(stepFieldMetas).toHaveBeenCalledWith({}, 't1', 'change')
  })

  it('a field the metamodel does not have is rejected with the location of the deadline', async () => {
    const e = await assertDeadlineFields({} as never, 't1', 'change', dl([{ field: 'ghost', value: 'x' }]), 'deadline of step "review"')
      .then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(GraphQLError)
    expect((e as Error).message).toContain('deadline of step "review"')
    expect(i18nKey(e)).toBe('errors.stepField.notInMetamodel')
  })

  it('a {placeholder} is not resolved for a deadline: it is checked as the literal value it is', async () => {
    // nobody is there to resolve a template when the deadline fires, so it must not slip past the enum check
    const e = await assertDeadlineFields({} as never, 't1', 'change', dl([{ field: 'outcome', value: '{previous_outcome}' }]), 'w')
      .then(() => null, (err: unknown) => err)
    expect(i18nKey(e)).toBe('errors.stepField.valueNotInVocabulary')
  })
})

describe('unexpected parser failures are not disguised as shape errors', () => {
  it('normalizeStepDeadlineInput rethrows the original error', () => {
    expect(() => normalizeStepDeadlineInput(CRASH, 'w')).toThrow(TypeError)
  })

  it('assertDefinitionDeadlines rethrows the original error', async () => {
    const tx = {
      run: vi.fn(async () => ({
        records: [{ get: (k: string) => ({ entityType: 'incident', name: 'new', label: 'New', purpose: null, deadline: CRASH, targets: [] } as Record<string, unknown>)[k] }],
      })),
    }
    await expect(assertDefinitionDeadlines(tx as never, 't1', 'def-1')).rejects.toThrow(TypeError)
  })

  it('a stored deadline with a broken shape becomes a shape error naming the step', async () => {
    const tx = {
      run: vi.fn(async () => ({
        records: [{ get: (k: string) => ({ entityType: 'incident', name: 'new', label: 'New', purpose: null, deadline: '{not json', targets: [] } as Record<string, unknown>)[k] }],
      })),
    }
    const e = await assertDefinitionDeadlines(tx as never, 't1', 'def-1').then(() => null, (err: unknown) => err)
    expect((e as Error).message).toContain('deadline of step "New"')
    expect(i18nKey(e)).toBe('errors.stepDeadline.invalid_json')
  })
})

describe('assertDefinitionDeadlines — a definition with no steps', () => {
  it('has nothing to check and does not fail', async () => {
    const tx = { run: vi.fn(async () => ({ records: [] })) }
    await expect(assertDefinitionDeadlines(tx as never, 't1', 'def-empty')).resolves.toBeUndefined()
    // tenant-scoped read: the definition id alone must never be enough
    expect(tx.run).toHaveBeenCalledWith(expect.stringContaining('tenant_id: $tenantId'), { definitionId: 'def-empty', tenantId: 't1' })
  })
})
