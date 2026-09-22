/**
 * Pre-approved change types — the parts the main suite does not reach.
 *
 * Whether a change skips its approval chain is decided by this list, so the
 * reads and writes must hit the RIGHT tenant node, a write on a missing tenant
 * must fail loudly (not report a list that was never stored), and the choice
 * offered to the admin must be the tenant's own `change_type` vocabulary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Call { q: string; p: Record<string, unknown> }
const calls: Call[] = []
let readRecords: unknown[] = []
let writeRecords: unknown[] = []
const rec = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })
const tx = (records: () => unknown[]) => ({
  run: vi.fn(async (q: string, p: Record<string, unknown>) => { calls.push({ q, p }); return { records: records() } }),
})
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: (fn: (t: unknown) => unknown) => fn(tx(() => readRecords)),
    executeWrite: (fn: (t: unknown) => unknown) => fn(tx(() => writeRecords)),
    close,
  }),
}))
const domainVocabulary = vi.fn()
vi.mock('../domainMatrix.js', () => ({
  assertDomainValue: vi.fn(async (_t: string, _v: string, value: string) => value),
  domainVocabulary: (...a: unknown[]) => domainVocabulary(...a),
}))

const {
  preApprovedChangeTypes, setPreApprovedChangeTypes, changeTypeVocabulary, invalidatePreApprovedChangeTypes,
} = await import('../changePolicy.js')

beforeEach(() => {
  calls.length = 0
  close.mockClear()
  invalidatePreApprovedChangeTypes()
})

describe('reads and writes are scoped to the tenant node', () => {
  it('the read targets the tenant by id and closes its session', async () => {
    readRecords = [rec({ types: ['routine'] })]
    expect(await preApprovedChangeTypes('acme')).toEqual(['routine'])
    expect(calls[0]!.q).toContain('MATCH (t:Tenant {id: $tenantId})')
    expect(calls[0]!.p).toEqual({ tenantId: 'acme' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('invalidating one tenant leaves the others cached', async () => {
    readRecords = [rec({ types: ['routine'] })]
    await preApprovedChangeTypes('acme')
    await preApprovedChangeTypes('globex')
    invalidatePreApprovedChangeTypes('acme')
    await preApprovedChangeTypes('acme')
    await preApprovedChangeTypes('globex')
    expect(calls.map((c) => c.p['tenantId'])).toEqual(['acme', 'globex', 'acme'])
  })

  it('the write stores a copy of the list on the tenant with a timestamp', async () => {
    writeRecords = [rec({ types: ['standard'] })]
    const types = ['standard']
    expect(await setPreApprovedChangeTypes('acme', types)).toEqual(['standard'])
    const w = calls[0]!
    expect(w.q).toContain('SET t.pre_approved_change_types = $types')
    expect(w.p['tenantId']).toBe('acme')
    expect(w.p['types']).toEqual(['standard'])
    expect(w.p['types']).not.toBe(types)
    expect(typeof w.p['now']).toBe('string')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a write on a missing tenant is an error, not a silently empty success', async () => {
    writeRecords = []
    await expect(setPreApprovedChangeTypes('ghost', ['standard'])).rejects.toThrow(/Tenant ghost/)
    // The session is released even on failure.
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('changeTypeVocabulary', () => {
  it('offers the tenant\'s own change_type vocabulary', async () => {
    domainVocabulary.mockResolvedValue(['standard', 'normal', 'routine'])
    expect(await changeTypeVocabulary('acme')).toEqual(['standard', 'normal', 'routine'])
    expect(domainVocabulary).toHaveBeenCalledWith('acme', 'change_type')
  })
})
