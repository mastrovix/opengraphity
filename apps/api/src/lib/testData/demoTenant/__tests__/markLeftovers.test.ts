/**
 * A RUN THAT STOPS LEAVES NOTHING THE CLEAN-UP CANNOT SEE (review of 23 Sep 2026).
 *
 * What must hold: every label is looked at, only the tenant's unmarked nodes
 * written since the run started get the run's mark, the run is recorded as
 * failed, and a failure of this marking is said without hiding the error
 * that stopped the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
let failOn: string | null = null
vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...await importOriginal<typeof import('@opengraphity/neo4j')>(),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    if (failOn && cypher.includes(failOn)) throw new Error('neo4j down')
    if (cypher.includes('db.labels()')) return [{ label: 'ServiceCatalogItem' }, { label: 'FormField' }, { label: 'bad label' }]
    if (cypher.includes('SET n.demo_run_id')) return [{ n: 3 }]
    return []
  }),
}))

const { markLeftovers } = await import('../generate.js')

beforeEach(() => { calls.length = 0; failOn = null })

describe('markLeftovers', () => {
  it('marks, label by label, the tenant\'s unmarked nodes written since the run started, and the run as failed', async () => {
    const log = vi.fn()
    await markLeftovers({} as never, 'demo', 'run-1', '2026-09-23T20:00:00.000Z', log)
    const marks = calls.filter((c) => c.cypher.includes('SET n.demo_run_id'))
    expect(marks.map((c) => /MATCH \(n:(\w+)/.exec(c.cypher)![1])).toEqual(['ServiceCatalogItem', 'FormField'])
    expect(marks[0]!.cypher).toContain('WHERE n.demo_run_id IS NULL AND n.created_at >= $since')
    expect(marks[0]!.params).toEqual({ tenantId: 'demo', since: '2026-09-23T20:00:00.000Z', runId: 'run-1' })
    expect(calls.at(-1)!.cypher).toContain("SET r.status = 'failed'")
    expect(log).toHaveBeenCalledWith(expect.stringContaining('6 nodes it had made through the product marked'))
  })

  it('a failure of the marking is said, never thrown over the error that stopped the run', async () => {
    failOn = 'SET n.demo_run_id'
    const log = vi.fn()
    await expect(markLeftovers({} as never, 'demo', 'run-1', '2026-09-23T20:00:00.000Z', log)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('marking what it had made FAILED too (neo4j down)'))
  })
})
