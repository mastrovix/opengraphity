/**
 * services/serviceImpact/sync.ts — the failure paths of a live map sync.
 *
 * A service map follows the CMDB by itself; when a write cannot be applied
 * exactly, the whole transaction must roll back and SAY so, never leave a map
 * half-synchronized that the health calculation then trusts:
 * - the node cap counts the components added by hand too, not only the proposal;
 * - a map that vanished, or whose version moved under us, is an error;
 * - a write that touched fewer CIs than planned (a CI vanished mid-write) rolls
 *   back instead of recording counts that are not true;
 * - a status outside the vocabulary is corruption, not "active";
 * - a failed re-evaluation after a change counts as a failed sync;
 * - decommissioned components are counted and logged, never silently removed;
 * - the periodic pass rejects a bad clock value and says when it hit its page cap.
 *
 * The diff itself is mocked (its rules live in serviceImpact config tests):
 * here the contract is what sync does with a given diff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { ...log, child: () => log } }))
vi.mock('../../middleware/metrics.js', () => ({
  workflowPurposeMissingTotal: { inc: vi.fn() },
  serviceMapSyncsTotal: { inc: vi.fn() },
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  serviceMapsStale: { set: vi.fn() }, eventsSuppressedTotal: { inc: vi.fn() },
}))
vi.mock('../serviceImpact/engine.js', () => ({ evaluateServiceMap: vi.fn() }))
vi.mock('../serviceImpact/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeServiceMapDiff: vi.fn(),
}))
vi.mock('../../jobs/serviceImpactWorker.js', () => ({
  enqueueServiceMapSync: vi.fn().mockResolvedValue(undefined),
  enqueueServiceMapEvaluation: vi.fn().mockResolvedValue(undefined),
}))
// The real paged pass, capped to one page so the "page cap reached" path is reachable.
vi.mock('../../lib/pagedPass.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/pagedPass.js')>()
  return { ...real, runPagedPass: (input: Parameters<typeof real.runPagedPass>[0]) => real.runPagedPass({ ...input, maxPages: 1, pageSize: 2 }) }
})

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { evaluateServiceMap } = await import('../serviceImpact/engine.js')
const { computeServiceMapDiff } = await import('../serviceImpact/config.js')
const { serviceMapSyncsTotal } = await import('../../middleware/metrics.js')
const { ServiceMapTooLargeError } = await import('../serviceImpact/build.js')
const { syncServiceMap, syncStaleOrOldMaps } = await import('../serviceImpact/sync.js')
const { SERVICE_MAP_MAX_NODES } = await import('../../lib/serviceVocabularies.js')

const NOW = '2026-09-22T10:00:00.000Z'
const tx = { run: vi.fn() }
const session = { close: vi.fn().mockResolvedValue(undefined), executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) }

const APPLY_RE = /SET m\.node_ids = includedIds/
const TOUCH_RE = /SET m\.synced_at = \$now\s+RETURN/
const SKIP_RE = /m\.stale_reason = 'over_limit'/

type Diff = Awaited<ReturnType<typeof computeServiceMapDiff>>
const addedNode = (ciId: string) => ({ ciId, level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-1' })
function diff(over: Partial<Diff> = {}): Diff {
  return {
    mapId: 'map-1', version: 3, status: 'active', updatedAt: null, maxDepth: 4, relationshipTypes: ['DEPENDS_ON'],
    added: [], removed: [], moved: [], excluded: [], totalProposed: 3, proposed: [], currentIds: [], missing: [],
    rules: {} as never, nodeCount: 3, ...over,
  } as Diff
}

/** runQueryOne answers by cypher: TOUCH, APPLY, SKIP rows. */
function rows(r: { touch?: unknown; apply?: unknown; skip?: unknown }) {
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (APPLY_RE.test(cypher)) return r.apply ?? null
    if (SKIP_RE.test(cypher)) return r.skip ?? null
    if (TOUCH_RE.test(cypher)) return r.touch ?? null
    return null
  }) as never)
}
const metricResults = () => vi.mocked(serviceMapSyncsTotal.inc).mock.calls.map((c) => (c[0] as { result: string }).result)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(computeServiceMapDiff).mockResolvedValue(diff())
})

describe('syncServiceMap — node cap', () => {
  it('counts the components added by hand: a proposal under the cap still skips when the RESULT would exceed it', async () => {
    // The map already holds the cap (manual components included); the proposal adds one more.
    vi.mocked(computeServiceMapDiff).mockResolvedValue(diff({ nodeCount: SERVICE_MAP_MAX_NODES, totalProposed: 10, added: [addedNode('srv-9')] as never }))
    rows({ skip: { version: 3, status: 'active', wasStale: false } })
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)
    expect(r).toMatchObject({ skipped: 'limit', changed: false, added: 0 })
    expect(r.note).toContain(String(SERVICE_MAP_MAX_NODES + 1))
    // Nothing was applied.
    expect(vi.mocked(runQueryOne).mock.calls.some((c) => APPLY_RE.test(String(c[1])))).toBe(false)
    expect(metricResults()).toEqual(['skipped_limit'])
  })

  it('a map that vanished while being marked over-limit is an error', async () => {
    vi.mocked(computeServiceMapDiff).mockRejectedValue(new ServiceMapTooLargeError('too many nodes'))
    rows({ skip: null })
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)).rejects.toThrow('ServiceMap map-1 vanished while synchronizing (tenant t1)')
    expect(metricResults()).toEqual(['error'])
    expect(session.close).toHaveBeenCalled()
  })
})

describe('syncServiceMap — nothing to apply', () => {
  it('a map that vanished before the touch is an error', async () => {
    rows({ touch: null })
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)).rejects.toThrow(/vanished while synchronizing/)
  })

  it('a status outside the vocabulary is corruption, not a default', async () => {
    rows({ touch: { version: 3, status: 'green' } })
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)).rejects.toThrow('ServiceMap map-1 status is "green"')
    expect(metricResults()).toEqual(['error'])
  })

  it('decommissioned components are counted and logged, never removed by the automatic sync', async () => {
    vi.mocked(computeServiceMapDiff).mockResolvedValue(diff({ removed: [{ ciId: 'old-1', node: null, reason: 'lifecycle' }] as never }))
    rows({ touch: { version: 3, status: 'active' } })
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)
    expect(r).toMatchObject({ changed: false, removed: 0, retired: 1 })
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ mapId: 'map-1', retired: 1 }), expect.stringContaining('decommissioned'))
    expect(metricResults()).toEqual(['unchanged'])
  })
})

describe('syncServiceMap — applying changes', () => {
  beforeEach(() => {
    vi.mocked(computeServiceMapDiff).mockResolvedValue(diff({ added: [addedNode('srv-9')] as never }))
  })

  it('a map whose version moved under the sync rolls back and says the next pass retries', async () => {
    rows({ apply: null })
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW))
      .rejects.toThrow('ServiceMap map-1 changed while synchronizing (expected version 3)')
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('a write that touched fewer CIs than planned rolls back instead of recording false counts', async () => {
    rows({ apply: { version: 4, status: 'active', added: 0, removed: 0, moved: 0 } })
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW))
      .rejects.toThrow('synchronized 0/1 additions, 0/0 removals, 0/0 moves')
    expect(metricResults()).toEqual(['error'])
  })

  it('a failed re-evaluation after a change fails the sync and counts as an error', async () => {
    rows({ apply: { version: 4, status: 'active', added: 1, removed: 0, moved: 0 } })
    vi.mocked(evaluateServiceMap).mockRejectedValue(new Error('engine down'))
    await expect(syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)).rejects.toThrow('engine down')
    expect(metricResults()).toEqual(['error'])
  })
})

describe('syncStaleOrOldMaps', () => {
  it('rejects a clock value that is not an ISO date before touching the graph', async () => {
    await expect(syncStaleOrOldMaps('t1', 'yesterday')).rejects.toThrow('syncStaleOrOldMaps: "yesterday" is not an ISO date')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('logs when the page cap is reached: the remaining maps wait for the next pass', async () => {
    // A full page (pageSize 2, one page max) means there may be more.
    vi.mocked(runQuery).mockResolvedValue([{ tenantId: 't1', id: 'map-a' }, { tenantId: 't2', id: 'map-b' }] as never)
    rows({ touch: { version: 1, status: 'active' } })
    const r = await syncStaleOrOldMaps('t1', NOW)
    expect(r).toMatchObject({ evaluated: 2, failed: 0, truncated: true })
    expect(log.warn).toHaveBeenCalledWith({ evaluated: 2 }, expect.stringContaining('page cap reached'))
    // Each map is synchronized inside its own tenant.
    expect(vi.mocked(computeServiceMapDiff).mock.calls.map((c) => [c[1], c[2]])).toEqual([['t1', 'map-a'], ['t2', 'map-b']])
  })
})
