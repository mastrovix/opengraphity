/**
 * The backup's completeness check (tour of 23 Sep 2026, D60).
 *
 * A Neo4j read transaction is «read committed», not a snapshot: a write
 * committed by someone else while the export streams run is visible to them.
 * Comparing the lines written with the count taken at the start refused the
 * nightly backup on a live installation for one node more (18 Sep: 291,049
 * written, 291,048 counted). What must hold is that nothing was lost.
 */
import { describe, it, expect } from 'vitest'

const { graphCountProblems } = await import('../backup-neo4j.js')

const quiet = { nodeCount: 100, relCount: 50, dbNodeCount: 100, dbRelCount: 50, dbNodeCountAfter: 100, dbRelCountAfter: 50 }

describe('graphCountProblems', () => {
  it('a quiet graph: what was written is what was counted', () => {
    expect(graphCountProblems(quiet)).toEqual([])
  })

  it('writes during the export: anything between the count before and the count after is whole', () => {
    expect(graphCountProblems({ ...quiet, nodeCount: 101, dbNodeCountAfter: 101 })).toEqual([])
    expect(graphCountProblems({ ...quiet, nodeCount: 101, dbNodeCountAfter: 103, relCount: 51, dbRelCountAfter: 52 })).toEqual([])
    // deletions too
    expect(graphCountProblems({ ...quiet, nodeCount: 98, dbNodeCountAfter: 97 })).toEqual([])
  })

  it('a truncated stream is still refused, with both counts named', () => {
    expect(graphCountProblems({ ...quiet, nodeCount: 60 })).toEqual(['nodes: 60 written, 100 counted in the same transaction'])
    expect(graphCountProblems({ ...quiet, relCount: 10, dbRelCountAfter: 52 })).toEqual(['relationships: 10 written, between 50 and 52 counted in the same transaction'])
  })
})
