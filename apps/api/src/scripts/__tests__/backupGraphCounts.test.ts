/**
 * The backup's completeness check (tour of 23 Sep 2026, D60).
 *
 * A Neo4j read transaction is «read committed», not a snapshot: a write
 * committed by someone else while the export streams run is visible to them.
 * Comparing the lines written with the count taken at the start refused the
 * nightly backup on a live installation for one node more (18 Sep: 291,049
 * written, 291,048 counted). What must hold is that nothing was lost.
 *
 * And «between the two counts» is not enough either (24 Sep 2026): a
 * relationship deleted before the stream reached it and another created
 * after the stream passed leave the archive one short of both counts, with
 * nothing lost. The range has a tolerance; a stream that lost a real part of
 * the graph is still refused.
 */
import { describe, it, expect } from 'vitest'

const { graphCountProblems, graphCountDrift, liveChangeTolerance, LIVE_CHANGE_TOLERANCE } = await import('../backup-neo4j.js')

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

  it('the night of 24 Sep 2026: one relationship short of both counts is a replacement, not a loss — published, and the drift is known', () => {
    const night = { nodeCount: 4_822_463, relCount: 4_978_496, dbNodeCount: 4_822_461, dbRelCount: 4_978_497, dbNodeCountAfter: 4_822_466, dbRelCountAfter: 4_978_499 }
    expect(graphCountProblems(night)).toEqual([])
    expect(graphCountDrift(night)).toEqual({ nodes: 0, rels: 1 })
  })

  it('the tolerance: a thousandth of the count, never less than 100', () => {
    expect(LIVE_CHANGE_TOLERANCE).toEqual({ ratio: 0.001, min: 100 })
    expect(liveChangeTolerance(4_978_497, 4_978_499)).toBe(4_979)
    expect(liveChangeTolerance(50, 52)).toBe(100)
  })

  it('a stream that lost a real part of the graph is still refused, with both counts and the tolerance named', () => {
    const big = { nodeCount: 1_000_000, relCount: 2_000_000, dbNodeCount: 1_000_000, dbRelCount: 2_000_000, dbNodeCountAfter: 1_000_000, dbRelCountAfter: 2_000_010 }
    expect(graphCountProblems({ ...big, nodeCount: 998_999 })).toEqual(['nodes: 998999 written, 1000000 counted in the same transaction (a live graph explains up to 1000)'])
    expect(graphCountProblems({ ...big, relCount: 1_990_000 })).toEqual(['relationships: 1990000 written, between 2000000 and 2000010 counted in the same transaction (a live graph explains up to 2001)'])
    expect(graphCountProblems({ ...big, nodeCount: 999_000 })).toEqual([])
    // Too many lines is refused the same way: a stream that repeated itself.
    expect(graphCountProblems({ ...quiet, nodeCount: 201 })).toEqual(['nodes: 201 written, 100 counted in the same transaction (a live graph explains up to 100)'])
  })
})
