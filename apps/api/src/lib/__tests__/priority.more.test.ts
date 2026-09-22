/**
 * invertPriority when the customer's matrix has gone STALE (review of the
 * eight waves, C-N-6).
 *
 * A matrix keeps its cell keys until someone recompiles it. When a dictionary
 * value is renamed, a cell can still say `old_impact|high → critical`: creating
 * an incident from the severity alone then produced a ticket with an impact the
 * dictionary no longer has — a defect that surfaced much later as "an incident
 * missing from the impact filters". The contract pinned here: such a cell is a
 * ValidationError naming the cell and the stale value, never a ticket saved
 * with it.
 *
 * `domainMatrix.js` is replaced so the test can hand over a matrix whose keys
 * do not match the vocabulary — exactly the drift the real loader cannot
 * prevent, since keys are customer data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ValidationError } from '../errors.js'

const DICTIONARY: Record<string, string[]> = {
  impact: ['low', 'medium', 'high'],
  urgency: ['low', 'medium', 'high'],
  priority: ['low', 'medium', 'high', 'critical'],
}

let entries: Record<string, string> = {}
let isDefault = false
let rejectWith: unknown = null

vi.mock('../domainMatrix.js', () => ({
  matrixKey: (...parts: string[]) => parts.join('|'),
  loadDomainMatrix: vi.fn(async () => ({ kind: 'priority', entries, isDefault, updatedAt: null })),
  assertDomainValue: vi.fn(async (_tenant: string, domain: string, value: unknown) => {
    if (DICTIONARY[domain]!.includes(String(value))) return String(value)
    // `rejectWith` lets a test throw a non-Error, as a misbehaving layer might.
    if (rejectWith !== null) throw rejectWith
    throw new ValidationError(`${domain}: "${String(value)}" is not in the dictionary of this tenant`)
  }),
}))
vi.mock('../domainValue.js', () => ({ resolveDomainValue: vi.fn() }))

const { invertPriority, resolveNewTicketPriority } = await import('../priority.js')

async function caught(p: Promise<unknown>): Promise<ValidationError> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ValidationError)
  return err as ValidationError
}

beforeEach(() => {
  entries = {}
  isDefault = false
  rejectWith = null
})

describe('invertPriority — a matrix cell whose key is no longer in the dictionary', () => {
  it('a stale IMPACT in the chosen cell is refused, naming the cell and the value', async () => {
    entries = { 'critico|high': 'critical', 'low|low': 'low' }
    const err = await caught(invertPriority('tenant-a', 'critical'))
    expect(err.message).toContain('cell "critico|high"')
    expect(err.message).toContain('the impact "critico" is not (any more) in the dictionary')
    // The underlying reason travels along, so the admin sees both halves.
    expect(err.message).toContain('impact: "critico" is not in the dictionary of this tenant')
    // The UI translates by key: the stale-impact key, with the cell as a parameter.
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.priority.cellImpactStale', params: { cell: 'critico|high', value: 'critico' } })
  })

  it('a stale URGENCY in the chosen cell is refused the same way', async () => {
    entries = { 'high|subito': 'critical' }
    const err = await caught(invertPriority('tenant-a', 'critical'))
    expect(err.message).toContain('cell "high|subito"')
    expect(err.message).toContain('the urgency "subito" is not (any more) in the dictionary')
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.priority.cellUrgencyStale', params: { cell: 'high|subito', value: 'subito' } })
  })

  it('also when the lower layer throws something that is not an Error', async () => {
    entries = { 'high|subito': 'critical' }
    rejectWith = 'vocabulary unavailable'
    const err = await caught(invertPriority('tenant-a', 'critical'))
    expect(err.message).toContain('vocabulary unavailable')
    expect(err.extensions['i18n']).toMatchObject({ params: { reason: 'vocabulary unavailable' } })
  })

  it('the stale cell stops ticket creation from the severity alone: no ticket with a ghost impact', async () => {
    entries = { 'critico|high': 'critical' }
    await expect(resolveNewTicketPriority('tenant-a', { severity: 'critical' }))
      .rejects.toThrow(/cell "critico\|high"/)
  })

  it('a valid cell is still inverted normally (the guard does not refuse good data)', async () => {
    entries = { 'high|medium': 'high', 'medium|high': 'high' }
    expect(await invertPriority('tenant-a', 'high')).toEqual({ impact: 'high', urgency: 'medium' })
  })

  it('a priority no cell produces says whether the matrix is still the factory one', async () => {
    entries = { 'low|low': 'low' }
    isDefault = true
    const factory = await caught(invertPriority('tenant-a', 'critical'))
    expect(factory.message).toContain('currently the factory one')
    expect(factory.extensions['i18n']).toMatchObject({ key: 'errors.priority.noCombinationFactory' })
    isDefault = false
    const custom = await caught(invertPriority('tenant-a', 'critical'))
    expect(custom.message).not.toContain('factory')
    expect(custom.extensions['i18n']).toMatchObject({ key: 'errors.priority.noCombination', params: { priority: 'critical' } })
  })
})
