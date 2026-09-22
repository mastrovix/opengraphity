/**
 * CONFIGURATION ASSIST — the database side of "fill the missing value labels".
 *
 * The pure rules (what is missing, what is kept, how labels merge) are pinned in
 * configurationAssist.test.ts. This file pins what the ACTION does against the
 * stored dictionary, because that is where a person's work can be lost:
 * - it re-reads the dictionary at execution time, inside the caller's tenant,
 *   and only fills the holes it finds NOW (a label typed by hand since the
 *   proposal was born survives);
 * - an unreadable value_labels document is never overwritten: it fails loudly;
 * - "nothing left to fill" is a normal outcome with no undo button, not an error;
 * - undo writes back exactly the previous JSON, `null` included;
 * - the session is closed on every path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ run, close })),
}))

const { riempiEtichette, ripristinaEtichette } = await import('../configurationAssistActions.js')

const rec = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] })
const stored = (values: string[] | null, raw: unknown) => ({ records: [rec({ values, raw })] })

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO ERROR' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  run.mockResolvedValue({ records: [] })
})

describe('riempiEtichette — filling the holes', () => {
  it('rejects a proposal that does not name a dictionary, without opening a session', async () => {
    expect(await code(() => riempiEtichette('t1', { labels: { a: { en: 'A' } } }))).toBe('BAD_USER_INPUT')
    expect(run).not.toHaveBeenCalled()
  })

  it('a dictionary that is gone (or in another tenant) is NOT_FOUND', async () => {
    expect(await code(() => riempiEtichette('t1', { vocabulary: 'severity', labels: {} }))).toBe('NOT_FOUND')
    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('EnumTypeDefinition {tenant_id: $tenantId, name: $vocabulary}')
    expect(params).toEqual({ tenantId: 't1', vocabulary: 'severity' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('an unreadable value_labels document is not overwritten: it fails and writes nothing', async () => {
    run.mockResolvedValueOnce(stored(['a'], '{not json'))
    expect(await code(() => riempiEtichette('t1', { vocabulary: 'v', labels: { a: { en: 'A' } } }))).toBe('BAD_USER_INPUT')
    expect(run).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('when a person filled the holes in the meantime, nothing is written and there is nothing to undo', async () => {
    run.mockResolvedValueOnce(stored(['a'], JSON.stringify({ a: { en: 'Mine', it: 'Mio' } })))
    const out = await riempiEtichette('t1', { vocabulary: 'v', labels: { a: { en: 'Model' } } })
    expect(out).toEqual({ details: { vocabulary: 'v', written: 0, discarded: ['a: nothing missing'] }, undoState: null })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a dictionary with no values and no labels param is simply a no-op', async () => {
    run.mockResolvedValueOnce(stored(null, null))
    const out = await riempiEtichette('t1', { vocabulary: 'v' })
    expect(out.undoState).toBeNull()
    expect(out.details['written']).toBe(0)
  })

  it('fills only the missing languages, keeps the human ones, and records the previous JSON for undo', async () => {
    const before = JSON.stringify({ a: { it: 'Alfa a mano' } })
    run.mockResolvedValueOnce(stored(['a', 'b'], before)).mockResolvedValueOnce({ records: [] })
    const out = await riempiEtichette('t1', {
      vocabulary: 'v',
      labels: { a: { it: 'Alfa modello', en: 'Alpha' }, b: { en: '  Beta\n value ' } },
    })
    expect(out.details).toEqual({
      vocabulary: 'v', written: 2, values: ['a', 'b'], discarded: ['a/it: already written'],
    })
    expect(out.undoState).toEqual({ vocabulary: 'v', precedente: before })

    const [cypher, params] = run.mock.calls[1] as [string, Record<string, unknown>]
    expect(cypher).toContain('SET e.value_labels = $labels')
    expect(params['tenantId']).toBe('t1')
    // The hand-written Italian label is still there, untouched.
    expect(JSON.parse(String(params['labels']))).toEqual({
      a: { it: 'Alfa a mano', en: 'Alpha' },
      b: { en: 'Beta value' },
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('when there were no labels at all, undo remembers null (the most common state)', async () => {
    run.mockResolvedValueOnce(stored(['a'], null)).mockResolvedValueOnce({ records: [] })
    const out = await riempiEtichette('t1', { vocabulary: 'v', labels: { a: { en: 'A' } } })
    expect(out.undoState).toEqual({ vocabulary: 'v', precedente: null })
  })

  it('closes the session even when the write fails', async () => {
    run.mockResolvedValueOnce(stored(['a'], null)).mockRejectedValueOnce(new Error('neo4j down'))
    await expect(riempiEtichette('t1', { vocabulary: 'v', labels: { a: { en: 'A' } } })).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('ripristinaEtichette — undo', () => {
  it('writes back exactly the previous JSON, in the caller tenant', async () => {
    await ripristinaEtichette('t1', { vocabulary: 'v', precedente: '{"a":{"it":"A"}}' })
    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('SET e.value_labels = $precedente')
    expect(params).toMatchObject({ tenantId: 't1', vocabulary: 'v', precedente: '{"a":{"it":"A"}}' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a previous state that was not a string goes back to null, not to a stringified object', async () => {
    await ripristinaEtichette('t1', { vocabulary: 'v', precedente: { a: 1 } })
    expect((run.mock.calls[0]?.[1] as Record<string, unknown>)['precedente']).toBeNull()
  })

  it('an undo state without a dictionary does nothing', async () => {
    await ripristinaEtichette('t1', {})
    expect(run).not.toHaveBeenCalled()
  })

  it('closes the session when the write fails', async () => {
    run.mockRejectedValueOnce(new Error('boom'))
    await expect(ripristinaEtichette('t1', { vocabulary: 'v', precedente: null })).rejects.toThrow('boom')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
